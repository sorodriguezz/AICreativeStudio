"""AI Runtime: carga y cachea pipelines según dispositivo (CUDA / MPS / CPU).

Un solo modelo de difusión residente a la vez (memoria unificada de 16 GB): las
variantes img2img e inpainting se derivan del mismo modelo con `from_pipe`, que
comparte los pesos en lugar de duplicarlos. Los motores auxiliares (recorte,
super-resolución) son pequeños y se mantienen aparte.
"""

from __future__ import annotations

import gc
import os
import threading

from . import hardware
from .registry import ModelSpec


def _snapshot(spec: ModelSpec) -> str:
    from .registry import model_files

    return model_files(spec)


class Runtime:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._spec_id: str | None = None
        self._pipes: dict[str, object] = {}
        self._aux: dict[str, object] = {}
        self._ip_loaded = False

    def _device_dtype(self):
        import torch

        hw = hardware.detect()
        if hw.device == "cuda":
            return "cuda", torch.float16
        if hw.device == "mps":
            return "mps", torch.float16
        return "cpu", torch.float32

    # ---------- Difusión ----------

    def get(self, spec: ModelSpec, task: str):
        with self._lock:
            if self._spec_id != spec.id:
                self.unload()
                self._spec_id = spec.id
            self._drop_ip_adapter()
            if task not in self._pipes:
                self._pipes[task] = self._load(spec, task)
            return self._pipes[task]

    def _load(self, spec: ModelSpec, task: str):
        from diffusers import AutoPipelineForImage2Image, AutoPipelineForInpainting, AutoPipelineForText2Image

        classes = {"text_to_image": AutoPipelineForText2Image, "image_to_image": AutoPipelineForImage2Image,
                   "inpainting": AutoPipelineForInpainting}
        if task not in classes:
            raise NotImplementedError(f"Tarea no implementada en el runtime: {task}")

        # Si ya hay un pipeline de este modelo cargado, derivamos sin volver a leer pesos.
        if self._pipes:
            source = next(iter(self._pipes.values()))
            pipe = classes[task].from_pipe(source)
        else:
            device, dtype = self._device_dtype()
            kwargs = {"torch_dtype": dtype, "local_files_only": True}
            if spec.variant and str(dtype) != "torch.float32":
                kwargs["variant"] = spec.variant
            pipe = classes[task].from_pretrained(spec.repo_id, **kwargs)
            # El filtro NSFW de SD1.5 devuelve imágenes negras; la política propia se aplica antes.
            if hasattr(pipe, "safety_checker"):
                pipe.safety_checker = None
            pipe = pipe.to(device)
            if device == "mps" or hardware.detect().profile == "compatible":
                pipe.enable_attention_slicing()
        pipe.set_progress_bar_config(disable=True)
        return pipe

    # ---------- Identidad (IP-Adapter) y pose (ControlNet) ----------

    def _drop_ip_adapter(self) -> None:
        """El IP-Adapter modifica la UNet compartida: se quita antes de cualquier trabajo normal."""
        if not self._ip_loaded:
            return
        base = self._pipes.get("text_to_image")
        if base is not None:
            base.unload_ip_adapter()
        for key in [k for k in self._pipes if k.startswith("identity")]:
            del self._pipes[key]
        self._ip_loaded = False

    def identity_pipe(self, spec: ModelSpec, ip_spec: ModelSpec, controlnet: ModelSpec | None):
        from diffusers import ControlNetModel, StableDiffusionXLControlNetPipeline

        from .pipelines.identity import IMAGE_ENCODER, IP_WEIGHTS

        with self._lock:
            if self._spec_id != spec.id:
                self.unload()
                self._spec_id = spec.id
            key = "identity+pose" if controlnet else "identity"
            if key in self._pipes:
                return self._pipes[key]
            if "text_to_image" not in self._pipes:
                self._pipes["text_to_image"] = self._load(spec, "text_to_image")
            base = self._pipes["text_to_image"]
            if not self._ip_loaded:
                base.load_ip_adapter(_snapshot(ip_spec), subfolder="sdxl_models", weight_name=[IP_WEIGHTS["plus"], IP_WEIGHTS["face"]],
                                     image_encoder_folder=IMAGE_ENCODER, local_files_only=True)
                self._ip_loaded = True
            pipe = base
            if controlnet is not None:
                device, dtype = self._device_dtype()
                if controlnet.id not in self._aux:
                    self._aux[controlnet.id] = ControlNetModel.from_pretrained(_snapshot(controlnet), torch_dtype=dtype).to(device)
                pipe = StableDiffusionXLControlNetPipeline.from_pipe(base, controlnet=self._aux[controlnet.id])
                pipe.set_progress_bar_config(disable=True)
            self._pipes[key] = pipe
            return pipe

    # ---------- Motores auxiliares ----------

    def spandrel(self, spec: ModelSpec):
        from .pipelines.restore import SpandrelModel

        name = spec.urls[0][0] if spec.urls else spec.allow_patterns[0]
        device, _ = self._device_dtype()
        return self._aux_model(spec, lambda path: SpandrelModel(os.path.join(path, name), device))

    def lama(self, spec: ModelSpec):
        from .pipelines.restore import Lama

        return self._aux_model(spec, lambda path: Lama(os.path.join(path, spec.allow_patterns[0])))

    def face_detector(self, spec: ModelSpec):
        from .pipelines.faces import FaceDetector

        return self._aux_model(spec, lambda path: FaceDetector(os.path.join(path, spec.allow_patterns[0])))

    def face_identity(self, spec: ModelSpec):
        from .pipelines.faces import FaceIdentity

        return self._aux_model(spec, lambda path: FaceIdentity(os.path.join(path, spec.allow_patterns[0])))

    def pose_estimator(self, spec: ModelSpec):
        from .pipelines.pose import PoseEstimator

        return self._aux_model(spec, lambda path: PoseEstimator(os.path.join(path, spec.allow_patterns[0])))

    def _aux_model(self, spec: ModelSpec, factory):
        with self._lock:
            if spec.id not in self._aux:
                self._aux[spec.id] = factory(_snapshot(spec))
            return self._aux[spec.id]

    def segmenter(self, spec: ModelSpec):
        from .pipelines.edit import Segmenter

        with self._lock:
            if spec.id not in self._aux:
                self._aux[spec.id] = Segmenter(os.path.join(_snapshot(spec), "onnx", "model.onnx"), spec.base_resolution)
            return self._aux[spec.id]

    def depth(self, spec: ModelSpec):
        from .pipelines.relight import DepthEstimator

        with self._lock:
            if spec.id not in self._aux:
                self._aux[spec.id] = DepthEstimator(os.path.join(_snapshot(spec), "onnx", "model.onnx"), spec.base_resolution)
            return self._aux[spec.id]

    def upscaler(self, spec: ModelSpec):
        from .pipelines.edit import Upscaler

        with self._lock:
            if spec.id not in self._aux:
                weights = os.path.join(_snapshot(spec), spec.allow_patterns[0])
                device, _ = self._device_dtype()
                self._aux[spec.id] = Upscaler(weights, device)
            return self._aux[spec.id]

    def forget(self, spec_id: str) -> None:
        """Suelta un modelo de memoria (p. ej. antes de borrar sus archivos)."""
        with self._lock:
            self._aux.pop(spec_id, None)
            if self._spec_id == spec_id:
                self.unload()

    def unload(self) -> None:
        if not self._pipes:
            return
        self._pipes.clear()
        self._ip_loaded = False
        self._spec_id = None
        gc.collect()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            elif torch.backends.mps.is_available():
                torch.mps.empty_cache()
        except Exception:
            pass
