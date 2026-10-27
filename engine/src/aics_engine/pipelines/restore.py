"""Restauración: ruido (SCUNet), rostros (GFPGAN), rayas y borrado (LaMa), coloreado (DDColor).

Dos filosofías en `restore()`:
  - documental: mínima invención. Limpia daños, reduce ruido con suavidad y mezcla los
    rostros restaurados con el original a baja intensidad.
  - creativa: limpieza y embellecimiento más decididos (más denoise, rostros más nítidos, ampliación).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np
from PIL import Image, ImageFilter

from .faces import Face, FaceDetector
from .text_to_image import Cancelled

Progress = Callable[[float, str], None]

# Plantilla FFHQ de 5 puntos para rostros de 512×512 (la que usa GFPGAN).
FFHQ_512 = np.array([[192.98138, 239.94708], [318.90277, 240.1936], [256.63416, 314.01935], [201.26117, 371.41043], [313.08905, 371.15118]], dtype=np.float64)


def _to_tensor(img: Image.Image, device: str):
    import torch

    # Contiguo: algunas arquitecturas (GFPGAN) usan .view() y fallan con tensores transpuestos.
    arr = np.ascontiguousarray(np.asarray(img.convert("RGB"), dtype=np.float32).transpose(2, 0, 1)[None] / 255.0)
    return torch.from_numpy(arr).to(device)


def _to_image(t) -> Image.Image:
    return Image.fromarray((t.clamp(0, 1)[0].permute(1, 2, 0).float().cpu().numpy() * 255).round().astype(np.uint8), "RGB")


class SpandrelModel:
    """Carga cualquier arquitectura de spandrel (incluidas las extra, p. ej. DDColor)."""

    _extra_installed = False

    def __init__(self, path: str, device: str) -> None:
        import spandrel
        import torch

        if not SpandrelModel._extra_installed:
            import spandrel_extra_arches

            spandrel_extra_arches.install()
            SpandrelModel._extra_installed = True
        self.torch = torch
        self.device = device
        self.model = spandrel.ModelLoader().load_from_file(path).to(torch.device(device)).eval()

    def __call__(self, x):
        with self.torch.inference_mode():
            return self.model(x)


# ---------- Ruido ----------

def denoise(model: SpandrelModel, image: Image.Image, strength: float, on_progress: Progress, is_cancelled: Callable[[], bool],
            tile: int = 512, overlap: int = 48) -> Image.Image:
    """SCUNet por bloques con mezcla suave; `strength` mezcla con el original (0..1)."""
    rgb = image.convert("RGB")
    src = np.asarray(rgb, dtype=np.float32) / 255.0
    h, w, _ = src.shape
    out = np.zeros_like(src)
    weight = np.zeros((h, w, 1), dtype=np.float32)
    ramp = np.minimum(np.linspace(0, 1, tile, dtype=np.float32) * tile / max(1, overlap), 1.0)
    window = np.minimum(ramp, ramp[::-1])
    step = tile - overlap
    ys = list(range(0, max(h - overlap, 1), step)) if h > tile else [0]
    xs = list(range(0, max(w - overlap, 1), step)) if w > tile else [0]
    total, done = len(ys) * len(xs), 0
    for y in ys:
        for x in xs:
            if is_cancelled():
                raise Cancelled()
            y1, x1 = min(y + tile, h), min(x + tile, w)
            y0, x0 = max(0, y1 - tile), max(0, x1 - tile)
            patch = model(model.torch.from_numpy(src[y0:y1, x0:x1].transpose(2, 0, 1)[None].copy()).to(model.device))
            res = patch.clamp(0, 1)[0].permute(1, 2, 0).float().cpu().numpy()
            wy, wx = window[: y1 - y0] if h > tile else np.ones(y1 - y0, np.float32), window[: x1 - x0] if w > tile else np.ones(x1 - x0, np.float32)
            wmap = (wy[:, None] * wx[None, :])[..., None] + 1e-4
            out[y0:y1, x0:x1] += res * wmap
            weight[y0:y1, x0:x1] += wmap
            done += 1
            on_progress(done / total, f"Reduciendo ruido · bloque {done}/{total}")
    clean = out / np.maximum(weight, 1e-6)
    mixed = src * (1 - strength) + clean * strength
    return Image.fromarray((np.clip(mixed, 0, 1) * 255).round().astype(np.uint8), "RGB")


# ---------- Rostros ----------

def _similarity(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    from .faces import similarity_transform

    return similarity_transform(src, dst)


def _face_mask(size: int = 512) -> Image.Image:
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    d = np.sqrt(((xx - size / 2) / (size * 0.42)) ** 2 + ((yy - size * 0.53) / (size * 0.47)) ** 2)
    m = np.clip((1.0 - d) / 0.18, 0, 1)
    return Image.fromarray((m * 255).astype(np.uint8), "L")


def restore_faces(model: SpandrelModel, image: Image.Image, faces: list[Face], fidelity: float,
                  on_progress: Progress, min_size: int = 24) -> tuple[Image.Image, int]:
    """GFPGAN sobre cada rostro alineado y pegado de vuelta con máscara suave.

    `fidelity` (0..1): cuánto del rostro restaurado se usa; el resto es el original alineado,
    para no "cambiar" a la persona en fotos documentales.
    """
    out = image.convert("RGB").copy()
    mask = _face_mask()
    count = 0
    targets = [f for f in faces if min(f.box[2], f.box[3]) >= min_size]
    for i, face in enumerate(targets):
        m = _similarity(face.landmarks.astype(np.float64), FFHQ_512)
        inv = np.linalg.inv(np.vstack([m, [0, 0, 1]]))
        aligned = out.transform((512, 512), Image.AFFINE, inv[:2].flatten().tolist(), resample=Image.BICUBIC)
        restored = _to_image(model(_to_tensor(aligned, model.device)))
        blended = Image.blend(aligned, restored, fidelity)
        # De vuelta a la imagen. PIL pide la transformación salida → entrada, que aquí es `m` (imagen → rostro).
        coeffs = m.flatten().tolist()
        back = blended.transform(out.size, Image.AFFINE, coeffs, resample=Image.BICUBIC)
        back_mask = mask.transform(out.size, Image.AFFINE, coeffs, resample=Image.BILINEAR)
        out = Image.composite(back, out, back_mask)
        count += 1
        on_progress((i + 1) / max(1, len(targets)), f"Restaurando rostro {i + 1}/{len(targets)}")
    return out, count


# ---------- Rayas, polvo y borrado ----------

def detect_damage(image: Image.Image, sensitivity: float = 0.5, protect: list[Face] | None = None) -> Image.Image:
    """Rayas y motas, sin confundirlas con grano ni textura.

    1. Desenfoque gaussiano leve para atenuar el grano (una mediana borraría también las rayas finas).
    2. Top-hat / black-hat morfológico con umbral adaptativo al ruido propio de la foto (MAD).
    3. Componentes conexas: se conservan sólo rayas (largas y finas) y motas (pequeñas y aisladas).
    4. Un daño real contrasta fuerte con su entorno inmediato (emulsión perdida, polvo, pelos);
       pliegues y bordes suaves no. Se exige contraste alto, o contraste medio en un extremo tonal.
    5. En los rostros se protegen ojos, nariz y boca (brillos, fosas nasales y dientes se parecen a
       daños), no la cara entera: una raya que cruza la mejilla sí se borra.
    """
    from scipy import ndimage

    g = ndimage.gaussian_filter(np.asarray(image.convert("L"), dtype=np.float32), max(0.8, min(image.size) / 700))
    size = max(7, (min(image.size) // 120) | 1)
    tophat = g - ndimage.grey_opening(g, size=(size, size))
    blackhat = ndimage.grey_closing(g, size=(size, size)) - g
    response = np.maximum(tophat, blackhat)
    mad = float(np.median(np.abs(response - np.median(response)))) + 1e-3
    s = float(np.clip(sensitivity, 0, 1))
    threshold = max(18.0 - 8.0 * s, (7.0 - 3.0 * s) * mad * 1.4826)
    candidate = response > threshold
    # Sólo estructuras finas: se quitan las zonas anchas (brillos, bordes gruesos) para que una raya
    # que las toca no quede fundida con ellas en un mismo componente.
    max_speck = max(12, (min(image.size) // 120) ** 2 * 3)
    thick = ndimage.distance_transform_edt(candidate) > 2.5
    cores, n_cores = ndimage.label(thick)
    if n_cores:
        core_area = ndimage.sum_labels(thick, cores, index=np.arange(1, n_cores + 1))
        thick = np.concatenate([[False], core_area > max_speck / 4])[cores]  # los núcleos chicos son motas, no zonas
    candidate &= ~ndimage.binary_dilation(thick, iterations=3)

    labels, n = ndimage.label(candidate, structure=np.ones((3, 3)))
    if n == 0:
        return Image.new("L", image.size, 0)
    # Ancho local (2 × distancia al borde): no depende de la forma, así dos rayas cruzadas siguen siendo finas.
    width = ndimage.median(2 * ndimage.distance_transform_edt(candidate), labels, index=np.arange(1, n + 1))
    objects = ndimage.find_objects(labels)
    areas = ndimage.sum_labels(candidate, labels, index=np.arange(1, n + 1))
    features = np.zeros(candidate.shape, dtype=bool)  # ojos y boca
    yy, xx = np.mgrid[0:candidate.shape[0], 0:candidate.shape[1]]
    for f in protect or []:
        r = f.box[2] * 0.16
        for ex, ey in f.landmarks[:2]:
            features |= (xx - ex) ** 2 + (yy - ey) ** 2 <= r * r
        nx, ny = f.landmarks[2]
        features |= (xx - nx) ** 2 + (yy - ny) ** 2 <= (r * 1.1) ** 2
        (mx1, my1), (mx2, my2) = f.landmarks[3], f.landmarks[4]
        cx, cy, half = (mx1 + mx2) / 2, (my1 + my2) / 2, abs(mx2 - mx1) * 0.75 + r * 0.3
        features |= (np.abs(xx - cx) <= half) & (np.abs(yy - cy) <= r * 0.9)
    lo, hi = np.percentile(g, 15), np.percentile(g, 85)
    means = ndimage.mean(g, labels, index=np.arange(1, n + 1))
    strength = ndimage.mean(response, labels, index=np.arange(1, n + 1))

    min_len = max(18, min(image.size) // 25)
    scratch = np.zeros(n + 1, dtype=bool)
    speck = np.zeros(n + 1, dtype=bool)
    for i, sl in enumerate(objects, start=1):
        if sl is None:
            continue
        hgt, wid = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
        length = float(np.hypot(hgt, wid))
        thickness = float(width[i - 1])
        strong = strength[i - 1] >= 2.2 * threshold
        extreme = means[i - 1] >= hi or means[i - 1] <= lo
        # Largo y recto: geometría típica de una raya; ni el grano ni los pliegues la tienen.
        straight_line = False
        if length >= 2 * min_len and thickness <= 3.0:
            ys, xs = np.nonzero(labels[sl] == i)
            ev = np.linalg.eigvalsh(np.cov(np.vstack([ys, xs]).astype(np.float64)) + 1e-6 * np.eye(2))
            straight_line = float(np.sqrt(ev[0] / ev[1])) < 0.06
        if not (strong or straight_line or (extreme and strength[i - 1] >= 1.4 * threshold)):
            continue
        scratch[i] = length >= min_len and thickness <= 3.0 + 1.5 * s
        # Las motas sobre ojos y boca se parecen a brillos y dientes: ésas no se tocan.
        speck[i] = (not scratch[i] and areas[i - 1] <= max_speck and max(hgt, wid) <= 3 * np.sqrt(max_speck)
                    and not features[sl][labels[sl] == i].any())
    # Las motas sólo cuentan si están aisladas: en una zona densa son textura, no polvo.
    density = ndimage.uniform_filter(candidate.astype(np.float32), size=size * 3)
    mask = scratch[labels] | (speck[labels] & (density < 0.25))
    mask &= ~features  # ojos, nariz y boca nunca se rellenan automáticamente (GFPGAN se ocupa del rostro)
    return Image.fromarray((ndimage.binary_dilation(mask, iterations=2) * 255).astype(np.uint8), "L")


class Lama:
    SIZE = 512

    def __init__(self, model_path: str) -> None:
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.log_severity_level = 3
        self.session = ort.InferenceSession(model_path, sess_options=opts, providers=["CPUExecutionProvider"])

    def _run(self, img: Image.Image, mask: Image.Image) -> Image.Image:
        x = np.asarray(img.convert("RGB").resize((self.SIZE, self.SIZE), Image.BICUBIC), dtype=np.float32).transpose(2, 0, 1)[None] / 255.0
        m = (np.asarray(mask.convert("L").resize((self.SIZE, self.SIZE), Image.NEAREST), dtype=np.float32) > 127).astype(np.float32)[None, None]
        out = self.session.run(None, {"image": x, "mask": m})[0][0].transpose(1, 2, 0)
        return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGB").resize(img.size, Image.BICUBIC)

    def inpaint(self, image: Image.Image, mask: Image.Image, on_progress: Progress, is_cancelled: Callable[[], bool]) -> Image.Image:
        """Rellena la zona blanca de `mask`. Trabaja por ventanas alrededor de cada daño para conservar resolución."""
        rgb = image.convert("RGB")
        mask = mask.convert("L").resize(rgb.size)
        m = np.asarray(mask) > 127
        if not m.any():
            return rgb
        win = max(self.SIZE, min(1024, max(rgb.size) // 2))
        step = win - win // 4
        h, w = m.shape
        boxes = []
        for y in range(0, max(h - win // 4, 1), step):
            for x in range(0, max(w - win // 4, 1), step):
                y1, x1 = min(y + win, h), min(x + win, w)
                y0, x0 = max(0, y1 - win), max(0, x1 - win)
                if m[y0:y1, x0:x1].any():
                    boxes.append((x0, y0, x1, y1))
        out = rgb.copy()
        for i, box in enumerate(boxes):
            if is_cancelled():
                raise Cancelled()
            filled = self._run(out.crop(box), mask.crop(box))
            out.paste(filled, box[:2], mask.crop(box).filter(ImageFilter.GaussianBlur(1.5)))
            on_progress((i + 1) / len(boxes), f"Rellenando · zona {i + 1}/{len(boxes)}")
        return out


# ---------- Color ----------

def auto_tone(image: Image.Image, strength: float = 1.0) -> Image.Image:
    """Recupera contraste en fotos desvaídas (niveles por percentiles) sin cambiar el carácter."""
    x = np.asarray(image.convert("RGB"), dtype=np.float32)
    lo = np.percentile(x, 0.5, axis=(0, 1))
    hi = np.percentile(x, 99.5, axis=(0, 1))
    stretched = (x - lo) / np.maximum(hi - lo, 1) * 255
    out = x + (stretched - x) * strength
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGB")


def colorize(model: SpandrelModel, image: Image.Image, size: int = 512) -> Image.Image:
    """DDColor sobre la luminancia; el color se aplica sobre la luminancia original a resolución completa."""
    gray = image.convert("L")
    small = gray.resize((size, round(size * gray.height / gray.width)) if gray.width >= gray.height else (round(size * gray.width / gray.height), size), Image.BICUBIC)
    x = model.torch.from_numpy(np.asarray(small, dtype=np.float32)[None, None] / 255.0).to(model.device)
    colored = _to_image(model(x)).resize(image.size, Image.BICUBIC)
    lab_color = np.asarray(colored.convert("LAB"))
    lab_orig = np.asarray(image.convert("RGB").convert("LAB"))
    merged = np.dstack([lab_orig[..., 0], lab_color[..., 1], lab_color[..., 2]]).astype(np.uint8)
    return Image.fromarray(merged, "LAB").convert("RGB")


def is_monochrome(image: Image.Image) -> bool:
    """Blanco y negro o virado (sepia, cianotipo): el tinte es casi el mismo en toda la imagen."""
    x = np.asarray(image.convert("RGB").resize((128, 128)), dtype=np.float32)
    tint = x - x.mean(-1, keepdims=True)  # desviación de cada píxel respecto a su gris
    return float(tint.reshape(-1, 3).std(0).mean()) < 6.0


# ---------- Orquestación ----------

@dataclass
class RestoreOptions:
    mode: str = "documental"  # documental | creativo
    scratches: bool = True
    sensitivity: float = 0.5
    denoise: float = 0.6
    faces: bool = True
    fidelity: float | None = None  # por defecto según el modo
    colorize: bool = False
    tone: bool = True

    @classmethod
    def from_params(cls, p: dict) -> "RestoreOptions":
        o = cls(mode=p.get("restore_mode", "documental"))
        o.sensitivity = 0.35 if o.mode == "documental" else 0.6
        for key in ("scratches", "faces", "colorize", "tone"):
            if p.get(key) is not None:
                setattr(o, key, bool(p[key]))
        for key in ("sensitivity", "denoise", "fidelity"):
            if p.get(key) is not None:
                setattr(o, key, float(p[key]))
        return o

    def face_fidelity(self) -> float:
        return self.fidelity if self.fidelity is not None else (0.5 if self.mode == "documental" else 0.85)

    def denoise_strength(self) -> float:
        return self.denoise * (0.7 if self.mode == "documental" else 1.0)
