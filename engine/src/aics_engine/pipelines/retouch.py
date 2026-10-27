"""Retoque de retrato determinista: piel (separación de frecuencias) + "looks" de color.

No genera píxeles nuevos: la identidad se conserva por construcción (y aun así la capa
de validación la mide).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageFilter

from .faces import Face


@dataclass(frozen=True)
class Look:
    contrast: float = 0.0  # curva en S (-1..1)
    saturation: float = 1.0
    warmth: float = 0.0  # -1 frío … 1 cálido
    fade: float = 0.0  # levanta negros (0..0.2)
    shadows_tint: tuple[float, float, float] = (0.0, 0.0, 0.0)
    highlights_tint: tuple[float, float, float] = (0.0, 0.0, 0.0)
    mono: bool = False


LOOKS: dict[str, Look] = {
    "natural": Look(contrast=0.08, saturation=1.03),
    "editorial": Look(contrast=0.22, saturation=0.92, fade=0.03, shadows_tint=(-0.01, 0.0, 0.02), highlights_tint=(0.02, 0.01, -0.01)),
    "moda_calida": Look(contrast=0.15, saturation=1.08, warmth=0.35, highlights_tint=(0.03, 0.015, -0.02)),
    "moda_fria": Look(contrast=0.18, saturation=0.95, warmth=-0.3, shadows_tint=(-0.01, 0.01, 0.03)),
    "bn_editorial": Look(contrast=0.3, mono=True, fade=0.02),
    "cine": Look(contrast=0.2, saturation=0.9, fade=0.05, shadows_tint=(-0.02, 0.02, 0.04), highlights_tint=(0.04, 0.02, -0.02)),
}


def skin_mask(image: Image.Image, faces: list[Face], body: bool = False) -> Image.Image:
    """Píxeles con tono de piel (YCbCr), limitados a la zona de los rostros salvo `body`."""
    ycc = np.asarray(image.convert("YCbCr"), dtype=np.float32)
    cb, cr = ycc[..., 1], ycc[..., 2]
    skin = (cr > 133) & (cr < 173) & (cb > 77) & (cb < 127) & (ycc[..., 0] > 40)
    if not body:
        region = np.zeros(skin.shape, dtype=bool)
        for f in faces:
            x, y, w, h = f.box
            x0, x1 = int(max(0, x - w * 0.35)), int(min(image.width, x + w * 1.35))
            y0, y1 = int(max(0, y - h * 0.45)), int(min(image.height, y + h * 1.9))  # incluye cuello
            region[y0:y1, x0:x1] = True
        skin &= region
    mask = Image.fromarray((skin * 255).astype(np.uint8), "L")
    r = max(2, min(image.size) // 150)
    return mask.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(r))


def smooth_skin(image: Image.Image, mask: Image.Image, amount: float, face_size: float) -> Image.Image:
    """Separación de frecuencias: suaviza la baja frecuencia y conserva parte de la textura fina."""
    if amount <= 0:
        return image
    rgb = np.asarray(image.convert("RGB"), dtype=np.float32)
    radius = max(1.5, face_size / 45)
    low = np.asarray(image.convert("RGB").filter(ImageFilter.GaussianBlur(radius)), dtype=np.float32)
    fine = rgb - np.asarray(image.convert("RGB").filter(ImageFilter.GaussianBlur(max(0.8, radius / 6))), dtype=np.float32)
    smoothed = low + fine * 0.65  # mantiene poros: nada de "piel de plástico"
    m = (np.asarray(mask, dtype=np.float32) / 255.0)[..., None] * min(1.0, amount)
    return Image.fromarray(np.clip(rgb * (1 - m) + smoothed * m, 0, 255).astype(np.uint8), "RGB")


def grade(image: Image.Image, look: Look, intensity: float = 1.0) -> Image.Image:
    x = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    original = x.copy()
    if look.mono:
        x = np.repeat((x @ np.array([0.299, 0.587, 0.114], dtype=np.float32))[..., None], 3, axis=-1)
    if look.saturation != 1.0:
        lum = (x @ np.array([0.299, 0.587, 0.114], dtype=np.float32))[..., None]
        x = lum + (x - lum) * look.saturation
    if look.warmth:
        x = x * np.array([1 + 0.06 * look.warmth, 1 + 0.01 * look.warmth, 1 - 0.07 * look.warmth], dtype=np.float32)
    if look.contrast:
        s = 1 / (1 + np.exp(-(x - 0.5) * 6))
        x = x + (s - x) * look.contrast
    lum = (x @ np.array([0.299, 0.587, 0.114], dtype=np.float32))[..., None]
    x = x + np.array(look.shadows_tint, dtype=np.float32) * (1 - lum) + np.array(look.highlights_tint, dtype=np.float32) * lum
    if look.fade:
        x = look.fade + x * (1 - look.fade)
    x = original + (np.clip(x, 0, 1) - original) * intensity
    return Image.fromarray((np.clip(x, 0, 1) * 255).round().astype(np.uint8), "RGB")


def vignette(image: Image.Image, amount: float) -> Image.Image:
    if amount <= 0:
        return image
    w, h = image.size
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    d = np.sqrt(((xx - w / 2) / (w / 2)) ** 2 + ((yy - h / 2) / (h / 2)) ** 2) / np.sqrt(2)
    factor = 1 - amount * np.clip(d - 0.35, 0, 1) ** 1.6
    x = np.asarray(image, dtype=np.float32) * factor[..., None]
    return Image.fromarray(np.clip(x, 0, 255).astype(np.uint8), "RGB")


def film_grain(image: Image.Image, amount: float, seed: int = 7) -> Image.Image:
    if amount <= 0:
        return image
    rng = np.random.default_rng(seed)
    x = np.asarray(image, dtype=np.float32)
    noise = rng.normal(0, 18 * amount, x.shape[:2])[..., None]
    return Image.fromarray(np.clip(x + noise, 0, 255).astype(np.uint8), "RGB")


def retouch(image: Image.Image, faces: list[Face], *, skin: float = 0.5, look: str = "natural", intensity: float = 1.0,
            vignette_amount: float = 0.0, grain: float = 0.0, body_skin: bool = False) -> Image.Image:
    alpha = image.getchannel("A") if image.mode == "RGBA" else None
    out = image.convert("RGB")
    if faces and skin > 0:
        face_size = max(f.box[2] for f in faces)
        out = smooth_skin(out, skin_mask(out, faces, body_skin), skin, face_size)
    out = grade(out, LOOKS.get(look, LOOKS["natural"]), intensity)
    out = vignette(out, vignette_amount)
    out = film_grain(out, grain)
    if alpha is not None:
        out = out.convert("RGBA")
        out.putalpha(alpha)
    return out
