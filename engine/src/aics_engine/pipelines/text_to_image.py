"""Pipeline text-to-image (motor de generación)."""

from __future__ import annotations

import random
from pathlib import Path
from typing import Callable

from ..registry import ModelSpec

ASPECTS = {"1:1": (1, 1), "16:9": (16, 9), "9:16": (9, 16), "4:3": (4, 3), "3:4": (3, 4), "3:2": (3, 2), "2:3": (2, 3), "4:5": (4, 5)}


class Cancelled(Exception):
    pass


def resolve_size(aspect: str | None, base: int, max_side: int, width: int | None = None, height: int | None = None) -> tuple[int, int]:
    """Calcula un tamaño con el mismo nº de píxeles que base², múltiplo de 64."""
    if width and height:
        w, h = width, height
    else:
        aw, ah = ASPECTS.get(aspect or "1:1", (1, 1))
        area = base * base
        w = (area * aw / ah) ** 0.5
        h = w * ah / aw
    scale = min(1.0, max_side / max(w, h))
    snap = lambda v: max(64, int(round(v * scale / 64)) * 64)  # noqa: E731
    return snap(w), snap(h)


def run(
    pipe,
    spec: ModelSpec,
    *,
    prompt: str,
    negative_prompt: str,
    width: int,
    height: int,
    steps: int,
    guidance: float,
    seed: int | None,
    count: int,
    output_dir: Path,
    job_id: str,
    on_progress: Callable[[float, str], None],
    is_cancelled: Callable[[], bool],
) -> list[dict]:
    import torch

    output_dir.mkdir(parents=True, exist_ok=True)
    base_seed = seed if seed is not None else random.randint(0, 2**31 - 1)
    total = steps * count
    outputs: list[dict] = []

    for i in range(count):
        current_seed = base_seed + i

        def callback(p, step: int, _timestep, kwargs):
            if is_cancelled():
                p._interrupt = True
            on_progress((i * steps + step + 1) / total, f"Imagen {i + 1}/{count} · paso {step + 1}/{steps}")
            return kwargs

        generator = torch.Generator(device="cpu").manual_seed(current_seed)
        result = pipe(
            prompt=prompt,
            negative_prompt=negative_prompt or None,
            width=width,
            height=height,
            num_inference_steps=steps,
            guidance_scale=guidance,
            generator=generator,
            callback_on_step_end=callback,
        )
        if is_cancelled():
            raise Cancelled()
        image = result.images[0]
        path = output_dir / f"{job_id}_{i + 1}.png"
        image.save(path)
        outputs.append({"path": str(path), "width": image.width, "height": image.height, "seed": current_seed, "model_id": spec.id})
    return outputs
