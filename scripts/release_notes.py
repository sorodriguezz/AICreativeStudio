#!/usr/bin/env python3
"""Texto de la release: enlaces de descarga directos por sistema.

Uso: python3 scripts/release_notes.py <tag> <owner/repo>
"""

import sys

tag, repo = sys.argv[1], sys.argv[2]
base = f"https://github.com/{repo}/releases/download/{tag}"
print(f"""## Descarga AICreativeStudio {tag}

| Sistema | Instalador |
|---|---|
| macOS (Apple Silicon: M1, M2, M3, M4…) | [AICreativeStudio-macOS-AppleSilicon.dmg]({base}/AICreativeStudio-macOS-AppleSilicon.dmg) |
| Windows 10/11 (Intel o AMD, x64) | [AICreativeStudio-Windows-x64.exe]({base}/AICreativeStudio-Windows-x64.exe) |
| Windows 11 en ARM (Snapdragon) | [AICreativeStudio-Windows-ARM64.exe]({base}/AICreativeStudio-Windows-ARM64.exe) |

¿Ya tienes AICreativeStudio? Se actualiza sola: verás el aviso en la barra lateral o en **Configuración → Actualizaciones**.

**Primera vez en macOS:** si el sistema dice que no puede verificar la app, ve a *Ajustes del Sistema → Privacidad y seguridad* y pulsa **Abrir igualmente**. En Windows, SmartScreen puede pedir *Más información → Ejecutar de todas formas*.""")
