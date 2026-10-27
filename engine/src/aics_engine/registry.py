"""Model Registry: cada modelo declara qué tarea resuelve y dónde puede correr.

Agregar un modelo nuevo = agregar un ModelSpec aquí (y, si es una tarea nueva,
un pipeline en `pipelines/`). El resto del sistema (planner, UI, perfiles) lo
descubre a partir de esta declaración.
"""

from __future__ import annotations

import os
import queue
import threading
import time
from dataclasses import asdict, dataclass, field

ALL_PLATFORMS = ["macos-arm64", "windows-x64", "windows-arm64", "linux-x64"]


@dataclass(frozen=True)
class ModelSpec:
    id: str
    name: str
    tasks: tuple[str, ...]
    backend: str  # diffusers | planned
    repo_id: str | None = None
    variant: str | None = None
    license: str = ""
    size_gb: float = 0.0
    min_memory_gb: float = 0.0
    base_resolution: int = 512
    default_steps: int = 25
    default_guidance: float = 7.0
    profiles: tuple[str, ...] = ("full", "balanced", "compatible")
    platforms: tuple[str, ...] = tuple(ALL_PLATFORMS)
    allow_patterns: tuple[str, ...] | None = None
    # Descarga directa (releases oficiales) en vez de Hugging Face: (archivo, url).
    urls: tuple[tuple[str, str], ...] | None = None
    dev: bool = False  # sólo para pruebas: salida sin calidad
    optional: bool = False  # mejora opcional: sólo se usa si está instalado, nunca se sugiere por defecto
    notes: str = ""


_FP16_SAFETENSORS = ("*.json", "*.txt", "*fp16.safetensors", "tokenizer*/*", "scheduler/*")

CATALOG: list[ModelSpec] = [
    # --- Motores de difusión (generación y edición). El orden define la preferencia.
    ModelSpec(
        id="sdxl-inpaint",
        name="SDXL Inpainting 0.1",
        tasks=("inpainting",),
        backend="diffusers",
        repo_id="diffusers/stable-diffusion-xl-1.0-inpainting-0.1",
        variant="fp16",
        license="CreativeML Open RAIL++-M (uso comercial permitido)",
        size_gb=6.9,
        min_memory_gb=12,
        base_resolution=1024,
        default_steps=30,
        default_guidance=7.0,
        profiles=("full", "balanced"),
        allow_patterns=_FP16_SAFETENSORS,
        optional=True,
        notes="Opcional: rellenos y cambios de fondo más coherentes que con SDXL base.",
    ),
    ModelSpec(
        id="sdxl-base",
        name="Stable Diffusion XL 1.0",
        tasks=("text_to_image", "image_to_image", "inpainting"),
        backend="diffusers",
        repo_id="stabilityai/stable-diffusion-xl-base-1.0",
        variant="fp16",
        license="CreativeML Open RAIL++-M (uso comercial permitido)",
        size_gb=6.9,
        min_memory_gb=12,
        base_resolution=1024,
        default_steps=28,
        default_guidance=6.5,
        profiles=("full", "balanced"),
        allow_patterns=_FP16_SAFETENSORS,
        notes="Motor general: genera y edita (transformar, pintar zonas, cambiar fondos).",
    ),
    ModelSpec(
        id="sd15",
        name="Stable Diffusion 1.5",
        tasks=("text_to_image", "image_to_image", "inpainting"),
        backend="diffusers",
        repo_id="stable-diffusion-v1-5/stable-diffusion-v1-5",
        variant="fp16",
        license="CreativeML Open RAIL-M (uso comercial permitido)",
        size_gb=2.1,
        min_memory_gb=6,
        base_resolution=512,
        default_steps=25,
        default_guidance=7.5,
        allow_patterns=_FP16_SAFETENSORS,
        notes="Perfil Compatible: equipos limitados y Windows ARM64.",
    ),
    ModelSpec(
        id="tiny-test",
        name="Tiny SD (pruebas)",
        tasks=("text_to_image", "image_to_image", "inpainting"),
        backend="diffusers",
        repo_id="hf-internal-testing/tiny-stable-diffusion-torch",
        license="Apache-2.0",
        size_gb=0.01,
        base_resolution=64,
        default_steps=4,
        dev=True,
        notes="Modelo diminuto para verificar el pipeline de punta a punta. Produce ruido.",
    ),
    # --- Motores auxiliares (livianos).
    ModelSpec(
        id="birefnet-lite",
        name="BiRefNet Lite (recorte de sujetos)",
        tasks=("segmentation", "background_removal"),
        backend="onnx",
        repo_id="onnx-community/BiRefNet_lite-ONNX",
        license="MIT",
        size_gb=0.22,
        base_resolution=1024,
        allow_patterns=("onnx/model.onnx", "preprocessor_config.json", "config.json"),
        notes="Detecta el sujeto principal: quitar fondo, cambiar fondo, máscaras automáticas.",
    ),
    ModelSpec(
        id="realesrgan-x4",
        name="Real-ESRGAN ×4",
        tasks=("upscale",),
        backend="spandrel",
        repo_id="ai-forever/Real-ESRGAN",
        license="BSD-3-Clause",
        size_gb=0.07,
        allow_patterns=("RealESRGAN_x4.pth",),
        notes="Super-resolución ×2 / ×4 con recuperación de detalle.",
    ),
    ModelSpec(
        id="depth-anything-v2-small",
        name="Depth Anything V2 Small",
        tasks=("depth", "relight"),
        backend="onnx",
        repo_id="onnx-community/depth-anything-v2-small",
        license="Apache-2.0",
        size_gb=0.1,
        base_resolution=518,
        allow_patterns=("onnx/model.onnx", "preprocessor_config.json", "config.json"),
        notes="Estima el volumen de la escena para reiluminarla con luz direccional.",
    ),
    # --- Photo Studio (Fase 4). Todos con licencia comercial (MIT / Apache-2.0).
    ModelSpec(
        id="yunet",
        name="YuNet (detección de rostros)",
        tasks=("face_detection",),
        backend="onnx",
        repo_id="opencv/face_detection_yunet",
        license="MIT (OpenCV Zoo)",
        size_gb=0.001,
        allow_patterns=("face_detection_yunet_2023mar.onnx",),
        notes="Encuentra rostros y sus puntos clave: retoque, validación y referencias.",
    ),
    ModelSpec(
        id="sface",
        name="SFace (identidad facial)",
        tasks=("face_identity",),
        backend="onnx",
        repo_id="opencv/face_recognition_sface",
        license="Apache-2.0 (OpenCV Zoo)",
        size_gb=0.04,
        allow_patterns=("face_recognition_sface_2021dec.onnx",),
        notes="Mide cuánto se parece un rostro a las referencias de una persona.",
    ),
    ModelSpec(
        id="dwpose",
        name="DWPose (pose corporal y manos)",
        tasks=("pose_estimation",),
        backend="onnx",
        repo_id="yzd-v/DWPose",
        license="Apache-2.0",
        size_gb=0.13,
        allow_patterns=("dw-ll_ucoco_384.onnx",),
        notes="Extrae la pose de una foto para copiarla o editarla.",
    ),
    ModelSpec(
        id="controlnet-openpose-sdxl",
        name="ControlNet OpenPose SDXL",
        tasks=("pose_control",),
        backend="diffusers",
        repo_id="xinsir/controlnet-openpose-sdxl-1.0",
        license="Apache-2.0",
        size_gb=2.5,
        min_memory_gb=16,
        profiles=("full", "balanced"),
        allow_patterns=("config.json", "diffusion_pytorch_model.safetensors"),
        notes="Hace que la persona generada adopte la pose elegida.",
    ),
    ModelSpec(
        id="ip-adapter-face-sdxl",
        name="IP-Adapter Plus Face SDXL",
        tasks=("identity_preservation",),
        backend="diffusers",
        repo_id="h94/IP-Adapter",
        license="Apache-2.0",
        size_gb=4.2,
        min_memory_gb=16,
        profiles=("full", "balanced"),
        allow_patterns=("sdxl_models/ip-adapter-plus-face_sdxl_vit-h.safetensors", "sdxl_models/ip-adapter-plus_sdxl_vit-h.safetensors",
                        "models/image_encoder/config.json", "models/image_encoder/model.safetensors"),
        notes="Conserva rasgos faciales y apariencia de las referencias de una persona registrada.",
    ),
    # --- Restauración (Fase 5). Pesos oficiales, licencias Apache-2.0.
    ModelSpec(
        id="lama",
        name="LaMa (borrado y rayas)",
        tasks=("erase", "scratch_removal"),
        backend="onnx",
        repo_id="Carve/LaMa-ONNX",
        license="Apache-2.0",
        size_gb=0.21,
        allow_patterns=("lama_fp32.onnx",),
        notes="Borra objetos, rayas y manchas rellenando con el entorno, sin prompt.",
    ),
    ModelSpec(
        id="scunet",
        name="SCUNet (reducción de ruido)",
        tasks=("denoise",),
        backend="spandrel",
        urls=(("scunet_color_real_psnr.pth", "https://github.com/cszn/KAIR/releases/download/v1.0/scunet_color_real_psnr.pth"),),
        license="Apache-2.0",
        size_gb=0.07,
        notes="Quita ruido y grano de fotos reales conservando el detalle.",
    ),
    ModelSpec(
        id="gfpgan",
        name="GFPGAN v1.4 (restauración de rostros)",
        tasks=("face_restore",),
        backend="spandrel",
        urls=(("GFPGANv1.4.pth", "https://github.com/TencentARC/GFPGAN/releases/download/v1.3.0/GFPGANv1.4.pth"),),
        license="Apache-2.0",
        size_gb=0.35,
        notes="Recupera rostros borrosos o dañados; se mezcla con el original para no cambiar a la persona.",
    ),
    ModelSpec(
        id="ddcolor-tiny",
        name="DDColor (coloreado)",
        tasks=("colorize",),
        backend="spandrel",
        repo_id="piddnad/DDColor-models",
        license="Apache-2.0",
        size_gb=0.22,
        allow_patterns=("ddcolor_paper_tiny.pth",),
        notes="Colorea fotos en blanco y negro conservando la luminancia original.",
    ),
]

_BY_ID = {m.id: m for m in CATALOG}


def get(model_id: str) -> ModelSpec | None:
    return _BY_ID.get(model_id)


def executable_tasks() -> set[str]:
    return {t for m in CATALOG if m.backend != "planned" for t in m.tasks}


@dataclass
class ModelState:
    status: str = "not_installed"  # planned | not_installed | queued | downloading | installed | error
    error: str | None = None
    downloaded_bytes: int = 0
    total_bytes: int = 0


def direct_dir(spec: ModelSpec) -> str:
    base = os.environ.get("AICS_MODELS_DIR") or os.path.join(os.environ.get("HF_HOME", os.path.expanduser("~/.cache/huggingface")), "direct")
    return os.path.join(base, spec.id)


def model_files(spec: ModelSpec) -> str:
    """Carpeta local con los archivos del modelo (snapshot de HF o descarga directa)."""
    if spec.urls:
        return direct_dir(spec)
    from huggingface_hub import snapshot_download

    return snapshot_download(spec.repo_id, local_files_only=True, allow_patterns=list(spec.allow_patterns) if spec.allow_patterns else None)


def _download_direct(spec: ModelSpec) -> None:
    import shutil
    import urllib.request

    folder = direct_dir(spec)
    os.makedirs(folder, exist_ok=True)
    for name, url in spec.urls or ():
        target = os.path.join(folder, name)
        if os.path.exists(target):
            continue
        part = target + ".part"
        # Reanuda descargas interrumpidas (HTTP Range) en vez de empezar de cero.
        offset = os.path.getsize(part) if os.path.exists(part) else 0
        request = urllib.request.Request(url, headers={"Range": f"bytes={offset}-"} if offset else {})
        with urllib.request.urlopen(request, timeout=60) as resp:
            resumed = offset and resp.status == 206
            with open(part, "ab" if resumed else "wb") as out:
                shutil.copyfileobj(resp, out, length=1 << 20)
        os.replace(part, target)


def _dir_bytes(folder: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(folder):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def _repo_cache_bytes(repo_id: str) -> int:
    """Bytes ya escritos en la caché de HF para el repo (incluye archivos .incomplete)."""
    hub = os.path.join(os.environ.get("HF_HOME", os.path.expanduser("~/.cache/huggingface")), "hub")
    blobs = os.path.join(hub, "models--" + repo_id.replace("/", "--"), "blobs")
    total = 0
    try:
        with os.scandir(blobs) as it:
            for entry in it:
                try:
                    total += entry.stat().st_size
                except OSError:
                    pass
    except OSError:
        pass
    return total


TORCH_BACKENDS = ("diffusers", "spandrel")


def runtime_support(spec: ModelSpec) -> tuple[bool, str | None]:
    """¿Puede este equipo ejecutar el modelo? (sin PyTorch, sólo los modelos ONNX)."""
    if spec.backend in TORCH_BACKENDS:
        from . import hardware

        if not hardware.detect().torch_available:
            return False, "Requiere PyTorch, que no está disponible en este equipo."
    return True, None


def data_root() -> str:
    return os.environ.get("HF_HOME", os.path.expanduser("~/.cache/huggingface"))


def free_disk_bytes() -> int:
    import shutil

    path = data_root()
    os.makedirs(path, exist_ok=True)
    return shutil.disk_usage(path).free


class ModelStore:
    """Estado de los modelos y cola de descargas (de a una, para no saturar disco ni red)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state: dict[str, ModelState] = {}
        self._queue: "queue.Queue[str]" = queue.Queue()
        threading.Thread(target=self._worker, name="downloads", daemon=True).start()

    def _probe(self, spec: ModelSpec) -> ModelState:
        if spec.backend == "planned":
            return ModelState(status="planned")
        if spec.urls:
            ok = all(os.path.exists(os.path.join(direct_dir(spec), name)) for name, _ in spec.urls)
            return ModelState(status="installed" if ok else "not_installed")
        try:
            from huggingface_hub import snapshot_download

            snapshot_download(spec.repo_id, local_files_only=True, allow_patterns=list(spec.allow_patterns) if spec.allow_patterns else None)
            return ModelState(status="installed")
        except Exception:
            return ModelState(status="not_installed")

    def state(self, spec: ModelSpec) -> ModelState:
        with self._lock:
            current = self._state.get(spec.id)
            if current and current.status in ("queued", "downloading", "error"):
                return current
        probed = self._probe(spec)
        with self._lock:
            self._state[spec.id] = probed
        return probed

    def is_installed(self, spec: ModelSpec) -> bool:
        return self.state(spec).status == "installed"

    def download(self, spec: ModelSpec) -> None:
        self.enqueue([spec])

    def enqueue(self, specs: list[ModelSpec]) -> list[str]:
        """Encola descargas. Verifica antes que el equipo pueda usarlos y que haya espacio."""
        pending = [s for s in specs if s.backend != "planned" and self.state(s).status in ("not_installed", "error")]
        for s in pending:
            ok, reason = runtime_support(s)
            if not ok:
                raise ValueError(f"{s.name}: {reason}")
        needed = sum(int(s.size_gb * 1e9) for s in pending)
        free = free_disk_bytes()
        if needed and needed + int(2e9) > free:
            raise ValueError(f"No hay espacio suficiente: se necesitan {needed / 1e9:.1f} GB y quedan {free / 1e9:.1f} GB libres "
                             "(se reservan 2 GB de margen).")
        with self._lock:
            for s in pending:
                self._state[s.id] = ModelState(status="queued", total_bytes=int(s.size_gb * 1e9))
        for s in pending:
            self._queue.put(s.id)
        return [s.id for s in pending]

    def _worker(self) -> None:
        while True:
            spec = get(self._queue.get())
            with self._lock:
                st = self._state.get(spec.id)
                if not st or st.status != "queued":
                    continue
                st.status = "downloading"

            def measure(spec=spec) -> None:
                while True:
                    with self._lock:
                        st = self._state.get(spec.id)
                        if not st or st.status != "downloading":
                            return
                        done = _dir_bytes(direct_dir(spec)) if spec.urls else _repo_cache_bytes(spec.repo_id)
                        st.downloaded_bytes = min(done, int(st.total_bytes * 0.99))
                    time.sleep(1)

            threading.Thread(target=measure, daemon=True).start()
            try:
                if spec.urls:
                    _download_direct(spec)
                else:
                    from huggingface_hub import snapshot_download

                    snapshot_download(spec.repo_id, allow_patterns=list(spec.allow_patterns) if spec.allow_patterns else None)
                new = ModelState(status="installed")
            except Exception as exc:  # red, disco, permisos...
                new = ModelState(status="error", error=str(exc))
            with self._lock:
                self._state[spec.id] = new

    def delete(self, spec: ModelSpec) -> int:
        """Borra los archivos del modelo. Devuelve los bytes liberados."""
        import shutil

        if self.state(spec).status in ("queued", "downloading"):
            raise ValueError("Espera a que termine la descarga.")
        freed = 0
        if spec.urls:
            folder = direct_dir(spec)
            freed = _dir_bytes(folder)
            shutil.rmtree(folder, ignore_errors=True)
        elif spec.repo_id:
            from huggingface_hub import scan_cache_dir

            for repo in scan_cache_dir().repos:
                if repo.repo_id == spec.repo_id:
                    strategy = scan_cache_dir().delete_revisions(*[r.commit_hash for r in repo.revisions])
                    freed = strategy.expected_freed_size
                    strategy.execute()
        with self._lock:
            self._state.pop(spec.id, None)
        return freed

    def describe(self, spec: ModelSpec) -> dict:
        st = self.state(spec)
        supported, reason = runtime_support(spec)
        data = asdict(spec)
        data.update(status=st.status, error=st.error, downloaded_bytes=st.downloaded_bytes, total_bytes=st.total_bytes,
                    supported=supported, unsupported_reason=reason)
        return data


def describe_all(store: ModelStore) -> list[dict]:
    return [store.describe(m) for m in CATALOG]


@dataclass
class ModelChoice:
    spec: ModelSpec
    reason: str = ""
    alternatives: list[str] = field(default_factory=list)


def choose_model(task: str, profile: str, store: ModelStore, requested: str | None = None) -> ModelChoice | None:
    """Elige el mejor modelo instalado para la tarea y el perfil de hardware."""
    if requested:
        spec = get(requested)
        if spec and task in spec.tasks and spec.backend != "planned":
            return ModelChoice(spec, reason="elegido por el usuario")
        return None
    candidates = [m for m in CATALOG if task in m.tasks and m.backend != "planned" and not m.dev and runtime_support(m)[0]]
    preferred = [m for m in candidates if profile in m.profiles] or candidates
    for spec in preferred:
        if store.is_installed(spec):
            return ModelChoice(spec, reason=f"mejor modelo instalado para el perfil {profile}")
    # Ninguno instalado: sugerimos el primero que no sea una mejora opcional.
    suggestable = [m for m in preferred if not m.optional] or preferred
    return ModelChoice(suggestable[0], reason="no instalado", alternatives=[m.id for m in suggestable[1:]]) if suggestable else None


# ---------- Paquetes recomendados ----------

@dataclass(frozen=True)
class Pack:
    id: str
    name: str
    description: str
    models: dict[str, tuple[str, ...]]  # perfil → modelos ("*" = todos los perfiles)
    min_profile: str = "compatible"
    optional: bool = False


PROFILE_RANK = {"compatible": 0, "balanced": 1, "full": 2}

PACKS: list[Pack] = [
    Pack("essential", "Esencial", "Crear y editar imágenes, quitar fondos y ampliar.",
         {"full": ("sdxl-base", "birefnet-lite", "realesrgan-x4"), "balanced": ("sdxl-base", "birefnet-lite", "realesrgan-x4"),
          "compatible": ("sd15", "birefnet-lite", "realesrgan-x4")}),
    Pack("restore", "Restauración", "Fotos antiguas: rayas, ruido, rostros y coloreado; borrar objetos.",
         {"*": ("lama", "scunet", "gfpgan", "ddcolor-tiny", "yunet", "sface")}),
    Pack("light", "Reiluminar", "Cambiar la dirección y el color de la luz de una foto.", {"*": ("depth-anything-v2-small",)}),
    Pack("photo", "Photo Studio", "Retoque de retratos, sesiones con identidad y cambio de pose.",
         {"*": ("yunet", "sface", "dwpose", "sdxl-base", "ip-adapter-face-sdxl", "controlnet-openpose-sdxl")}, min_profile="balanced"),
    Pack("quality", "Calidad extra", "Rellenos y cambios de fondo más coherentes (opcional).", {"*": ("sdxl-inpaint",)},
         min_profile="balanced", optional=True),
]


def describe_packs(store: ModelStore) -> dict:
    from . import hardware

    hw = hardware.detect()
    out = []
    for pack in PACKS:
        ids = pack.models.get(hw.profile) or pack.models.get("*") or ()
        specs = [get(i) for i in ids if get(i)]
        usable = [s for s in specs if runtime_support(s)[0]]
        missing = [s for s in usable if not store.is_installed(s)]
        reason = None
        if PROFILE_RANK[hw.profile] < PROFILE_RANK[pack.min_profile]:
            reason = f"Pensado para equipos con más memoria (perfil {pack.min_profile} o superior)."
        elif not usable:
            reason = "Requiere PyTorch, que no está disponible en este equipo."
        elif len(usable) < len(specs):
            reason = "Algunas funciones de este paquete no están disponibles en este equipo."
        out.append({
            "id": pack.id, "name": pack.name, "description": pack.description, "optional": pack.optional,
            "models": [s.id for s in usable], "missing": [s.id for s in missing],
            "missing_bytes": int(sum(s.size_gb for s in missing) * 1e9), "installed": not missing and bool(usable),
            "available": bool(usable) and PROFILE_RANK[hw.profile] >= PROFILE_RANK[pack.min_profile],
            "recommended": not pack.optional and PROFILE_RANK[hw.profile] >= PROFILE_RANK[pack.min_profile] and pack.id in ("essential", "restore", "light"),
            "reason": reason,
        })
    return {"profile": hw.profile, "device": hw.device, "torch": hw.torch_available, "free_disk_bytes": free_disk_bytes(), "packs": out}
