"""Generación guiada por identidad (IP-Adapter Plus Face SDXL) y, opcionalmente, por pose (ControlNet OpenPose).

Usa sólo modelos con licencia comercial (Apache-2.0). La fidelidad no está garantizada:
cada resultado pasa por la capa de validación y se ordena por similitud facial.
"""

from __future__ import annotations

import random
from typing import Callable

from PIL import Image

from .text_to_image import Cancelled

IP_REPO = "h94/IP-Adapter"
IP_WEIGHTS = {"plus": "ip-adapter-plus_sdxl_vit-h.safetensors", "face": "ip-adapter-plus-face_sdxl_vit-h.safetensors"}
IMAGE_ENCODER = "models/image_encoder"

NEGATIVE = ("deformed face, distorted face, extra fingers, mutated hands, bad anatomy, extra limbs, disfigured, "
            "blurry, lowres, watermark, text, cartoon, 3d render")


def generate(pipe, *, prompt: str, negative_prompt: str, face_images: list[Image.Image], appearance: Image.Image | None,
             control: Image.Image | None, size: tuple[int, int], steps: int, guidance: float, count: int, seed: int | None,
             identity_scale: float, control_scale: float, on_progress: Callable[[float, str], None],
             is_cancelled: Callable[[], bool]) -> list[tuple[Image.Image, int]]:
    import torch

    base_seed = seed if seed is not None else random.randint(0, 2**31 - 1)
    # Orden de adaptadores cargados: [apariencia (plus), rostro (face)].
    ip_images = [[appearance] if appearance is not None else [face_images[0]], face_images]
    pipe.set_ip_adapter_scale([0.35 * identity_scale if appearance is not None else 0.0, identity_scale])
    out = []
    for i in range(count):
        def callback(p, step: int, _t, kwargs, i=i):
            if is_cancelled():
                p._interrupt = True
            on_progress((i * steps + step + 1) / (steps * count), f"Imagen {i + 1}/{count} · paso {step + 1}/{steps}")
            return kwargs

        kwargs = dict(prompt=prompt, negative_prompt=", ".join(x for x in (negative_prompt, NEGATIVE) if x),
                      ip_adapter_image=ip_images, width=size[0], height=size[1], num_inference_steps=steps,
                      guidance_scale=guidance, generator=torch.Generator(device="cpu").manual_seed(base_seed + i),
                      callback_on_step_end=callback)
        if control is not None:
            kwargs.update(image=control.resize(size, Image.BILINEAR), controlnet_conditioning_scale=control_scale)
        image = pipe(**kwargs).images[0]
        if is_cancelled():
            raise Cancelled()
        out.append((image, base_seed + i))
    return out
