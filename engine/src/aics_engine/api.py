"""API HTTP local del sidecar. Sólo escucha en 127.0.0.1 y exige el token de sesión."""

from __future__ import annotations

from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from . import __version__, hardware, registry, subscriptions
from .jobs import JobManager, JobRequest, analyze


class AnalyzeBody(BaseModel):
    prompt: str
    mode: str = "create"
    negative_prompt: str = ""
    params: dict = Field(default_factory=dict)
    input_image: str | None = None
    identity_references: list[str] = Field(default_factory=list)
    person_id: str | None = None


class RelightPrepareBody(BaseModel):
    image: str
    max_side: int = 768


class ImageBody(BaseModel):
    image: str


class QueueBody(BaseModel):
    ids: list[str]


class DamageBody(BaseModel):
    image: str
    sensitivity: float = 0.35


class JobBody(AnalyzeBody):
    job_id: str
    output_dir: str


def create_app(token: str, data_dir: Path) -> FastAPI:
    app = FastAPI(title="AICreativeStudio Engine", version=__version__)
    store = registry.ModelStore()
    jobs = JobManager(store)

    def auth(x_aics_token: str = Header(default="")) -> None:
        if token and x_aics_token != token:
            raise HTTPException(status_code=401, detail="token inválido")

    guarded = [Depends(auth)]

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "version": __version__}

    @app.get("/hardware", dependencies=guarded)
    def get_hardware() -> dict:
        return hardware.detect().to_dict()

    @app.get("/providers", dependencies=guarded)
    def providers(refresh: bool = False) -> list[dict]:
        return subscriptions.status(refresh)

    @app.get("/models", dependencies=guarded)
    def list_models() -> list[dict]:
        return registry.describe_all(store)

    @app.post("/models/{model_id}/download", dependencies=guarded)
    def download_model(model_id: str) -> dict:
        spec = registry.get(model_id)
        if not spec:
            raise HTTPException(404, "modelo desconocido")
        try:
            store.enqueue([spec])
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        return store.describe(spec)

    @app.get("/models/packs", dependencies=guarded)
    def model_packs() -> dict:
        return registry.describe_packs(store)

    @app.post("/models/queue", dependencies=guarded)
    def queue_models(body: QueueBody) -> dict:
        specs = [registry.get(i) for i in body.ids]
        if any(s is None for s in specs):
            raise HTTPException(404, "modelo desconocido")
        try:
            return {"queued": store.enqueue(specs)}
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.delete("/models/{model_id}", dependencies=guarded)
    def delete_model(model_id: str) -> dict:
        spec = registry.get(model_id)
        if not spec:
            raise HTTPException(404, "modelo desconocido")
        jobs.runtime.forget(spec.id)
        try:
            return {"freed_bytes": store.delete(spec)}
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/analyze", dependencies=guarded)
    def analyze_prompt(body: AnalyzeBody) -> dict:
        req = JobRequest(job_id="preview", output_dir="", **body.model_dump())
        it, pol, plan = analyze(req, store)
        return {"intent": it.to_dict(), "policy": pol.to_dict(), "plan": plan.to_dict() if plan else None}

    @app.post("/relight/prepare", dependencies=guarded)
    def relight_prepare(body: RelightPrepareBody) -> dict:
        """Imagen y mapa de normales a tamaño de vista previa, para iluminar en vivo en la UI."""
        from PIL import Image

        from .pipelines import relight

        spec = next((m for m in registry.CATALOG if "depth" in m.tasks), None)
        if not spec or not store.is_installed(spec):
            raise HTTPException(409, f"Descarga '{spec.name}' ({spec.size_gb} GB) desde el Gestor de modelos.")
        image = Image.open(body.image)
        image.load()
        image = image.convert("RGBA") if image.mode in ("RGBA", "LA", "P") else image.convert("RGB")
        image.thumbnail((body.max_side, body.max_side), Image.LANCZOS)
        normals = relight.normals_from_depth(jobs.runtime.depth(spec).depth(image))
        return {"image": relight.to_b64_png(image), "normals": relight.to_b64_png(relight.encode_normals(normals)),
                "width": image.width, "height": image.height}

    def _need(task: str):
        spec = next((m for m in registry.CATALOG if task in m.tasks and m.backend != "planned"), None)
        if not spec or not store.is_installed(spec):
            raise HTTPException(409, f"Descarga '{spec.name}' ({spec.size_gb} GB) desde el Gestor de modelos.")
        return spec

    def _open(path: str):
        from PIL import Image

        try:
            image = Image.open(path)
            image.load()
        except Exception as exc:
            raise HTTPException(400, f"No se pudo abrir la imagen: {exc}") from exc
        return image.convert("RGB")

    @app.post("/faces/analyze", dependencies=guarded)
    def faces_analyze(body: ImageBody) -> dict:
        """Rostros de una foto y el descriptor del principal (para fotos de referencia)."""
        from .pipelines import faces

        image = _open(body.image)
        found = jobs.runtime.face_detector(_need("face_detection")).detect(image)
        embedding = None
        if found:
            ident = jobs.runtime.face_identity(_need("face_identity"))
            embedding = [round(float(v), 6) for v in ident.embed(faces.align_face(image, found[0]))]
        return {"width": image.width, "height": image.height, "faces": [f.to_dict() for f in found], "embedding": embedding}

    @app.post("/pose/estimate", dependencies=guarded)
    def pose_estimate(body: ImageBody) -> dict:
        """Pose de la persona principal en formato OpenPose normalizado (para el editor de poses)."""
        from .pipelines import pose

        image = _open(body.image)
        seg = next((m for m in registry.CATALOG if "background_removal" in m.tasks), None)
        alpha = jobs.runtime.segmenter(seg).alpha(image) if seg and store.is_installed(seg) else None
        kps = jobs.runtime.pose_estimator(_need("pose_estimation")).estimate(image, pose.person_box(alpha, image.size))
        result = pose.to_openpose(kps, image.width, image.height)
        if pose.visible_ratio(result) < 0.35:
            raise HTTPException(422, "No se distingue bien una persona en esa foto.")
        return result

    @app.post("/restore/detect", dependencies=guarded)
    def restore_detect(body: DamageBody) -> dict:
        """Máscara de daños detectados (PNG blanco sobre negro) para revisarla antes de restaurar."""
        from .pipelines import relight, restore

        image = _open(body.image)
        det = next((m for m in registry.CATALOG if "face_detection" in m.tasks), None)
        found = jobs.runtime.face_detector(det).detect(image, threshold=0.5) if det and store.is_installed(det) else []
        mask = restore.detect_damage(image, body.sensitivity, protect=found)
        pct = float((__import__("numpy").asarray(mask) > 127).mean() * 100)
        return {"mask": relight.to_b64_png(mask), "width": image.width, "height": image.height, "damaged_pct": round(pct, 2), "faces": len(found)}

    @app.post("/jobs", dependencies=guarded)
    def submit_job(body: JobBody) -> dict:
        if jobs.get(body.job_id):
            raise HTTPException(409, "job ya existe")
        return jobs.submit(JobRequest(**body.model_dump())).to_dict()

    @app.get("/jobs/{job_id}", dependencies=guarded)
    def get_job(job_id: str) -> dict:
        state = jobs.get(job_id)
        if not state:
            raise HTTPException(404, "job desconocido")
        return state.to_dict()

    @app.post("/jobs/{job_id}/cancel", dependencies=guarded)
    def cancel_job(job_id: str) -> dict:
        state = jobs.cancel(job_id)
        if not state:
            raise HTTPException(404, "job desconocido")
        return state.to_dict()

    return app
