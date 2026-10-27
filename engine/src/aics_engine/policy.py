"""Política de contenido. Se evalúa ANTES de planificar y no es configurable por el usuario.

Reglas duras:
  1. Nunca contenido sexual o de desnudo que involucre menores.
  2. Nunca desnudo o contenido sexual de una persona real identificable
     (imagen de entrada, referencias de identidad o persona registrada).
  3. Nunca "quitar la ropa" a una imagen existente.

El desnudo artístico sólo se permite con sujetos sintéticos/ficticios
generados desde texto, y el resultado se marca como contenido sensible.

Esta versión usa reglas léxicas; la capa de validación (fase 4) añadirá
clasificación del resultado y comparación facial contra `persons`.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from .intent import _has, normalize

NUDITY = ("desnud", "nude", "naked", "topless", "sin ropa", "nsfw", "erotic", "erotica", "sexual", "porn", "xxx",
          "genital", "pezon", "nipple", "lenceria transparente", "semidesnud")
UNDRESS = ("quita la ropa", "quitale la ropa", "sin su ropa", "desviste", "undress", "remove clothes", "remove her clothes",
           "remove his clothes", "take off", "sin vestido", "nudify", "x-ray", "rayos x")
# Con identidad de una persona real no se generan imágenes sugerentes, en ningún caso.
SUGGESTIVE = ("sexy", "sensual", "seductor", "seductora", "provocativ", "boudoir", "lenceria", "lingerie", "bikini", "ropa interior",
              "underwear", "erotic", "insinuante", "en la cama", "in bed", "mojad", "wet look")
IDENTITY_OPERATIONS = ("identity_generate", "pose_change")
MINORS = ("nino", "nina", "ninos", "ninas", "menor", "child", "children", "kid", "teen", "adolescente", "colegiala",
          "colegial", "schoolgirl", "schoolboy", "loli", "shota", "bebe", "baby", "underage", "joven de 1", "anos de edad")


@dataclass
class PolicyResult:
    allowed: bool
    rating: str  # general | sensitive
    reason: str | None = None
    rule: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def evaluate(
    prompt: str,
    *,
    has_input_image: bool = False,
    identity_references: int = 0,
    person_id: str | None = None,
    operation: str | None = None,
) -> PolicyResult:
    text = normalize(prompt)
    if operation in IDENTITY_OPERATIONS:
        if not person_id or identity_references == 0:
            return PolicyResult(False, "blocked", "Para generar imágenes con la identidad de alguien, registra a la persona "
                                "y sus fotos de referencia en Photo Studio → Personas.", "identity_without_person")
        if _has(text, SUGGESTIVE):
            return PolicyResult(False, "blocked", "Con la identidad de una persona real no se generan imágenes sugerentes "
                                "ni de ropa interior o baño.", "identity_suggestive")
    nudity = bool(_has(text, NUDITY))
    undress = bool(_has(text, UNDRESS))
    minors = bool(_has(text, MINORS))
    real_person = has_input_image or identity_references > 0 or bool(person_id)

    if (nudity or undress) and minors:
        return PolicyResult(False, "blocked", "Contenido sexual o de desnudo con menores: no permitido.", "minors")
    if undress and has_input_image:
        return PolicyResult(False, "blocked", "No se permite quitar la ropa de personas en imágenes existentes.", "undress")
    if nudity and real_person:
        return PolicyResult(
            False,
            "blocked",
            "No se generan desnudos de personas reales a partir de fotos o referencias. "
            "El desnudo artístico sólo está disponible con sujetos sintéticos creados desde texto.",
            "real_person_nudity",
        )
    return PolicyResult(True, "sensitive" if nudity else "general")


def to_dict(result: PolicyResult) -> dict:
    return asdict(result)
