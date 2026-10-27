"""Pose: estimación con DWPose (RTMPose, 133 puntos) y esqueleto OpenPose para ControlNet.

Formato de intercambio con la UI (coordenadas normalizadas 0..1 sobre un lienzo):
    {"width": 768, "height": 1024,
     "body": [[x, y, conf] × 18],            # orden OpenPose
     "hands": [[[x, y, conf] × 21], [...]]}  # opcional: izquierda, derecha
"""

from __future__ import annotations

import colorsys

import numpy as np
from PIL import Image, ImageDraw

# COCO-17 → OpenPose-18 (el cuello es el punto medio de los hombros).
COCO_TO_OPENPOSE = [0, None, 6, 8, 10, 5, 7, 9, 12, 14, 16, 11, 13, 15, 2, 1, 4, 3]
LIMBS = [(1, 2), (1, 5), (2, 3), (3, 4), (5, 6), (6, 7), (1, 8), (8, 9), (9, 10), (1, 11), (11, 12), (12, 13), (1, 0), (0, 14), (14, 16), (0, 15), (15, 17)]
COLORS = [(255, 0, 0), (255, 85, 0), (255, 170, 0), (255, 255, 0), (170, 255, 0), (85, 255, 0), (0, 255, 0), (0, 255, 85), (0, 255, 170),
          (0, 255, 255), (0, 170, 255), (0, 85, 255), (0, 0, 255), (85, 0, 255), (170, 0, 255), (255, 0, 255), (255, 0, 170), (255, 0, 85)]
HAND_EDGES = [(0, 1), (1, 2), (2, 3), (3, 4), (0, 5), (5, 6), (6, 7), (7, 8), (0, 9), (9, 10), (10, 11), (11, 12),
              (0, 13), (13, 14), (14, 15), (15, 16), (0, 17), (17, 18), (18, 19), (19, 20)]


class PoseEstimator:
    W, H = 288, 384
    MEAN = np.array([123.675, 116.28, 103.53], dtype=np.float32)
    STD = np.array([58.395, 57.12, 57.375], dtype=np.float32)

    def __init__(self, model_path: str) -> None:
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.log_severity_level = 3
        self.session = ort.InferenceSession(model_path, sess_options=opts, providers=["CPUExecutionProvider"])
        self.input = self.session.get_inputs()[0].name

    def estimate(self, image: Image.Image, box: tuple[float, float, float, float] | None = None) -> np.ndarray:
        """133 × (x, y, score) en píxeles de la imagen. `box` = x, y, w, h de la persona."""
        x, y, w, h = box or (0, 0, image.width, image.height)
        cx, cy = x + w / 2, y + h / 2
        sw, sh = w * 1.25, h * 1.25
        if sw > sh * self.W / self.H:
            sh = sw * self.H / self.W
        else:
            sw = sh * self.W / self.H
        a, c = sw / self.W, cx - sw / 2
        e, f = sh / self.H, cy - sh / 2
        crop = image.convert("RGB").transform((self.W, self.H), Image.AFFINE, (a, 0, c, 0, e, f), resample=Image.BILINEAR)
        inp = ((np.asarray(crop, dtype=np.float32) - self.MEAN) / self.STD).transpose(2, 0, 1)[None]
        sx, sy = self.session.run(None, {self.input: inp})
        px, py = sx[0].argmax(-1) / 2.0, sy[0].argmax(-1) / 2.0
        score = np.minimum(sx[0].max(-1), sy[0].max(-1))
        return np.stack([px * a + c, py * e + f, score], axis=-1)


def to_openpose(kps: np.ndarray, width: int, height: int, threshold: float = 0.3) -> dict:
    def norm(p):
        return [round(float(p[0]) / width, 4), round(float(p[1]) / height, 4), round(float(p[2]), 3) if p[2] >= threshold else 0.0]

    body = []
    for coco in COCO_TO_OPENPOSE:
        if coco is None:
            l, r = kps[5], kps[6]
            body.append(norm(((l[0] + r[0]) / 2, (l[1] + r[1]) / 2, min(l[2], r[2]))))
        else:
            body.append(norm(kps[coco]))
    hands = [[norm(p) for p in kps[91:112]], [norm(p) for p in kps[112:133]]] if len(kps) >= 133 else []
    return {"width": width, "height": height, "body": body, "hands": hands}


def render(pose: dict, out_w: int, out_h: int) -> Image.Image:
    """Dibuja el esqueleto (estilo OpenPose) sobre negro, encajando el lienzo de la pose en out_w×out_h."""
    pw, ph = float(pose.get("width") or out_w), float(pose.get("height") or out_h)
    k = min(out_w / pw, out_h / ph)
    ox, oy = (out_w - pw * k) / 2, (out_h - ph * k) / 2
    to_px = lambda p: (ox + p[0] * pw * k, oy + p[1] * ph * k)  # noqa: E731

    canvas = Image.new("RGB", (out_w, out_h), (0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    stick = max(4, round(min(out_w, out_h) / 128))
    body = pose["body"]
    for i, (a, b) in enumerate(LIMBS):
        if body[a][2] <= 0 or body[b][2] <= 0:
            continue
        color = tuple(int(c * 0.6) for c in COLORS[i])
        draw.line([to_px(body[a]), to_px(body[b])], fill=color, width=stick * 2)
    for i, p in enumerate(body):
        if p[2] > 0:
            x, y = to_px(p)
            draw.ellipse([x - stick, y - stick, x + stick, y + stick], fill=COLORS[i])
    for hand in pose.get("hands") or []:
        for j, (a, b) in enumerate(HAND_EDGES):
            if hand[a][2] > 0 and hand[b][2] > 0:
                r, g, bl = colorsys.hsv_to_rgb(j / len(HAND_EDGES), 1.0, 1.0)
                draw.line([to_px(hand[a]), to_px(hand[b])], fill=(int(r * 255), int(g * 255), int(bl * 255)), width=max(2, stick // 2))
        for p in hand:
            if p[2] > 0:
                x, y = to_px(p)
                draw.ellipse([x - 2, y - 2, x + 2, y + 2], fill=(0, 0, 255))
    return canvas


def person_box(alpha: Image.Image | None, size: tuple[int, int]) -> tuple[float, float, float, float]:
    """Caja de la persona a partir de la máscara del sujeto (BiRefNet); toda la imagen si no hay."""
    if alpha is None:
        return (0, 0, size[0], size[1])
    a = np.asarray(alpha) > 128
    ys, xs = np.where(a)
    if not xs.size:
        return (0, 0, size[0], size[1])
    return (float(xs.min()), float(ys.min()), float(xs.max() - xs.min() + 1), float(ys.max() - ys.min() + 1))


def visible_ratio(pose: dict) -> float:
    return sum(1 for p in pose["body"] if p[2] > 0) / len(pose["body"])
