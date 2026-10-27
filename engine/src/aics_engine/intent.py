"""Intent Router: clasifica un prompt simple en dominio + tareas + restricciones.

Versión 1 basada en reglas (español e inglés). La interfaz `classify()` es
estable para poder reemplazarla después por un modelo de lenguaje local.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import asdict, dataclass, field

DOMAINS = ("create", "edit", "enhance", "restore", "brand", "photo")


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text.lower())
    return "".join(c for c in text if not unicodedata.combining(c))


def _has(text: str, words: tuple[str, ...]) -> list[str]:
    return [w for w in words if re.search(rf"\b{re.escape(w)}", text)]


BRAND_WORDS = ("logo", "isotipo", "marca", "branding", "identidad visual", "icono", "icon", "favicon", "banner", "flyer",
               "mockup", "portada", "presentacion", "slide", "diapositiva", "miniatura", "thumbnail", "wordmark", "tarjeta de presentacion")
RESTORE_WORDS = ("restaura", "restore", "antigua", "antiguo", "vieja", "viejo", "old photo", "rayas", "rayones", "scratches",
                 "danada", "damaged", "colorea", "coloriza", "colorize", "polvo", "manchas")
ENHANCE_WORDS = ("mejora", "enhance", "nitidez", "sharpen", "upscale", "4k", "8k", "resolucion", "ruido", "denoise", "enfoca",
                 "detalle", "calidad")
PHOTO_WORDS = ("retrato", "portrait", "editorial", "moda", "fashion", "pose", "postura", "modelo", "fotografia", "sesion",
               "estudio fotografico", "set de estudio", "retoque", "piel", "desnudo artistico")
EDIT_WORDS = ("cambia", "change", "quita", "remove", "elimina", "borra", "agrega", "anade", "add", "pon ", "reemplaza",
              "replace", "convierte", "transforma", "haz esta", "haz que", "extiende", "extend")

REMOVE_BG_WORDS = ("quita el fondo", "quitale el fondo", "quitar el fondo", "elimina el fondo", "borra el fondo", "sin fondo",
                   "fondo transparente", "remove background", "remove the background", "transparent background", "recorta el sujeto",
                   "png transparente")

TASK_RULES: list[tuple[str, tuple[str, ...]]] = [
    ("background_removal", REMOVE_BG_WORDS),
    ("background_replace", ("fondo", "background")),
    ("recolor", ("color", "colour", "de negro", "de rojo", "de azul", "de blanco")),
    ("pose_change", ("pose", "postura")),
    ("relight", ("reilumina", "relight", "cambia la luz", "cambia la iluminacion", "luz desde", "iluminala", "contraluz", "iluminacion", "la luz")),
    ("upscale", ("upscale", "4k", "8k", "resolucion", "agranda")),
    ("denoise", ("ruido", "denoise", "grano")),
    ("face_restore", ("rostro", "cara", "face")),
    ("scratch_removal", ("rayas", "rayones", "scratches", "polvo", "manchas", "roturas")),
    ("outpaint", ("extiende", "extend", "amplia el encuadre")),
    ("style_transfer", ("estilo", "style", "acuarela", "anime", "oleo")),
    ("object_remove", ("quita", "elimina", "borra", "remove")),
    ("object_add", ("agrega", "anade", "add", "inserta")),
]

ASPECT_RULES: list[tuple[str, tuple[str, ...]]] = [
    ("16:9", ("16:9", "wallpaper", "fondo de pantalla", "presentacion", "slide", "banner", "youtube", "portada corporativa")),
    ("9:16", ("9:16", "historia", "story", "reel", "tiktok", "fondo de celular", "fondo de movil", "wallpaper movil")),
    ("4:5", ("4:5", "post de instagram", "instagram post")),
    ("1:1", ("1:1", "logo", "icono", "icon", "favicon", "avatar")),
]


@dataclass
class Intent:
    domain: str
    tasks: list[str]
    output: str  # image | logo | icon | asset
    aspect: str | None = None
    constraints: list[str] = field(default_factory=list)
    style_hints: list[str] = field(default_factory=list)
    confidence: float = 0.5
    matched: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def classify(prompt: str, mode: str | None = None, has_input_image: bool = False) -> Intent:
    text = normalize(prompt)
    scores: dict[str, list[str]] = {
        # El orden define la prioridad en caso de empate.
        "brand": _has(text, BRAND_WORDS),
        "photo": _has(text, PHOTO_WORDS),
        "restore": _has(text, RESTORE_WORDS) if has_input_image else [],
        "enhance": _has(text, ENHANCE_WORDS) if has_input_image else [],
        "edit": _has(text, EDIT_WORDS) if has_input_image else [],
    }

    if mode in DOMAINS and mode != "create":
        domain = mode
        confidence = 0.9
    else:
        best = max(scores, key=lambda d: len(scores[d]))
        if scores[best]:
            domain, confidence = best, min(0.95, 0.55 + 0.15 * len(scores[best]))
        else:
            domain, confidence = ("edit", 0.4) if has_input_image else ("create", 0.7)

    tasks: list[str] = []
    if has_input_image:
        tasks = [t for t, words in TASK_RULES if _has(text, words)]
        if "background_removal" in tasks:
            tasks = [t for t in tasks if t not in ("background_replace", "object_remove")]
        if domain == "restore" and not {"scratch_removal", "denoise", "face_restore"} & set(tasks):
            tasks += ["scratch_removal", "face_restore"]
        elif domain == "enhance" and not tasks:
            tasks = ["upscale"]
        elif not tasks:
            tasks = ["image_to_image"]
    else:
        tasks = ["text_to_image"]
        if domain == "brand" and _has(text, ("logo", "isotipo", "wordmark")):
            tasks.append("logo_design")
        if _has(text, ("4k", "8k")):
            tasks.append("upscale")

    constraints: list[str] = []
    if _has(text, ("conserva", "conservando", "mant", "preserv", "sin cambiar", "sin perder", "exactamente", "keep")):
        constraints.append("high_fidelity")
    if _has(text, ("rostro", "cara", "identidad", "face", "identity")) and has_input_image:
        constraints.append("identity")
    if _has(text, ("transparente", "transparent", "sin fondo")):
        constraints.append("transparent_background")

    output = "image"
    if domain == "brand":
        output = "logo" if _has(text, ("logo", "isotipo", "wordmark")) else "icon" if _has(text, ("icono", "icon", "favicon")) else "asset"

    aspect = next((a for a, words in ASPECT_RULES if _has(text, words)), None)
    style_hints = _has(text, ("minimalista", "minimal", "elegante", "cinematografic", "realista", "fotorrealista", "acuarela",
                              "anime", "cyberpunk", "vintage", "corporativ", "flat", "3d", "infantil", "futurista"))

    return Intent(
        domain=domain,
        tasks=tasks,
        output=output,
        aspect=aspect,
        constraints=constraints,
        style_hints=style_hints,
        confidence=round(confidence, 2),
        matched=sorted({w for ws in scores.values() for w in ws}),
    )
