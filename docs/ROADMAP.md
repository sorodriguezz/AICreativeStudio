# Roadmap

| Fase | Contenido | Estado |
| --- | --- | --- |
| 1 — Núcleo universal | Tauri + React + Rust, sidecar Python, proyectos, historial, jobs en background, Model Registry, Intent Router, Planner, perfiles de hardware | ✅ |
| 1+ — Texto a imagen | SDXL / SD 1.5, presets de estilo, formatos, variaciones, seed | ✅ |
| 2 — Edición base | img2img, inpainting con máscara (recompuesto sobre el original), cambio y eliminación de fondo, segmentación, upscale ×2/×4, importar imágenes, versiones | ✅ |
| 3 — Brand Studio + Enhance | transparencia, vectorización (vtracer), kits de marca, exportación multi-formato (favicon, RRSS, 16:9, ICO, SVG), reiluminación 2.5D con vista previa en vivo | ✅ |
| 4 — Photo Studio | retoque de retrato (piel + looks), personas con referencias, trazabilidad, sesiones con identidad (IP-Adapter), cambio de pose (DWPose + ControlNet + editor de esqueleto), validación (rostros, similitud facial, nitidez, exposición) | ✅ |
| 5 — Restauración y producción | restauración documental/creativa (rayas y polvo con revisión de máscara, SCUNet, GFPGAN, DDColor), borrar objetos (LaMa), extender imagen, workflows reutilizables, lotes con exportación | ✅ |
| 6 — Multiplataforma madura | instalador liviano + preparación del motor por hardware (Metal / CUDA según driver / CPU), paquetes de modelos por perfil con control de espacio, cola y reanudación de descargas, CI para macOS ARM64, Windows x64 y Windows ARM64 | ✅ macOS verificado · Windows por CI |

Pendiente de fases anteriores:
- Validación de anatomía/manos y clasificador del contenido de la imagen resultante (hoy la política es léxica + similitud facial).
- La detección automática de daños confunde algunos bordes rectos con rayas (~1–2 % de la imagen en fotos sanas): por eso la UI ofrece revisar la máscara antes de restaurar.
