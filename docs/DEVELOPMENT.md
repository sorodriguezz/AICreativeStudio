# Guía de desarrollo

## Requisitos

- Node 22+ y pnpm
- Rust estable (1.80+)
- [uv](https://docs.astral.sh/uv/) (instala Python 3.12 automáticamente)
- macOS: Xcode Command Line Tools · Windows: Visual Studio Build Tools + WebView2

## Puesta en marcha

```bash
pnpm install
pnpm engine:setup     # crea engine/.venv con la base + difusión (PyTorch, diffusers…; ~1–2 GB)
pnpm tauri dev
```

En desarrollo la app usa `engine/.venv`. En una instalación empaquetada, el motor se prepara en el primer
arranque (ver [Empaquetado](#empaquetado)).

Para iterar la UI sin motor, `pnpm dev` abierto en un navegador normal carga un backend simulado
(`src/lib/mock.ts`).

Para probar el flujo real sin descargar nada pesado, descarga **Tiny SD (pruebas)** en Modelos y elígelo en
*Opciones avanzadas → Modelo*: produce ruido de 64 px, pero recorre todo el pipeline.

## Modelos

Se descargan desde la app (Modelos → paquetes recomendados o uno a uno):

| Modelo | Tamaño | Para |
| --- | --- | --- |
| Stable Diffusion XL 1.0 | 6.9 GB | Crear, Brand Studio, Transformar, Pintar zona, Cambiar fondo, Extender |
| Stable Diffusion 1.5 | 2.1 GB | Lo mismo en equipos del perfil Compatible |
| SDXL Inpainting *(opcional)* | 6.9 GB | Rellenos y fondos más coherentes |
| BiRefNet Lite | 0.22 GB | Quitar fondo, Cambiar fondo, logos con fondo transparente |
| Real-ESRGAN ×4 | 0.07 GB | Ampliar ×2 / ×4, wallpapers 4K |
| Depth Anything V2 Small | 0.1 GB | Reiluminar |
| YuNet + SFace | 0.04 GB | Rostros, referencias y validación de identidad |
| DWPose | 0.13 GB | Copiar la pose de una foto |
| IP-Adapter Plus Face SDXL | 4.2 GB | Sesiones con identidad y cambio de pose |
| ControlNet OpenPose SDXL | 2.5 GB | Controlar la pose |
| LaMa | 0.21 GB | Borrar objetos, rayas y polvo |
| SCUNet | 0.07 GB | Reducir ruido (release oficial de GitHub) |
| GFPGAN v1.4 | 0.35 GB | Recuperar rostros (release oficial de GitHub) |
| DDColor tiny | 0.22 GB | Colorear fotos en blanco y negro |

Todos tienen licencias que permiten uso comercial (MIT, Apache-2.0, BSD, OpenRAIL). Se descartaron
InsightFace, InstantID, PhotoMaker, CodeFormer y RestoreFormer por ser sólo para uso no comercial.

## Tests

```bash
pnpm engine:test                                  # motor: router, política, planner, pipelines (pytest)
cargo test --manifest-path src-tauri/Cargo.toml   # núcleo: migraciones, jobs, imagen, kits, personas, lotes, instalación
pnpm build                                        # type-check + build del frontend
```

Los tests de `engine/tests/test_subscriptions.py` usan CLIs falsas: no gastan tu suscripción.

## Empaquetado

El instalador es liviano: lleva la app, `uv` y el código del motor con versiones exactas. En el primer
arranque, `src-tauri/src/setup.rs` crea un Python propio en `<datos>/runtime` e instala PyTorch en la
variante que corresponde al equipo:

| Equipo | PyTorch |
| --- | --- |
| Mac Apple Silicon | PyPI (Metal) |
| Windows x64 con NVIDIA | La CUDA más nueva que soporte el driver (`torch-variants.json`), luego CPU |
| Windows x64 sin NVIDIA, Windows ARM64 | CPU |
| Si PyTorch no se puede instalar | Modo compatible: el motor arranca sólo con modelos ONNX |

Al actualizar la app, si cambian las versiones empaquetadas, el entorno se actualiza solo.

```bash
pnpm bundle:prepare                 # exporta versiones exactas (engine/bundle) y copia uv para el host
pnpm tauri build                    # .app + .dmg en macOS, instalador NSIS en Windows
```

`beforeBuildCommand` ejecuta `prepare-bundle` automáticamente con el target de Tauri
(`pnpm tauri build --target aarch64-pc-windows-msvc`, etc.). Los builds de las tres plataformas corren en
GitHub Actions (ver *Releases y actualizaciones*).

## Releases y actualizaciones

- **[`ci.yml`](../.github/workflows/ci.yml)**: en cada PR y en cada push a `main`, ejecuta los tests del motor
  y de Rust, y compila la app en las 3 plataformas.
- **[`release.yml`](../.github/workflows/release.yml)**: al subir una etiqueta `vX.Y.Z`, crea un borrador de
  release y compila en runners nativos (`macos-15`, `windows-latest`, `windows-11-arm`). Cada uno sube su
  instalador y su paquete de actualización **firmado** (ed25519). Cuando están los tres, reconstruye
  `latest.json` con `scripts/updater_manifest.py`, sube copias con nombre fijo por sistema
  (`scripts/stable_names.py`) y publica. El texto de la release (`scripts/release_notes.py`) tiene una tabla
  con la descarga de cada sistema.
- **Descarga por sistema**: `https://github.com/sorodriguezz/AICreativeStudio/releases/latest/download/`
  + `AICreativeStudio-macOS-AppleSilicon.dmg`, `AICreativeStudio-Windows-x64.exe` o
  `AICreativeStudio-Windows-ARM64.exe` siempre baja la última versión (son los enlaces del README).
- **En la app** (`src/lib/updates.ts`, `UpdateNotice`, *Configuración → Actualizaciones*): busca versión nueva
  4 s después de abrir y cada 6 h. Si la hay, muestra un aviso en la barra lateral con el progreso de la
  descarga. Si hay trabajos en curso no instala; si no, detiene el motor, verifica la firma, instala y reinicia.

Configuración inicial (una sola vez):

1. Crea el repo `github.com/sorodriguezz/AICreativeStudio`. Si usas otro nombre, cambia
   `plugins.updater.endpoints` en `src-tauri/tauri.conf.json` y los enlaces del README.
2. En *Settings → Secrets and variables → Actions*, añade `TAURI_SIGNING_PRIVATE_KEY` con el contenido de
   `~/.tauri/aicreativestudio.key` y `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` vacío. **No pierdas esa clave**: sin
   ella, las versiones instaladas no aceptarán actualizaciones nuevas. La pública ya está en `tauri.conf.json`.
3. Opcional: los secretos de firma de Apple y Windows listados al inicio de `release.yml`.

Publicar una versión:

```bash
python3 scripts/bump_version.py 0.7.0
```

```bash
git commit -am "Release v0.7.0" && git tag -a v0.7.0 -m v0.7.0 && git push --follow-tags
```

`createUpdaterArtifacts` sólo se activa en CI (`src-tauri/tauri.release.json`), así un `pnpm tauri build`
local no necesita la clave privada.

## Proveedores por suscripción (CLI)

`engine/src/aics_engine/subscriptions.py` puede reemplazar al motor local usando la **CLI oficial** con la
sesión del usuario, nunca una API key (las variables `*_API_KEY` se quitan del entorno del proceso hijo, y el
estado rechaza una CLI autenticada por API key):

| Proveedor | CLI | Login | Puede |
| --- | --- | --- | --- |
| ChatGPT | `codex` (Codex CLI) | `codex login` con la cuenta de ChatGPT | Imágenes (herramienta `image_generation`) y texto |
| Gemini | `agy` (Antigravity CLI) | abrir `agy` y entrar con Google | Imágenes (subagente, experimental y lento) y texto |
| Claude | `claude` (Claude Code) | `claude` → `/login` con claude.ai | Sólo texto: mejora los prompts |

La antigua Gemini CLI (`gemini`) ya no acepta cuentas personales: Google la reemplazó por Antigravity.

En *Configuración → Proveedores de IA* se elige quién genera las imágenes (`provider.images`: `local`,
`codex`, `gemini`) y quién mejora los prompts (`provider.prompts`: `none`, `claude`, `codex`, `gemini`).
`jobs::apply_provider` añade esos ajustes a los `params` de cada trabajo y de `/analyze`. En el motor, con un
proveedor de suscripción el plan es ejecutable sin modelos locales y `JobManager._cloud` arma la
instrucción (`subscriptions.image_task`), adjunta la imagen de entrada, la máscara, las referencias de la
persona y el esqueleto de la pose, y recoge los PNG que deja la CLI. La política de contenido local se evalúa
antes, igual que con el motor local.

Si `pnpm tauri dev` está abierto, compila el instalador en otra carpeta para que no compitan:
`CARGO_TARGET_DIR=/tmp/aics-release pnpm tauri build --target aarch64-apple-darwin`.

Para probar una instalación limpia sin tocar tus datos reales:

```bash
AICS_DATA_DIR=/tmp/aics-limpio "src-tauri/target/aarch64-apple-darwin/release/bundle/macos/AICreativeStudio.app/Contents/MacOS/aicreativestudio"
```

## Estructura

```text
AICreativeStudio/
├── src/                    UI (React + TS)
│   ├── pages/              Crear/Brand, Editar, Mejorar, Restaurar, Photo Studio, Biblioteca, Historial, Producción, Modelos…
│   ├── components/         visor, compositor, máscaras, comparador, exportar, kits, personas, poses…
│   └── lib/                cliente de comandos Tauri, hooks, simulador para el navegador
├── src-tauri/              núcleo nativo (Rust)
│   └── src/
│       ├── db.rs           SQLite: esquema, migraciones, consultas
│       ├── engine.rs       lanza/supervisa el motor y le habla por HTTP local
│       ├── setup.rs        preparación del motor en el primer arranque
│       ├── jobs.rs         crea trabajos, los sigue y registra resultados
│       ├── imaging.rs      formatos, encuadre, íconos, paletas, vectorización
│       ├── brand.rs        kits de marca
│       ├── persons.rs      personas, referencias y trazabilidad
│       ├── batch.rs        workflows y lotes
│       └── commands.rs     API para la UI
├── engine/                 motor de IA (Python)
│   └── src/aics_engine/
│       ├── intent.py       Intent Router
│       ├── planner.py      operaciones → capacidades → modelos
│       ├── policy.py       política de contenido (no configurable)
│       ├── registry.py     modelos, paquetes por perfil, cola de descargas
│       ├── hardware.py     detección y perfiles
│       ├── runtime.py      carga de modelos por dispositivo
│       ├── jobs.py         cola de trabajos
│       └── pipelines/      generación, edición, reiluminación, rostros, pose, retoque, restauración
├── scripts/                preparación del empaquetado
└── docs/                   arquitectura, roadmap y esta guía
```

Más detalle en [ARCHITECTURE.md](ARCHITECTURE.md).
