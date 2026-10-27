"""Pipelines de edición: img2img, inpainting, recorte de sujeto, cambio de fondo y super-resolución.

Principio: lo que el usuario no pidió cambiar se conserva. Inpainting y cambio de
fondo se generan a resolución de trabajo y luego se recomponen sobre el original a
su resolución completa, de modo que los píxeles fuera de la máscara quedan intactos.
"""

from __future__ import annotations

import math
import random
from pathlib import Path
from typing import Callable

import numpy as np
from PIL import Image, ImageFilter

from .text_to_image import Cancelled

Progress = Callable[[float, str], None]
IsCancelled = Callable[[], bool]


def working_size(width: int, height: int, base: int, max_side: int) -> tuple[int, int]:
    """Tamaño de trabajo con ~base² píxeles, misma proporción, múltiplo de 64."""
    ratio = width / height
    w = math.sqrt(base * base * ratio)
    h = w / ratio
    scale = min(1.0, max_side / max(w, h))
    snap = lambda v: max(64, int(round(v * scale / 64)) * 64)  # noqa: E731
    return snap(w), snap(h)


def _feather(mask: Image.Image, grow: int, blur: float) -> Image.Image:
    if grow > 0:
        mask = mask.filter(ImageFilter.MaxFilter(grow * 2 + 1))
    if blur > 0:
        mask = mask.filter(ImageFilter.GaussianBlur(blur))
    return mask


def _diffuse(pipe, *, image: Image.Image, mask: Image.Image | None, prompt: str, negative_prompt: str, size: tuple[int, int],
             steps: int, guidance: float, strength: float, seed: int, label: str, on_progress: Progress,
             is_cancelled: IsCancelled, base_progress: float, span: float):
    import torch

    real_steps = max(1, int(steps * strength))

    def callback(p, step: int, _t, kwargs):
        if is_cancelled():
            p._interrupt = True
        on_progress(base_progress + span * (step + 1) / real_steps, f"{label} · paso {step + 1}/{real_steps}")
        return kwargs

    kwargs = dict(prompt=prompt, negative_prompt=negative_prompt or None, image=image.resize(size, Image.LANCZOS),
                  num_inference_steps=steps, guidance_scale=guidance, strength=strength,
                  generator=torch.Generator(device="cpu").manual_seed(seed), callback_on_step_end=callback)
    if mask is not None:
        kwargs.update(mask_image=mask.resize(size, Image.LANCZOS), width=size[0], height=size[1])
    result = pipe(**kwargs).images[0]
    if is_cancelled():
        raise Cancelled()
    return result


def image_to_image(pipe, image: Image.Image, *, count: int, seed: int | None, size: tuple[int, int], **kw) -> list[tuple[Image.Image, int]]:
    base_seed = seed if seed is not None else random.randint(0, 2**31 - 1)
    out = []
    for i in range(count):
        img = _diffuse(pipe, image=image, mask=None, size=size, seed=base_seed + i, label=f"Imagen {i + 1}/{count}",
                       base_progress=i / count, span=1 / count, **kw)
        out.append((img, base_seed + i))
    return out


def inpaint(pipe, image: Image.Image, mask: Image.Image, *, count: int, seed: int | None, size: tuple[int, int],
            strength: float = 1.0, keep_alpha: Image.Image | None = None, progress_offset: float = 0.0,
            progress_span: float = 1.0, **kw) -> list[tuple[Image.Image, int]]:
    """Repinta la zona blanca de `mask` y recompone sobre el original a resolución completa.

    `keep_alpha` (opcional): opacidad del sujeto a preservar encima del resultado (cambio de fondo).
    """
    base_seed = seed if seed is not None else random.randint(0, 2**31 - 1)
    mask = mask.convert("L").resize(image.size, Image.LANCZOS)
    blend = _feather(mask, grow=max(2, image.width // 300), blur=max(2, image.width / 250))
    out = []
    for i in range(count):
        gen = _diffuse(pipe, image=image, mask=_feather(mask, grow=4, blur=0), size=size, seed=base_seed + i, strength=strength,
                       label=f"Imagen {i + 1}/{count}", base_progress=progress_offset + progress_span * i / count,
                       span=progress_span / count, **kw)
        gen = gen.resize(image.size, Image.LANCZOS)
        result = Image.composite(gen, image, blend)
        if keep_alpha is not None:
            result = Image.composite(image, result, keep_alpha)
        out.append((result, base_seed + i))
    return out


class Segmenter:
    """BiRefNet (ONNX) → opacidad del sujeto principal."""

    MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

    def __init__(self, model_path: str, size: int = 1024) -> None:
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.log_severity_level = 3
        self.session = ort.InferenceSession(model_path, sess_options=opts, providers=["CPUExecutionProvider"])
        self.input = self.session.get_inputs()[0].name
        self.size = size

    def alpha(self, image: Image.Image) -> Image.Image:
        x = np.asarray(image.convert("RGB").resize((self.size, self.size), Image.BILINEAR), dtype=np.float32) / 255.0
        x = ((x - self.MEAN) / self.STD).transpose(2, 0, 1)[None]
        logits = self.session.run(None, {self.input: x})[-1][0, 0]
        prob = 1.0 / (1.0 + np.exp(-logits))
        mask = Image.fromarray((prob * 255).clip(0, 255).astype(np.uint8), "L")
        return mask.resize(image.size, Image.LANCZOS)


def remove_background(segmenter: Segmenter, image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    rgba.putalpha(segmenter.alpha(image))
    return rgba


class Upscaler:
    """Real-ESRGAN vía spandrel, por bloques para no agotar la memoria."""

    def __init__(self, weights_path: str, device: str) -> None:
        import spandrel
        import torch

        self.torch = torch
        self.device = device
        self.model = spandrel.ModelLoader().load_from_file(weights_path).to(torch.device(device)).eval()
        self.scale = self.model.scale

    def upscale(self, image: Image.Image, factor: float, on_progress: Progress, is_cancelled: IsCancelled,
                tile: int = 384, overlap: int = 24, max_side: int = 8192) -> Image.Image:
        torch = self.torch
        has_alpha = image.mode == "RGBA"
        alpha = image.getchannel("A") if has_alpha else None
        rgb = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
        h, w, _ = rgb.shape
        s = self.scale
        out = np.zeros((h * s, w * s, 3), dtype=np.float32)
        weight = np.zeros((h * s, w * s, 1), dtype=np.float32)
        step = tile - overlap
        ys = list(range(0, max(h - overlap, 1), step))
        xs = list(range(0, max(w - overlap, 1), step))
        total = len(ys) * len(xs)
        done = 0
        with torch.inference_mode():
            for y in ys:
                for x in xs:
                    if is_cancelled():
                        raise Cancelled()
                    y1, x1 = min(y + tile, h), min(x + tile, w)
                    y0, x0 = max(0, y1 - tile), max(0, x1 - tile)
                    patch = torch.from_numpy(rgb[y0:y1, x0:x1].transpose(2, 0, 1)[None].copy()).to(self.device)
                    res = self.model(patch).clamp(0, 1)[0].permute(1, 2, 0).float().cpu().numpy()
                    out[y0 * s:y1 * s, x0 * s:x1 * s] += res
                    weight[y0 * s:y1 * s, x0 * s:x1 * s] += 1.0
                    done += 1
                    on_progress(done / total, f"Ampliando · bloque {done}/{total}")
        result = Image.fromarray((out / np.maximum(weight, 1e-6) * 255).round().clip(0, 255).astype(np.uint8), "RGB")
        target = (round(w * factor), round(h * factor))
        if max(target) > max_side:
            k = max_side / max(target)
            target = (round(target[0] * k), round(target[1] * k))
        if result.size != target:
            result = result.resize(target, Image.LANCZOS)
        if alpha is not None:
            result = result.convert("RGBA")
            result.putalpha(alpha.resize(target, Image.LANCZOS))
        return result


def outpaint_canvas(image: Image.Image, left: float, right: float, top: float, bottom: float, overlap: int = 24) -> tuple[Image.Image, Image.Image, tuple[int, int]]:
    """Lienzo ampliado (fracciones del tamaño original por lado), con relleno inicial y máscara.

    El relleno inicial estira los bordes y los difumina: le da a la difusión colores y luz
    coherentes de partida. La máscara cubre lo nuevo más una franja de solape que se funde.
    """
    w, h = image.size
    pl, pr, pt, pb = (round(w * left), round(w * right), round(h * top), round(h * bottom))
    arr = np.asarray(image.convert("RGB"))
    padded = np.pad(arr, ((pt, pb), (pl, pr), (0, 0)), mode="edge")
    init = Image.fromarray(padded).filter(ImageFilter.GaussianBlur(max(8, max(w, h) / 40)))
    init.paste(image.convert("RGB"), (pl, pt))
    mask = Image.new("L", init.size, 255)
    inner = (pl + (overlap if pl else 0), pt + (overlap if pt else 0), pl + w - (overlap if pr else 0), pt + h - (overlap if pb else 0))
    mask.paste(0, inner)
    return init, mask, (pl, pt)


def outpaint(pipe, image: Image.Image, *, left: float, right: float, top: float, bottom: float, count: int, seed: int | None,
             base: int, max_side: int, **kw) -> list[tuple[Image.Image, int]]:
    canvas, mask, offset = outpaint_canvas(image, left, right, top, bottom)
    size = working_size(canvas.width, canvas.height, base, max_side)
    results = inpaint(pipe, canvas, mask, count=count, seed=seed, size=size, strength=1.0, **kw)
    # El original vuelve intacto (salvo la franja de solape, ya fundida por la máscara suave).
    keep = Image.new("L", canvas.size, 0)
    keep.paste(255, (offset[0] + 24, offset[1] + 24, offset[0] + image.width - 24, offset[1] + image.height - 24))
    keep = keep.filter(ImageFilter.GaussianBlur(10))
    original = _place(image, canvas.size, offset)
    return [(Image.composite(original, result, keep), s) for result, s in results]


def _place(image: Image.Image, size: tuple[int, int], offset: tuple[int, int]) -> Image.Image:
    base = Image.new("RGB", size)
    base.paste(image.convert("RGB"), offset)
    return base


def save(image: Image.Image, output_dir: Path, name: str) -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"{name}.png"
    image.save(path)
    return {"path": str(path), "width": image.width, "height": image.height}
