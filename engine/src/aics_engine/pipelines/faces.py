"""Rostros: detección (YuNet), identidad (SFace) y capa de validación de resultados.

Se ejecuta con onnxruntime + numpy (sin OpenCV) para funcionar igual en macOS,
Windows x64 y Windows ARM64. Licencias: YuNet MIT, SFace Apache-2.0 (OpenCV Zoo).
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np
from PIL import Image

# Plantilla ArcFace de 5 puntos para el recorte alineado de 112×112.
ARCFACE_112 = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]], dtype=np.float32)

# Umbral de coseno de SFace para "misma persona" (valor de referencia de OpenCV).
SAME_PERSON = 0.363
HIGH_CONFIDENCE = 0.5


@dataclass
class Face:
    box: tuple[float, float, float, float]  # x, y, w, h en píxeles de la imagen
    landmarks: np.ndarray  # (5, 2): ojo der., ojo izq., nariz, comisura der., comisura izq.
    score: float

    def to_dict(self) -> dict:
        return {"box": [round(v, 1) for v in self.box], "landmarks": self.landmarks.round(1).tolist(), "score": round(self.score, 3)}


def _session(path: str):
    import onnxruntime as ort

    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    return ort.InferenceSession(path, sess_options=opts, providers=["CPUExecutionProvider"])


def _nms(boxes: np.ndarray, scores: np.ndarray, iou: float) -> list[int]:
    order = scores.argsort()[::-1]
    keep: list[int] = []
    while order.size:
        i = order[0]
        keep.append(int(i))
        x1 = np.maximum(boxes[i, 0], boxes[order[1:], 0])
        y1 = np.maximum(boxes[i, 1], boxes[order[1:], 1])
        x2 = np.minimum(boxes[i, 0] + boxes[i, 2], boxes[order[1:], 0] + boxes[order[1:], 2])
        y2 = np.minimum(boxes[i, 1] + boxes[i, 3], boxes[order[1:], 1] + boxes[order[1:], 3])
        inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
        union = boxes[i, 2] * boxes[i, 3] + boxes[order[1:], 2] * boxes[order[1:], 3] - inter
        order = order[1:][inter / np.maximum(union, 1e-6) < iou]
    return keep


class FaceDetector:
    """YuNet 2023mar. Entrada fija 640×640 BGR 0..255; salidas por escala 8/16/32."""

    SIZE = 640
    STRIDES = (8, 16, 32)

    def __init__(self, model_path: str) -> None:
        self.session = _session(model_path)
        self.input = self.session.get_inputs()[0].name
        self.names = [o.name for o in self.session.get_outputs()]

    def detect(self, image: Image.Image, threshold: float = 0.6) -> list[Face]:
        rgb = image.convert("RGB")
        scale = self.SIZE / max(rgb.size)
        resized = rgb.resize((max(1, round(rgb.width * scale)), max(1, round(rgb.height * scale))), Image.BILINEAR)
        canvas = np.zeros((self.SIZE, self.SIZE, 3), dtype=np.float32)
        canvas[: resized.height, : resized.width] = np.asarray(resized, dtype=np.float32)[..., ::-1]  # → BGR
        out = dict(zip(self.names, self.session.run(None, {self.input: canvas.transpose(2, 0, 1)[None]})))

        boxes, scores, kps = [], [], []
        for s in self.STRIDES:
            cols = self.SIZE // s
            cls, obj = out[f"cls_{s}"][0, :, 0], out[f"obj_{s}"][0, :, 0]
            score = np.sqrt(np.clip(cls, 0, 1) * np.clip(obj, 0, 1))
            idx = np.where(score >= threshold)[0]
            if not idx.size:
                continue
            r, c = (idx // cols).astype(np.float32), (idx % cols).astype(np.float32)
            b = out[f"bbox_{s}"][0, idx]
            cx, cy = (c + b[:, 0]) * s, (r + b[:, 1]) * s
            w, h = np.exp(b[:, 2]) * s, np.exp(b[:, 3]) * s
            boxes.append(np.stack([cx - w / 2, cy - h / 2, w, h], axis=1))
            k = out[f"kps_{s}"][0, idx].reshape(-1, 5, 2)
            kps.append(np.stack([(k[..., 0] + c[:, None]) * s, (k[..., 1] + r[:, None]) * s], axis=-1))
            scores.append(score[idx])
        if not boxes:
            return []
        boxes_a, scores_a, kps_a = np.concatenate(boxes), np.concatenate(scores), np.concatenate(kps)
        faces = []
        for i in _nms(boxes_a, scores_a, 0.3):
            faces.append(Face(box=tuple((boxes_a[i] / scale).tolist()), landmarks=kps_a[i] / scale, score=float(scores_a[i])))
        return sorted(faces, key=lambda f: f.box[2] * f.box[3], reverse=True)


def similarity_transform(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """Umeyama: matriz 2×3 (rotación + escala uniforme + traslación) que lleva src → dst."""
    mu_s, mu_d = src.mean(0), dst.mean(0)
    s_c, d_c = src - mu_s, dst - mu_d
    cov = d_c.T @ s_c / len(src)
    u, sig, vt = np.linalg.svd(cov)
    d = np.ones(2)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        d[-1] = -1
    rot = u @ np.diag(d) @ vt
    scale = (sig * d).sum() / s_c.var(0).sum()
    t = mu_d - scale * rot @ mu_s
    return np.hstack([scale * rot, t[:, None]])


def align_face(image: Image.Image, face: Face, size: int = 112) -> Image.Image:
    m = similarity_transform(face.landmarks.astype(np.float64), ARCFACE_112.astype(np.float64) * size / 112)
    inv = np.linalg.inv(np.vstack([m, [0, 0, 1]]))[:2]
    return image.convert("RGB").transform((size, size), Image.AFFINE, inv.flatten().tolist(), resample=Image.BILINEAR)


def face_crop(image: Image.Image, face: Face, margin: float = 1.8, size: int = 448) -> Image.Image:
    """Recorte cuadrado holgado (para el IP-Adapter de rostro)."""
    x, y, w, h = face.box
    side = max(w, h) * margin
    cx, cy = x + w / 2, y + h / 2.2
    box = (cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2)
    return image.convert("RGB").crop(tuple(round(v) for v in box)).resize((size, size), Image.LANCZOS)


class FaceIdentity:
    """SFace: descriptor de 128 dimensiones normalizado (entrada RGB 0..255, 112×112 alineada)."""

    def __init__(self, model_path: str) -> None:
        self.session = _session(model_path)
        self.input = self.session.get_inputs()[0].name

    def embed(self, aligned: Image.Image) -> np.ndarray:
        x = np.asarray(aligned.convert("RGB"), dtype=np.float32).transpose(2, 0, 1)[None]
        v = self.session.run(None, {self.input: x})[0][0]
        return v / max(1e-9, float(np.linalg.norm(v)))


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b) / max(1e-9, float(np.linalg.norm(a) * np.linalg.norm(b))))


def identity_label(score: float) -> str:
    return "alta" if score >= HIGH_CONFIDENCE else "media" if score >= SAME_PERSON else "baja"


# ---------- Validación ----------


@dataclass
class Validation:
    faces: int
    identity: float | None  # coseno contra las referencias (mejor coincidencia), si las hay
    identity_label: str | None
    sharpness: float  # varianza del laplaciano normalizada (0..1)
    clipped_shadows: float  # fracción de píxeles negros puros
    clipped_highlights: float
    warnings: list[str]

    def to_dict(self) -> dict:
        d = asdict(self)
        for k in ("identity", "sharpness", "clipped_shadows", "clipped_highlights"):
            if d[k] is not None:
                d[k] = round(d[k], 3)
        return d


def sharpness(image: Image.Image) -> float:
    g = np.asarray(image.convert("L").resize((512, round(512 * image.height / image.width)) if image.width > 512 else image.size), dtype=np.float32)
    lap = g[1:-1, :-2] + g[1:-1, 2:] + g[:-2, 1:-1] + g[2:, 1:-1] - 4 * g[1:-1, 1:-1]
    return float(min(1.0, lap.var() / 1500.0))


def validate(image: Image.Image, detector: FaceDetector | None, identity: FaceIdentity | None,
             references: list[np.ndarray] | None, expect_person: bool) -> Validation:
    warnings: list[str] = []
    faces = detector.detect(image) if detector else []
    ident = None
    if references and faces and identity:
        emb = identity.embed(align_face(image, faces[0]))
        ident = max(cosine(emb, r) for r in references)
        if ident < SAME_PERSON:
            warnings.append("La identidad no coincide lo suficiente con las referencias.")
    if expect_person and detector and not faces:
        warnings.append("No se detectó un rostro en el resultado.")
    if len(faces) > 1 and expect_person:
        warnings.append(f"Se detectaron {len(faces)} rostros; se esperaba uno.")
    gray = np.asarray(image.convert("L"), dtype=np.uint8)
    shadows, highlights = float((gray <= 2).mean()), float((gray >= 253).mean())
    sharp = sharpness(image)
    if sharp < 0.05:
        warnings.append("La imagen se ve poco nítida.")
    if highlights > 0.08:
        warnings.append("Hay zonas quemadas (blanco puro).")
    if shadows > 0.15:
        warnings.append("Hay sombras empastadas (negro puro).")
    return Validation(faces=len(faces), identity=ident, identity_label=identity_label(ident) if ident is not None else None,
                      sharpness=sharp, clipped_shadows=shadows, clipped_highlights=highlights, warnings=warnings)
