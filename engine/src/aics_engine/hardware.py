"""Detección de hardware y perfil de ejecución (Full / Balanced / Compatible)."""

from __future__ import annotations

import platform
from dataclasses import asdict, dataclass, field
from functools import lru_cache

import psutil

PROFILE_DEFAULTS = {
    # max_side: lado máximo de salida; steps_scale: multiplicador de pasos; max_batch: imágenes por job
    "full": {"max_side": 1536, "steps_scale": 1.0, "max_batch": 8},
    "balanced": {"max_side": 1024, "steps_scale": 0.8, "max_batch": 4},
    "compatible": {"max_side": 640, "steps_scale": 0.6, "max_batch": 1},
}


@dataclass
class HardwareInfo:
    platform: str
    arch: str
    device: str  # cuda | mps | cpu
    device_name: str
    total_memory_gb: float
    accelerator_memory_gb: float | None
    torch_available: bool
    profile: str
    defaults: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


def _platform_id() -> tuple[str, str]:
    system = platform.system().lower()
    machine = platform.machine().lower()
    arch = "arm64" if machine in ("arm64", "aarch64") else "x64" if machine in ("x86_64", "amd64") else machine
    name = {"darwin": "macos", "windows": "windows", "linux": "linux"}.get(system, system)
    return name, arch


def pick_profile(device: str, total_gb: float, accel_gb: float | None) -> str:
    if device == "cuda" and (accel_gb or 0) >= 12:
        return "full"
    if device == "cuda" and (accel_gb or 0) >= 6:
        return "balanced"
    if device == "mps" and total_gb >= 32:
        return "full"
    if device == "mps" and total_gb >= 16:
        return "balanced"
    return "compatible"


@lru_cache(maxsize=1)
def detect() -> HardwareInfo:
    plat, arch = _platform_id()
    total_gb = round(psutil.virtual_memory().total / 1024**3, 1)
    device, device_name, accel_gb, torch_ok = "cpu", platform.processor() or arch, None, False
    try:
        import torch

        torch_ok = True
        if torch.cuda.is_available():
            device = "cuda"
            props = torch.cuda.get_device_properties(0)
            device_name = props.name
            accel_gb = round(props.total_memory / 1024**3, 1)
        elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            device = "mps"
            device_name = "Apple Silicon (Metal)"
            accel_gb = total_gb  # memoria unificada
    except Exception:  # torch ausente o roto: seguimos en CPU
        pass

    profile = pick_profile(device, total_gb, accel_gb)
    return HardwareInfo(
        platform=plat,
        arch=arch,
        device=device,
        device_name=device_name,
        total_memory_gb=total_gb,
        accelerator_memory_gb=accel_gb,
        torch_available=torch_ok,
        profile=profile,
        defaults=PROFILE_DEFAULTS[profile],
    )
