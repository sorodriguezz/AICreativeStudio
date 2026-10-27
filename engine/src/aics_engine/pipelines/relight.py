"""Reiluminación 2.5D: profundidad (Depth Anything V2) → normales → luz direccional.

La misma fórmula de sombreado vive en `src/lib/relight.ts` para la vista previa en
vivo de la UI; si cambias una, cambia la otra.

Convenciones:
  - Mapa de normales RGB = (n * 0.5 + 0.5) * 255, con x → derecha, y → arriba, z → hacia el espectador.
  - Luz: azimut φ en grados (0 = desde la derecha, 90 = desde arriba), elevación θ (0 = rasante, 90 = frontal).
"""

from __future__ import annotations

import base64
import io
import math
from dataclasses import dataclass

import numpy as np
from PIL import Image


class DepthEstimator:
    MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

    def __init__(self, model_path: str, size: int = 518) -> None:
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.log_severity_level = 3
        self.session = ort.InferenceSession(model_path, sess_options=opts, providers=["CPUExecutionProvider"])
        self.input = self.session.get_inputs()[0].name
        self.size = size

    def depth(self, image: Image.Image) -> np.ndarray:
        """Profundidad relativa normalizada 0..1 (1 = más cerca), al tamaño de la imagen."""
        w, h = image.size
        scale = self.size / min(w, h)
        tw, th = max(14, round(w * scale / 14) * 14), max(14, round(h * scale / 14) * 14)
        x = np.asarray(image.convert("RGB").resize((tw, th), Image.BICUBIC), dtype=np.float32) / 255.0
        x = ((x - self.MEAN) / self.STD).transpose(2, 0, 1)[None]
        d = self.session.run(None, {self.input: x})[0][0]
        d = (d - d.min()) / max(1e-6, float(d.max() - d.min()))
        return np.asarray(Image.fromarray((d * 65535).astype(np.uint16)).resize((w, h), Image.BICUBIC), dtype=np.float32) / 65535.0


def _gaussian(a: np.ndarray, sigma: float) -> np.ndarray:
    """Desenfoque gaussiano separable en float (PIL no lo soporta en 16/32 bits)."""
    r = max(1, int(sigma * 3))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    pad = np.pad(a, r, mode="edge")
    a = np.apply_along_axis(lambda v: np.convolve(v, k, mode="valid"), 1, pad)
    return np.apply_along_axis(lambda v: np.convolve(v, k, mode="valid"), 0, a)


def normals_from_depth(depth: np.ndarray, relief: float = 0.6) -> np.ndarray:
    """Normales unitarias (H, W, 3) a partir del gradiente de la profundidad.

    El gradiente se mide en unidades de imagen (no de píxel) para que el volumen no
    dependa de la resolución.
    """
    blurred = _gaussian(depth.astype(np.float32), max(1.0, max(depth.shape) / 400))
    scale = relief * max(depth.shape)
    dzdx = np.gradient(blurred, axis=1) * scale
    dzdy = np.gradient(blurred, axis=0) * scale
    n = np.stack([-dzdx, dzdy, np.ones_like(blurred)], axis=-1)  # y de imagen hacia abajo → y de normal hacia arriba
    return n / np.linalg.norm(n, axis=-1, keepdims=True)


def encode_normals(n: np.ndarray) -> Image.Image:
    return Image.fromarray(((n * 0.5 + 0.5) * 255).round().clip(0, 255).astype(np.uint8), "RGB")


def kelvin_to_rgb(kelvin: float) -> tuple[float, float, float]:
    """Aproximación de Tanner Helland, normalizada a máx. 1."""
    t = kelvin / 100.0
    r = 255.0 if t <= 66 else 329.698727446 * ((t - 60) ** -0.1332047592)
    g = 99.4708025861 * math.log(t) - 161.1195681661 if t <= 66 else 288.1221695283 * ((t - 60) ** -0.0755148492)
    b = 255.0 if t >= 66 else (0.0 if t <= 19 else 138.5177312231 * math.log(t - 10) - 305.0447927307)
    rgb = [min(255.0, max(0.0, c)) for c in (r, g, b)]
    m = max(rgb)
    return (rgb[0] / m, rgb[1] / m, rgb[2] / m)


@dataclass
class Light:
    azimuth: float = 135.0  # desde arriba a la izquierda
    elevation: float = 35.0
    kelvin: float = 5200.0
    strength: float = 0.7  # cuánto domina la luz nueva sobre la original
    ambient: float = 0.35
    relief: float = 1.0  # exageración del volumen (escala xy de las normales)

    @classmethod
    def from_params(cls, p: dict) -> "Light":
        fields = {k: float(p[k]) for k in ("azimuth", "elevation", "kelvin", "strength", "ambient", "relief") if p.get(k) is not None}
        return cls(**fields)

    def direction(self) -> np.ndarray:
        az, el = math.radians(self.azimuth), math.radians(self.elevation)
        return np.array([math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)], dtype=np.float32)


GAIN = 1.25  # compensa el oscurecimiento medio del sombreado


def shade(image: Image.Image, normals: np.ndarray, light: Light) -> Image.Image:
    alpha = image.getchannel("A") if image.mode == "RGBA" else None
    rgb = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    n = normals.copy()
    n[..., :2] *= light.relief
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    lambert = np.clip(n @ light.direction(), 0.0, 1.0)[..., None]
    shading = light.ambient + (1.0 - light.ambient) * lambert
    color = np.array(kelvin_to_rgb(light.kelvin), dtype=np.float32)
    factor = (1.0 - light.strength) + light.strength * shading * color * GAIN
    out = Image.fromarray((np.clip(rgb * factor, 0, 1) * 255).round().astype(np.uint8), "RGB")
    if alpha is not None:
        out = out.convert("RGBA")
        out.putalpha(alpha)
    return out


def lighting_prompt(light: Light) -> str:
    """Descripción para el refinado opcional con difusión."""
    side = {0: "from the right", 1: "from the top right", 2: "from above", 3: "from the top left", 4: "from the left",
            5: "from the bottom left", 6: "from below", 7: "from the bottom right"}[round((light.azimuth % 360) / 45) % 8]
    tone = "warm golden" if light.kelvin < 4200 else "cool bluish" if light.kelvin > 6800 else "neutral"
    quality = "dramatic hard" if light.ambient < 0.25 else "soft"
    return f"{quality} {tone} light {side}, realistic lighting, natural shadows"


def to_b64_png(image: Image.Image) -> str:
    buf = io.BytesIO()
    image.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
