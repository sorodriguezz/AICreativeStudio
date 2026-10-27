"""Cola de trabajos: un worker secuencial (la GPU/NPU se usa de a un job)."""

from __future__ import annotations

import queue
import threading
import time
import traceback
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np

from . import hardware, intent, planner, policy, registry, subscriptions
from .pipelines import edit, faces, identity, pose, relight, restore, retouch, text_to_image
from .runtime import Runtime


@dataclass
class JobRequest:
    job_id: str
    prompt: str
    output_dir: str
    mode: str = "create"
    negative_prompt: str = ""
    params: dict = field(default_factory=dict)
    input_image: str | None = None
    identity_references: list[str] = field(default_factory=list)
    person_id: str | None = None


@dataclass
class JobState:
    job_id: str
    status: str = "queued"  # queued | running | completed | failed | cancelled | rejected
    progress: float = 0.0
    message: str = "En cola"
    outputs: list[dict] = field(default_factory=list)
    error: str | None = None
    intent: dict | None = None
    plan: dict | None = None
    policy: dict | None = None
    started_at: float | None = None
    finished_at: float | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def analyze(req: JobRequest, store: registry.ModelStore) -> tuple[intent.Intent, policy.PolicyResult, planner.Plan | None]:
    has_image = bool(req.input_image)
    pol = policy.evaluate(req.prompt, has_input_image=has_image, identity_references=len(req.identity_references),
                          person_id=req.person_id, operation=req.params.get("operation"))
    it = intent.classify(req.prompt, mode=req.mode, has_input_image=has_image)
    if not pol.allowed:
        return it, pol, None
    profile = req.params.get("profile") or hardware.detect().profile
    plan = planner.build(it, req.prompt, req.negative_prompt, profile, store, req.params.get("model_id"),
                         has_input_image=has_image, has_mask=bool(req.params.get("mask_path")),
                         operation=req.params.get("operation"), transparent=bool(req.params.get("transparent")),
                         refine=bool(req.params.get("refine")), with_pose=bool(req.params.get("pose")),
                         pose_from_image=bool(req.params.get("pose_image")), restore_options=req.params)
    provider = cloud_provider(req.params)
    if provider:
        # Con una suscripción, la CLI hace el trabajo: no hacen falta modelos locales.
        plan.executable, plan.warnings = True, []
    return it, pol, plan


def cloud_provider(params: dict) -> str | None:
    provider = params.get("provider")
    return provider if provider and provider != "local" else None


class JobManager:
    def __init__(self, store: registry.ModelStore) -> None:
        self.store = store
        self.runtime = Runtime()
        self._jobs: dict[str, JobState] = {}
        self._requests: dict[str, JobRequest] = {}
        self._cancelled: set[str] = set()
        self._queue: queue.Queue[str] = queue.Queue()
        self._lock = threading.Lock()
        threading.Thread(target=self._worker, name="job-worker", daemon=True).start()

    def submit(self, req: JobRequest) -> JobState:
        it, pol, plan = analyze(req, self.store)
        state = JobState(job_id=req.job_id, intent=it.to_dict(), policy=pol.to_dict(), plan=plan.to_dict() if plan else None)
        if not pol.allowed:
            state.status, state.error, state.message = "rejected", pol.reason, "Rechazado por la política de contenido"
        elif not plan.executable:
            state.status, state.message = "failed", "El plan no se puede ejecutar todavía"
            state.error = " ".join(w for w in plan.warnings) or "No hay motores disponibles para esta solicitud."
        elif req.input_image and not Path(req.input_image).is_file():
            state.status, state.message, state.error = "failed", "Error", "No se encontró la imagen de entrada."
        with self._lock:
            self._jobs[req.job_id] = state
            self._requests[req.job_id] = req
        if state.status == "queued":
            self._queue.put(req.job_id)
        return state

    def get(self, job_id: str) -> JobState | None:
        with self._lock:
            return self._jobs.get(job_id)

    def cancel(self, job_id: str) -> JobState | None:
        with self._lock:
            self._cancelled.add(job_id)
            state = self._jobs.get(job_id)
            if state and state.status == "queued":
                state.status, state.message = "cancelled", "Cancelado"
            return state

    def _update(self, job_id: str, **changes) -> None:
        with self._lock:
            state = self._jobs[job_id]
            for k, v in changes.items():
                setattr(state, k, v)

    def _worker(self) -> None:
        while True:
            job_id = self._queue.get()
            with self._lock:
                state, req = self._jobs[job_id], self._requests[job_id]
                if state.status == "cancelled":
                    continue
            self._update(job_id, status="running", started_at=time.time(), message="Cargando modelo…")
            try:
                outputs = self._execute(req, state)
                self._update(job_id, status="completed", progress=1.0, outputs=outputs, message="Listo", finished_at=time.time())
            except text_to_image.Cancelled:
                self._update(job_id, status="cancelled", message="Cancelado", finished_at=time.time())
            except Exception as exc:
                traceback.print_exc()
                self._update(job_id, status="failed", error=str(exc), message="Error", finished_at=time.time())

    # ---------- Ejecución ----------

    def _execute(self, req: JobRequest, state: JobState) -> list[dict]:
        from PIL import Image

        plan = state.plan
        op = plan["operation"]
        steps = {s["op"]: s for s in plan["steps"]}
        hw = hardware.detect()
        p = req.params
        out_dir = Path(req.output_dir)
        progress = lambda frac, msg: self._update(req.job_id, progress=round(min(frac, 1.0), 4), message=msg)  # noqa: E731
        cancelled = lambda: req.job_id in self._cancelled  # noqa: E731
        source = Image.open(req.input_image) if req.input_image else None
        report: dict = {}
        if source is not None:
            source.load()
            source = source.convert("RGBA") if source.mode in ("RGBA", "LA", "P") and op in ("background_removal", "upscale", "relight") else source.convert("RGB")

        def diffusion_spec(capability: str) -> registry.ModelSpec:
            return registry.get(steps[capability]["model_id"])

        def common(spec: registry.ModelSpec) -> dict:
            return dict(
                prompt=plan["prompt"] + (", " + p["prompt_suffix"] if p.get("prompt_suffix") else ""),
                negative_prompt=", ".join(x for x in (plan["negative_prompt"], p.get("negative_suffix", "")) if x),
                steps=int(p.get("steps") or max(1, round(spec.default_steps * hw.defaults["steps_scale"]))),
                guidance=float(p.get("guidance") or spec.default_guidance),
                on_progress=progress, is_cancelled=cancelled,
            )

        # Asistente de prompts por suscripción (Claude, ChatGPT o Gemini), antes de generar.
        assistant = p.get("prompt_provider")
        if assistant and assistant != "none" and req.prompt.strip():
            label = subscriptions.PROVIDERS.get(assistant, subscriptions.PROVIDERS["claude"]).label
            progress(0.01, f"{label} está mejorando el prompt…")
            try:
                plan["prompt"] = subscriptions.complete_text(assistant, subscriptions.prompt_task(plan["prompt"], op))
                report["prompt_rewritten"] = plan["prompt"]
                report["prompt_provider"] = assistant
            except subscriptions.ProviderError as exc:
                report["prompt_warning"] = str(exc)

        provider = cloud_provider(p)
        if provider:
            results = self._cloud(provider, req, plan, op, source, progress, cancelled)
            outputs = []
            for i, img in enumerate(results):
                info = edit.save(img, out_dir, f"{req.job_id}_{i + 1}")
                info.update(seed=None, model_id=f"cli:{provider}", operation=op, provider=provider)
                if req.person_id:
                    info["person_id"] = req.person_id
                if report:
                    info["report"] = report
                outputs.append(info)
            return outputs

        count = max(1, min(int(p.get("count") or 1), hw.defaults["max_batch"]))
        seed = p.get("seed")
        results: list[tuple[Image.Image, int | None, str]] = []  # (imagen, seed, modelo)

        if op == "text_to_image":
            spec = diffusion_spec("text_to_image")
            pipe = self.runtime.get(spec, "text_to_image")
            width, height = text_to_image.resolve_size(p.get("aspect") or state.intent.get("aspect"), spec.base_resolution,
                                                       max(hw.defaults["max_side"], spec.base_resolution), p.get("width"), p.get("height"))
            outs = text_to_image.run(pipe, spec, width=width, height=height, seed=seed, count=count,
                                     output_dir=out_dir, job_id=req.job_id, **common(spec))
            results = [(Image.open(o["path"]).copy(), o["seed"], spec.id) for o in outs]

        elif op == "image_to_image":
            spec = diffusion_spec("image_to_image")
            pipe = self.runtime.get(spec, "image_to_image")
            size = edit.working_size(source.width, source.height, spec.base_resolution, max(hw.defaults["max_side"], spec.base_resolution))
            outs = edit.image_to_image(pipe, source, count=count, seed=seed, size=size,
                                       strength=float(p.get("strength") or 0.6), **common(spec))
            results = [(img, s, spec.id) for img, s in outs]

        elif op == "inpainting":
            if not p.get("mask_path"):
                raise ValueError("Pinta la zona que quieres cambiar.")
            spec = diffusion_spec("inpainting")
            pipe = self.runtime.get(spec, "inpainting")
            mask = Image.open(p["mask_path"]).convert("L")
            size = edit.working_size(source.width, source.height, spec.base_resolution, max(hw.defaults["max_side"], spec.base_resolution))
            outs = edit.inpaint(pipe, source, mask, count=count, seed=seed, size=size,
                                strength=float(p.get("strength") or 1.0), **common(spec))
            results = [(img, s, spec.id) for img, s in outs]

        elif op == "background_replace":
            progress(0.02, "Detectando el sujeto…")
            segmenter = self.runtime.segmenter(registry.get(steps["background_removal"]["model_id"]))
            alpha = segmenter.alpha(source)
            spec = diffusion_spec("inpainting")
            pipe = self.runtime.get(spec, "inpainting")
            background = Image.eval(alpha, lambda v: 255 - v)
            size = edit.working_size(source.width, source.height, spec.base_resolution, max(hw.defaults["max_side"], spec.base_resolution))
            outs = edit.inpaint(pipe, source, background, count=count, seed=seed, size=size, keep_alpha=alpha,
                                progress_offset=0.08, progress_span=0.92, **common(spec))
            results = [(img, s, spec.id) for img, s in outs]

        elif op == "background_removal":
            progress(0.1, "Recortando el sujeto…")
            model = registry.get(steps["background_removal"]["model_id"])
            results = [(edit.remove_background(self.runtime.segmenter(model), source), None, model.id)]

        elif op == "upscale":
            model = registry.get(steps["upscale"]["model_id"])
            factor = float(p.get("scale") or 2)
            image = self.runtime.upscaler(model).upscale(source, factor, progress, cancelled)
            results = [(image, None, model.id)]

        elif op == "relight":
            progress(0.05, "Estimando el volumen de la escena…")
            estimator = self.runtime.depth(registry.get(steps["relight"]["model_id"]))
            light = relight.Light.from_params(p)
            normals = relight.normals_from_depth(estimator.depth(source))
            progress(0.5, "Aplicando la luz…")
            lit = relight.shade(source, normals, light)
            refine_step = steps.get("image_to_image")
            if refine_step and refine_step["available"]:
                spec = registry.get(refine_step["model_id"])
                pipe = self.runtime.get(spec, "image_to_image")
                size = edit.working_size(source.width, source.height, spec.base_resolution, max(hw.defaults["max_side"], spec.base_resolution))
                kw = common(spec)
                kw["prompt"] = ", ".join(x for x in (req.prompt.strip(), relight.lighting_prompt(light)) if x)
                kw["on_progress"] = lambda f, m: progress(0.5 + 0.5 * f, f"Refinando · {m}")
                refined, s = edit.image_to_image(pipe, lit.convert("RGB"), count=1, seed=seed, size=size, strength=0.25, **kw)[0]
                results = [(refined.resize(source.size, Image.LANCZOS), s, spec.id)]
            else:
                results = [(lit, None, "depth-anything-v2-small")]

        elif op == "portrait_retouch":
            progress(0.1, "Detectando rostros…")
            detector = self.runtime.face_detector(registry.get(steps["face_detection"]["model_id"]))
            found = detector.detect(source)
            progress(0.4, "Retocando piel y color…")
            results = [(retouch.retouch(source, found, skin=float(p.get("skin", 0.5)), look=p.get("look", "natural"),
                                        intensity=float(p.get("intensity", 1.0)), vignette_amount=float(p.get("vignette", 0.0)),
                                        grain=float(p.get("grain", 0.0)), body_skin=bool(p.get("body_skin"))), None, "yunet")]

        elif op in ("identity_generate", "pose_change"):
            results = self._identity(req, state, steps, source, progress, cancelled, count, seed)

        elif op == "denoise":
            model = self.runtime.spandrel(registry.get(steps["denoise"]["model_id"]))
            results = [(restore.denoise(model, source, float(p.get("strength") or 0.8), progress, cancelled), None, "scunet")]

        elif op == "face_restore":
            progress(0.05, "Buscando rostros…")
            found = self.runtime.face_detector(registry.get(steps["face_detection"]["model_id"])).detect(source, threshold=0.5)
            if not found:
                raise ValueError("No se encontraron rostros en la imagen.")
            model = self.runtime.spandrel(registry.get(steps["face_restore"]["model_id"]))
            image, n = restore.restore_faces(model, source, found, float(p.get("fidelity") or 0.7), progress)
            report["faces_restored"] = n
            results = [(image, None, "gfpgan")]

        elif op == "erase":
            if not p.get("mask_path"):
                raise ValueError("Pinta lo que quieres borrar.")
            lama = self.runtime.lama(registry.get(steps["erase"]["model_id"]))
            results = [(lama.inpaint(source.convert("RGB"), Image.open(p["mask_path"]).convert("L"), progress, cancelled), None, "lama")]

        elif op == "outpaint":
            spec = diffusion_spec("inpainting")
            pipe = self.runtime.get(spec, "inpainting")
            kw = common(spec)
            if not req.prompt.strip():
                kw["prompt"] = "seamless natural continuation of the scene, same lighting, same style, coherent perspective"
            sides = {k: float(p.get(f"expand_{k}") or 0) for k in ("left", "right", "top", "bottom")}
            if not any(sides.values()):
                raise ValueError("Elige cuánto extender la imagen.")
            outs = edit.outpaint(pipe, source.convert("RGB"), **sides, count=count, seed=seed, base=spec.base_resolution,
                                 max_side=max(hw.defaults["max_side"], spec.base_resolution), **kw)
            results = [(img, s, spec.id) for img, s in outs]

        elif op == "restore":
            results = [(self._restore(p, steps, source, progress, cancelled, report), None, "restore")]

        else:
            raise NotImplementedError(f"Operación no disponible: {op}")

        # Pasos opcionales encadenados (p. ej. "logo sin fondo", "wallpaper 4K").
        follow_bg = steps.get("background_removal") if op in ("text_to_image", "image_to_image") else None
        if follow_bg and follow_bg["optional"] and follow_bg["available"]:
            progress(0.97, "Quitando el fondo…")
            seg = self.runtime.segmenter(registry.get(follow_bg["model_id"]))
            results = [(edit.remove_background(seg, img), s, m) for img, s, m in results]
        follow_up = steps.get("upscale") if op != "upscale" else None
        if follow_up and follow_up["optional"] and follow_up["available"]:
            ups = self.runtime.upscaler(registry.get(follow_up["model_id"]))
            upscaled = []
            for i, (img, s, m) in enumerate(results):
                factor = min(4.0, max(1.0, 3840 / max(img.size)))
                upscaled.append((ups.upscale(img, factor, lambda f, msg, i=i: progress(0.9 + 0.1 * (i + f) / len(results), msg), cancelled), s, m))
            results = upscaled

        validations = self._validate(req, steps, op, source, results, progress)
        if validations:
            order = sorted(range(len(results)), key=lambda i: -(validations[i].identity or 0))
            results, validations = [results[i] for i in order], [validations[i] for i in order]
            minimum = p.get("min_identity")
            if minimum is not None and any(v.identity is not None for v in validations):
                keep = [i for i, v in enumerate(validations) if (v.identity or 0) >= float(minimum)]
                if not keep:
                    best = validations[0].identity or 0
                    raise ValueError(f"Ninguna variación alcanzó la fidelidad mínima (mejor: {best:.2f}). "
                                     "Prueba con más fotos de referencia, una pose más parecida o menos cambios en el prompt.")
                results, validations = [results[i] for i in keep], [validations[i] for i in keep]

        outputs = []
        for i, (img, s, model_id) in enumerate(results):
            info = edit.save(img, out_dir, f"{req.job_id}_{i + 1}")
            info.update(seed=s, model_id=model_id, operation=op)
            if validations:
                info["validation"] = validations[i].to_dict()
            if req.person_id:
                info["person_id"] = req.person_id
            if report:
                info["report"] = report
            outputs.append(info)
        return outputs

    # ---------- Suscripciones (CLI) ----------

    def _cloud(self, provider: str, req: JobRequest, plan: dict, op: str, source, progress, cancelled) -> list:
        from PIL import Image

        p = req.params
        work = Path(req.output_dir).parent / ".cli" / req.job_id
        inputs: list[str] = []
        if req.input_image:
            inputs.append(req.input_image)
        has_mask = bool(p.get("mask_path")) and op in ("inpainting", "erase")
        if op in ("inpainting", "erase") and not has_mask:
            raise ValueError("Pinta la zona que quieres cambiar.")
        if has_mask:
            inputs.append(p["mask_path"])
        refs = req.identity_references[:4]
        inputs += refs
        pose_dict = p.get("pose")
        if pose_dict:
            work.mkdir(parents=True, exist_ok=True)
            skeleton = work / "pose.png"
            pose.render(pose_dict, int(pose_dict["width"]), int(pose_dict["height"])).save(skeleton)
            inputs.append(str(skeleton))
        elif p.get("pose_image"):
            inputs.append(p["pose_image"])
        lighting = relight.lighting_prompt(relight.Light.from_params(p)) if op == "relight" else None
        count = max(1, min(int(p.get("count") or 1), 4))
        prompt = plan["prompt"] + (", " + p["prompt_suffix"] if p.get("prompt_suffix") else "")
        task = subscriptions.image_task(op, prompt, p, count, has_mask=has_mask, refs=len(refs),
                                        has_pose=bool(pose_dict or p.get("pose_image")), lighting=lighting)
        try:
            files = subscriptions.generate_images(provider, task, inputs, work, progress, cancelled, expected=count)
        except subscriptions.Cancelled:
            raise text_to_image.Cancelled() from None
        except subscriptions.ProviderError as exc:
            raise ValueError(str(exc)) from None
        progress(0.95, "Guardando…")
        images = []
        for f in files[-count:]:
            img = Image.open(f)
            img.load()
            images.append(img.convert("RGBA") if img.mode in ("RGBA", "LA", "P") else img.convert("RGB"))
        import shutil

        shutil.rmtree(work, ignore_errors=True)
        return images

    # ---------- Photo Studio ----------

    def _reference_embeddings(self, steps: dict, images: list) -> list:
        det_step, id_step = steps.get("face_detection"), steps.get("face_identity")
        if not (det_step and det_step["available"] and id_step and id_step["available"]):
            return []
        detector = self.runtime.face_detector(registry.get(det_step["model_id"]))
        ident = self.runtime.face_identity(registry.get(id_step["model_id"]))
        out = []
        for img in images:
            found = detector.detect(img)
            if found:
                out.append(ident.embed(faces.align_face(img, found[0])))
        return out

    def _validate(self, req: JobRequest, steps: dict, op: str, source, results, progress) -> list:
        if op not in planner.PERSON_OPERATIONS:
            return []
        det_step, id_step = steps.get("face_detection"), steps.get("face_identity")
        detector = self.runtime.face_detector(registry.get(det_step["model_id"])) if det_step and det_step["available"] else None
        ident = self.runtime.face_identity(registry.get(id_step["model_id"])) if id_step and id_step["available"] else None
        progress(0.98, "Validando resultados…")
        from PIL import Image

        refs = [Image.open(r).convert("RGB") for r in req.identity_references] or ([source] if source is not None else [])
        embeddings = self._reference_embeddings(steps, refs) if ident else []
        expect = op not in ("restore",)  # una foto antigua puede no tener personas
        return [faces.validate(img.convert("RGB"), detector, ident, embeddings, expect_person=expect) for img, _, _ in results]

    def _restore(self, p: dict, steps: dict, source, progress, cancelled, report: dict):
        """Restauración de foto antigua: tono → rayas → ruido → rostros → color → tamaño."""
        from PIL import Image

        opts = restore.RestoreOptions.from_params(p)
        image = source.convert("RGB")
        stages = [s for s in ("tone", "scratches", "denoise", "faces", "colorize", "upscale")
                  if (s == "tone" and opts.tone) or (s == "scratches" and steps.get("scratch_removal"))
                  or (s == "denoise" and steps.get("denoise")) or (s == "faces" and steps.get("face_restore"))
                  or (s == "colorize" and steps.get("colorize")) or (s == "upscale" and steps.get("upscale"))]
        span = 1.0 / max(1, len(stages))
        found = []
        if steps.get("face_detection"):
            found = self.runtime.face_detector(registry.get(steps["face_detection"]["model_id"])).detect(image, threshold=0.5)
        for i, stage in enumerate(stages):
            sub = lambda f, m, i=i: progress(i * span + f * span, m)  # noqa: E731
            if stage == "tone":
                sub(0.5, "Recuperando contraste…")
                image = restore.auto_tone(image, 0.6 if opts.mode == "documental" else 1.0)
            elif stage == "scratches":
                if p.get("damage_mask_path"):  # máscara revisada por el usuario
                    sub(0.05, "Usando la máscara de daños revisada…")
                    mask = Image.open(p["damage_mask_path"]).convert("L").resize(image.size)
                else:
                    sub(0.05, "Detectando rayas y manchas…")
                    mask = restore.detect_damage(image, opts.sensitivity, protect=found)
                report["damaged_pct"] = round(100 * float((np.asarray(mask) > 127).mean()), 2)
                lama = self.runtime.lama(registry.get(steps["scratch_removal"]["model_id"]))
                image = lama.inpaint(image, mask, sub, cancelled)
            elif stage == "denoise":
                model = self.runtime.spandrel(registry.get(steps["denoise"]["model_id"]))
                image = restore.denoise(model, image, opts.denoise_strength(), sub, cancelled)
            elif stage == "faces" and found:
                model = self.runtime.spandrel(registry.get(steps["face_restore"]["model_id"]))
                image, report["faces_restored"] = restore.restore_faces(model, image, found, opts.face_fidelity(), sub)
            elif stage == "colorize":
                sub(0.3, "Coloreando…")
                if restore.is_monochrome(image) or p.get("force_colorize"):
                    image = restore.colorize(self.runtime.spandrel(registry.get(steps["colorize"]["model_id"])), image)
                    report["colorized"] = True
            elif stage == "upscale":
                ups = self.runtime.upscaler(registry.get(steps["upscale"]["model_id"]))
                image = ups.upscale(image, float(p.get("scale") or 2), sub, cancelled)
        report["mode"] = opts.mode
        return image

    def _identity(self, req: JobRequest, state: JobState, steps: dict, source, progress, cancelled, count: int, seed):
        from PIL import Image

        p = req.params
        plan = state.plan
        hw = hardware.detect()
        spec = registry.get(steps["text_to_image"]["model_id"])
        ip_spec = registry.get(steps["identity_preservation"]["model_id"])
        control_step = steps.get("pose_control")
        progress(0.02, "Preparando referencias…")
        refs = [Image.open(r).convert("RGB") for r in req.identity_references]
        det_step = steps.get("face_detection")
        if not (det_step and det_step["available"]):
            raise ValueError("Descarga 'YuNet (detección de rostros)' desde el Gestor de modelos.")
        detector = self.runtime.face_detector(registry.get(det_step["model_id"]))
        face_images = []
        for ref in refs[:4]:
            found = detector.detect(ref)
            if found:
                face_images.append(faces.face_crop(ref, found[0]))
        if not face_images:
            raise ValueError("No se encontró un rostro en las fotos de referencia.")

        pose_dict = p.get("pose")
        if not pose_dict and p.get("pose_image"):
            progress(0.05, "Leyendo la pose de la foto…")
            pose_img = Image.open(p["pose_image"]).convert("RGB")
            seg_step = steps.get("background_removal")
            alpha = self.runtime.segmenter(registry.get(seg_step["model_id"])).alpha(pose_img) if seg_step and seg_step["available"] else None
            kps = self.runtime.pose_estimator(registry.get(steps["pose_estimation"]["model_id"])).estimate(pose_img, pose.person_box(alpha, pose_img.size))
            pose_dict = pose.to_openpose(kps, pose_img.width, pose_img.height)

        if pose_dict:
            size = edit.working_size(int(pose_dict["width"]), int(pose_dict["height"]), spec.base_resolution, max(hw.defaults["max_side"], spec.base_resolution))
            control = pose.render(pose_dict, *size)
        else:
            size = text_to_image.resolve_size(p.get("aspect") or "3:4", spec.base_resolution, max(hw.defaults["max_side"], spec.base_resolution))
            control = None
        controlnet = registry.get(control_step["model_id"]) if control is not None and control_step else None

        progress(0.08, "Cargando motores de identidad…")
        pipe = self.runtime.identity_pipe(spec, ip_spec, controlnet)
        appearance = source if (req.params.get("operation") == "pose_change" and source is not None) else None
        prompt = plan["prompt"] + (", " + p["prompt_suffix"] if p.get("prompt_suffix") else "")
        outs = identity.generate(
            pipe, prompt=prompt, negative_prompt=plan["negative_prompt"], face_images=face_images, appearance=appearance,
            control=control, size=size, steps=int(p.get("steps") or max(1, round(spec.default_steps * hw.defaults["steps_scale"]))),
            guidance=float(p.get("guidance") or 5.0), count=count, seed=seed, identity_scale=float(p.get("identity_strength", 0.7)),
            control_scale=float(p.get("pose_strength", 0.8)),
            on_progress=lambda f, m: progress(0.1 + 0.85 * f, m), is_cancelled=cancelled)
        return [(img, s, spec.id) for img, s in outs]
