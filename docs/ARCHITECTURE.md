# Arquitectura

```text
┌──────────────────────── App de escritorio (Tauri) ────────────────────────┐
│  UI React/TS ──invoke──▶ Núcleo Rust ──HTTP 127.0.0.1 + token──▶ Sidecar   │
│      ▲                     │  SQLite (aics.db)                     Python  │
│      └──── eventos ────────┘  archivos por proyecto                (IA)    │
│        job-update / engine-status                                          │
└────────────────────────────────────────────────────────────────────────────┘
```

## Responsabilidades

**UI (React).** Modos de trabajo, prompts, presets, biblioteca, historial. Nunca habla con
el motor directamente: sólo con comandos de Rust (`src/lib/api.ts`).

**Núcleo Rust (`src-tauri`).** Dueño de los datos y del ciclo de vida:
- Crea la estructura local en el directorio de datos de la app y abre SQLite (WAL, FKs, migraciones por `user_version`).
- Lanza el sidecar en un puerto libre con un token aleatorio por sesión, espera `/health` y lo detiene al salir. El sidecar además se cierra solo si muere el proceso padre (`--parent-pid`).
- `jobs.rs`: inserta el job, lo envía al motor, lo sigue cada 500 ms, emite `job-update` y registra los resultados como `assets` + `versions`.
- Marca como fallidos los jobs que quedaron a medias si la app se cerró.

**Sidecar Python (`engine`).** Todo lo que es IA:

| Módulo | Rol |
| --- | --- |
| `intent.py` | **Intent Router**: prompt → dominio (create/edit/enhance/restore/brand/photo), tareas, formato, restricciones. Basado en reglas ES/EN; interfaz estable para reemplazarlo por un LLM local. |
| `policy.py` | **Política de contenido**, se evalúa antes de planificar. Reglas duras, no configurables. |
| `planner.py` | **Planner**: intención → pasos. Marca qué pasos son ejecutables, cuáles son opcionales (se omiten si no hay motor) y qué modelo usar. Aplica plantillas de prompt por tipo de salida (logo, ícono, asset). |
| `registry.py` | **Model Registry**: cada modelo declara tareas, perfiles, memoria mínima, plataformas, licencia y repo. Los motores de fases futuras ya están declarados como `planned`. |
| `hardware.py` | Detecta CUDA / MPS / CPU y memoria → perfil **Full / Balanced / Compatible** (resolución máxima, escala de pasos, lote máximo). |
| `runtime.py` | Carga pipelines de diffusers en el dispositivo correcto (fp16 en GPU/MPS, fp32 en CPU) y mantiene **un** pipeline residente para no agotar la memoria unificada. |
| `jobs.py` | Cola con un único worker (la GPU se usa de a un job), progreso por paso, cancelación cooperativa. |
| `pipelines/` | `text_to_image`; `edit` (img2img, inpainting, recorte con BiRefNet/ONNX, cambio de fondo, Real-ESRGAN por bloques). |

### Operaciones y capacidades

El planner traduce cada operación en capacidades que provee algún modelo del registro:

| Operación | Capacidades | Modelos |
| --- | --- | --- |
| `text_to_image` | text_to_image | SDXL / SD1.5 |
| `image_to_image` | image_to_image | SDXL (derivado con `from_pipe`, sin pesos extra) |
| `inpainting` | inpainting | SDXL Inpainting si está instalado; si no, SDXL base |
| `background_replace` | background_removal → inpainting | BiRefNet + SDXL |
| `background_removal` | background_removal | BiRefNet (ONNX Runtime) |
| `upscale` | upscale | Real-ESRGAN ×4 (spandrel) |
| `relight` | relight (+ image_to_image opcional) | Depth Anything V2 (ONNX) → normales → luz direccional; refinado opcional con SDXL |

Inpainting y cambio de fondo se generan a resolución de trabajo y se recomponen sobre el
original a resolución completa: los píxeles fuera de la máscara quedan idénticos (hay un test
de punta a punta que lo verifica). Cada edición se guarda como asset nuevo con su padre en
`versions`; el original nunca se modifica.

### API del sidecar

| Método | Ruta | Uso |
| --- | --- | --- |
| GET | `/health` | Sin token. Readiness. |
| GET | `/hardware` | Perfil de ejecución. |
| GET | `/models` · POST `/models/{id}/download` | Gestor de modelos. |
| POST | `/analyze` | Intención + política + plan, sin ejecutar (vista previa en vivo de la UI). |
| POST | `/jobs` · GET `/jobs/{id}` · POST `/jobs/{id}/cancel` | Trabajos. |

### Procesamiento sin IA en Rust (`imaging.rs`, `brand.rs`)

Encuadre, formatos (PNG/JPG/WebP/ICO), vectorización (vtracer), paletas (k-means) y kits de
marca viven en el núcleo Rust: funcionan aunque el motor esté ocupado, no dependen de Python y
compilan igual en las tres plataformas. En desarrollo, las dependencias se compilan optimizadas
(`[profile.dev.package."*"]`) para que un kit tarde ~1 s en lugar de ~18 s.

### Reiluminación en vivo

El motor calcula una sola vez imagen + mapa de normales a tamaño de vista previa
(`POST /relight/prepare`); la UI aplica la luz en un canvas a cada movimiento
(`src/lib/relight.ts`). Al aplicar, el motor repite el mismo cálculo a resolución completa
(`pipelines/relight.py`). **Ambas fórmulas deben mantenerse idénticas.**

## Datos

Directorio de datos (macOS: `~/Library/Application Support/com.aicreativestudio.desktop/`):

```text
aics.db
projects/<id>/{originals,references,results,previews,exports}
models/      ← HF_HOME del motor (los modelos no van a ~/.cache)
tmp/         ← se limpia al iniciar
logs/engine.log
```

Tablas: `projects`, `assets`, `asset_references`, `jobs`, `versions`, `presets`, `persons`,
`settings`. `persons` sólo se usa en proyectos de fotografía con personas reales. (La tabla `consents`
quedó de versiones anteriores y ya no se usa: el consentimiento se gestiona fuera de la app.)

## Restauración (`pipelines/restore.py`)

`restore` encadena, según lo que elija el usuario: tono (niveles por percentiles) → rayas y polvo
(detección + LaMa) → ruido (SCUNet por bloques) → rostros (GFPGAN alineado a la plantilla FFHQ y
mezclado con el original) → color (DDColor sobre la luminancia original) → ampliación (Real-ESRGAN).
El modo **documental** usa menos intensidad en todo; el **creativo**, más.

Detección de daños: top-hat/black-hat sobre la imagen apenas suavizada, umbral adaptado al ruido
de la foto (MAD), y luego componentes conexas: se conservan rayas (largas y finas, medidas por ancho
local) y motas aisladas con contraste alto. Ojos, nariz y boca nunca se rellenan automáticamente.
La UI permite revisar y corregir la máscara (`/restore/detect`) antes de aplicar.

Los pesos de SCUNet y GFPGAN se descargan de sus releases oficiales de GitHub (`ModelSpec.urls`);
el resto, de Hugging Face.

## Producción (`src-tauri/src/batch.rs`)

Un **workflow** es una lista de pasos `job` (operación del motor) y `export` (formatos y tamaños).
Un **lote** aplica un workflow a N imágenes: el ejecutor en Rust procesa los elementos de uno en uno,
encadena la salida de cada paso como entrada del siguiente (cada resultado queda como versión de su
original), exporta a la carpeta del lote y emite `batch-update`. Si la app se cierra, los lotes en
curso se marcan como cancelados al reabrir.

## Photo Studio: personas reales

| Operación | Qué hace | Requiere |
| --- | --- | --- |
| `portrait_retouch` | Piel (separación de frecuencias) + looks de color. No genera píxeles nuevos. | YuNet |
| `identity_generate` | Fotos nuevas de una persona registrada (IP-Adapter Plus Face SDXL), con pose opcional. | Persona mayor de edad + referencias |
| `pose_change` | Recrea a la persona de una foto en otra pose (ControlNet OpenPose + IP-Adapter de apariencia y rostro). | Persona mayor de edad + referencias |

**Personas** (`src-tauri/src/persons.rs`): se registran una vez, declarando que son mayores de edad. El
consentimiento lo gestiona el usuario fuera de la app (por ejemplo, en papel). Rust verifica persona, edad
y referencias antes de enviar el trabajo, y el motor vuelve a verificar que haya persona y referencias.

**Referencias**: cada foto debe tener exactamente un rostro de ≥64 px y parecerse (SFace ≥ 0.363) a las
referencias existentes, para que no se mezclen personas.

**Trazabilidad**: `audit_log` registra alta de la persona, referencias, imágenes eliminadas y
cada trabajo con su identidad (operación y prompt).

**Validación** (`pipelines/faces.py`): en cada resultado con personas se miden rostros, similitud facial con
las referencias (SFace), nitidez y exposición. Los resultados se ordenan por similitud y, si se pide, se
descartan los que no superan el umbral de misma persona.

## Política de contenido

Se aplica en el motor antes del planner, no se puede desactivar desde la UI:

1. Nunca contenido sexual o desnudo que involucre menores.
2. Nunca desnudo o contenido sexual de una **persona real identificable** (imagen de entrada,
   referencias de identidad o persona registrada).
3. Nunca "quitar la ropa" a una imagen existente.
4. Con la identidad de una persona real (sesiones, cambio de pose) tampoco imágenes sugerentes, de ropa
   interior o de baño.

El desnudo artístico sólo existe con sujetos sintéticos generados desde texto; el resultado se
marca como `sensitive` y la UI lo muestra difuminado en las grillas.

La versión actual es léxica. En la Fase 4 la **Validation Layer** agrega un clasificador de la
imagen resultante y comparación facial contra `persons`, para cerrar el caso de nombres de
personas reales escritos en el prompt.

## Proveedores por suscripción

Cada trabajo puede ejecutarse con el motor local o con la CLI de una suscripción (ChatGPT vía Codex CLI,
Gemini vía Antigravity CLI). Claude Code sólo mejora prompts, porque su CLI no genera imágenes. El ajuste vive en
`settings` (`provider.images`, `provider.prompts`), Rust lo copia a `params` y el motor decide en
`JobManager._execute`. Detalles en [DEVELOPMENT.md](DEVELOPMENT.md#proveedores-por-suscripción-cli).

## Empaquetado y actualizaciones

El instalador lleva la app, `uv` y el código del motor; el entorno de Python se crea en el primer arranque
(ver `setup.rs`). Las releases y el actualizador firmado (`tauri-plugin-updater`) están descritos en
[DEVELOPMENT.md](DEVELOPMENT.md#releases-y-actualizaciones). Los modelos no se empaquetan: se descargan desde
el Gestor de modelos.
