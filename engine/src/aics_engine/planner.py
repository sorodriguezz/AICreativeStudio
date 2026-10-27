"""Planner: convierte una intención en un pipeline de pasos. No ejecuta nada.

Cada *operación* (lo que verá el usuario) se resuelve en capacidades que algún
modelo del registro debe proveer. Ej.: cambiar fondo = recortar sujeto + inpainting.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

from . import registry
from .intent import Intent

# Plantillas de prompt por dominio/salida. Se combinan con el preset elegido en la UI.
PROMPT_TEMPLATES = {
    "logo": ("{prompt}, logo design, flat vector style, clean shapes, centered, plain white background, professional branding",
             "photo, photorealistic, 3d render, clutter, gradient background, watermark, blurry, text artifacts"),
    "icon": ("{prompt}, app icon, flat design, simple bold shapes, centered, plain background, consistent style",
             "photo, clutter, watermark, blurry"),
    "asset": ("{prompt}, professional graphic design, clean composition, high quality",
              "watermark, blurry, low quality, distorted text"),
    "image": ("{prompt}", "low quality, blurry, watermark, deformed, jpeg artifacts"),
}

# Operación → capacidades requeridas (en orden de ejecución).
OPERATIONS: dict[str, tuple[str, ...]] = {
    "text_to_image": ("text_to_image",),
    "image_to_image": ("image_to_image",),
    "inpainting": ("inpainting",),
    "background_replace": ("background_removal", "inpainting"),
    "background_removal": ("background_removal",),
    "upscale": ("upscale",),
    "relight": ("relight",),
    "portrait_retouch": ("face_detection",),
    "identity_generate": ("identity_preservation", "text_to_image"),
    "pose_change": ("identity_preservation", "pose_control", "text_to_image"),
    "denoise": ("denoise",),
    "face_restore": ("face_detection", "face_restore"),
    "erase": ("erase",),
    "outpaint": ("inpainting",),
    "restore": (),  # depende de las correcciones elegidas (ver restore_capabilities)
}

# Operaciones con personas: se validan al final (rostros, identidad, nitidez, exposición).
PERSON_OPERATIONS = {"portrait_retouch", "identity_generate", "pose_change", "face_restore", "restore"}


def restore_capabilities(options: dict) -> list[str]:
    caps = []
    if options.get("scratches", True):
        caps.append("scratch_removal")
    if float(options.get("denoise", 0.6)) > 0:
        caps.append("denoise")
    if options.get("faces", True):
        caps += ["face_detection", "face_restore"]
    if options.get("colorize"):
        caps.append("colorize")
    if float(options.get("scale") or 1) > 1:
        caps.append("upscale")
    return caps

# Operaciones que no necesitan prompt.
PROMPTLESS = {"background_removal", "upscale", "relight", "portrait_retouch", "denoise", "face_restore", "erase", "outpaint", "restore"}

# Tareas que el router puede detectar sobre una imagen pero que aún no tienen motor.
UNSUPPORTED_EDIT_TASKS = ("pose_change",)


@dataclass
class Step:
    op: str
    available: bool
    optional: bool = False
    model_id: str | None = None
    note: str | None = None


@dataclass
class Plan:
    operation: str = "text_to_image"
    steps: list[Step] = field(default_factory=list)
    executable: bool = False
    prompt: str = ""
    negative_prompt: str = ""
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)

    def step(self, op: str) -> Step | None:
        return next((s for s in self.steps if s.op == op), None)


def resolve_operation(intent: Intent, has_input_image: bool, has_mask: bool, requested: str | None = None) -> str:
    if requested and requested != "auto":
        return requested
    if not has_input_image:
        return "text_to_image"
    if has_mask:
        return "erase" if "object_remove" in intent.tasks and "object_add" not in intent.tasks else "inpainting"
    if intent.domain == "restore":
        return "restore"
    for op in ("background_removal", "background_replace", "upscale", "relight", "outpaint", "denoise", "face_restore"):
        if op in intent.tasks:
            return op
    if intent.domain == "enhance":
        return "upscale"
    return "image_to_image"


def _model_step(capability: str, profile: str, store: registry.ModelStore, requested_model: str | None, optional: bool = False) -> Step:
    # El modelo pedido por el usuario sólo aplica a los motores de difusión.
    wants = requested_model if capability in ("text_to_image", "image_to_image", "inpainting") else None
    choice = registry.choose_model(capability, profile, store, wants)
    if choice is None:
        return Step(op=capability, available=False, optional=optional, note="No hay un modelo válido para esta tarea.")
    installed = store.is_installed(choice.spec)
    note = None if installed else f"Descarga '{choice.spec.name}' ({choice.spec.size_gb} GB) desde el Gestor de modelos."
    return Step(op=capability, available=installed, optional=optional, model_id=choice.spec.id, note=note)


def build(intent: Intent, prompt: str, negative_prompt: str = "", profile: str = "balanced",
          store: registry.ModelStore | None = None, requested_model: str | None = None, *,
          has_input_image: bool = False, has_mask: bool = False, operation: str | None = None,
          transparent: bool = False, refine: bool = False, with_pose: bool = False, pose_from_image: bool = False,
          restore_options: dict | None = None) -> Plan:
    store = store or registry.ModelStore()
    executable = registry.executable_tasks()
    op = resolve_operation(intent, has_input_image, has_mask, operation)
    plan = Plan(operation=op)

    template, default_negative = PROMPT_TEMPLATES.get(intent.output, PROMPT_TEMPLATES["image"])
    if has_input_image:
        template = "{prompt}"  # al editar no imponemos estilo de logo/ícono
    plan.prompt = template.format(prompt=prompt.strip())
    plan.negative_prompt = ", ".join(p for p in (negative_prompt.strip(), default_negative) if p)

    if op not in OPERATIONS:
        plan.steps.append(Step(op=op, available=False, note="Esta operación llega en una fase posterior."))
    else:
        if has_input_image and operation in (None, "", "auto"):
            # Lo que el usuario pidió y aún no podemos hacer: mejor avisar que hacer otra cosa.
            for task in intent.tasks:
                if task in UNSUPPORTED_EDIT_TASKS:
                    plan.steps.append(Step(op=task, available=False, note="Esta capacidad llega en una fase posterior."))
        # Identidad y pose usan adaptadores SDXL: el motor base debe ser SDXL.
        wants = "sdxl-base" if op in ("identity_generate", "pose_change") else requested_model
        capabilities = restore_capabilities(restore_options or {}) if op == "restore" else OPERATIONS[op]
        if op == "restore" and not capabilities:
            plan.steps.append(Step(op="restore", available=False, note="Elige al menos una corrección."))
        for capability in capabilities:
            plan.steps.append(_model_step(capability, profile, store, wants))
        if op == "erase" and not has_mask:
            plan.steps.append(Step(op="mask", available=False, note="Pinta lo que quieres borrar."))
        if op == "identity_generate" and (with_pose or pose_from_image):
            plan.steps.append(_model_step("pose_control", profile, store, None))
        if op == "pose_change" and not (with_pose or pose_from_image):
            plan.steps.append(Step(op="pose", available=False, note="Elige una pose: de la biblioteca, editándola o desde otra foto."))
        if pose_from_image:
            plan.steps.append(_model_step("pose_estimation", profile, store, None))
            plan.steps.append(_model_step("background_removal", profile, store, None, optional=True))
        if op in PERSON_OPERATIONS:
            for capability in ("face_detection", "face_identity"):
                if not plan.step(capability):
                    plan.steps.append(_model_step(capability, profile, store, None, optional=True))

    # Pasos posteriores opcionales sobre lo generado.
    if op in ("text_to_image", "image_to_image"):
        if "upscale" in intent.tasks:
            plan.steps.append(_model_step("upscale", profile, store, None, optional=True))
        if transparent or "transparent_background" in intent.constraints:
            plan.steps.append(_model_step("background_removal", profile, store, None, optional=True))
    if op == "relight" and refine:
        # Refinado opcional: integra la luz nueva con una pasada suave de difusión.
        plan.steps.append(_model_step("image_to_image", profile, store, requested_model, optional=True))

    if op in OPERATIONS and op not in PROMPTLESS and not prompt.strip():
        plan.steps.insert(0, Step(op="prompt", available=False, note="Describe qué quieres obtener."))

    required = [s for s in plan.steps if not s.optional]
    plan.executable = bool(required) and all(s.available for s in required)
    plan.warnings = [s.note for s in plan.steps if s.note]
    return plan
