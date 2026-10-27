#!/usr/bin/env python3
"""Elige los instaladores de una release y les da un nombre fijo por sistema.

Con nombre fijo, https://github.com/<repo>/releases/latest/download/<nombre> siempre descarga la
última versión para ese sistema (los enlaces del README y de la release usan esos nombres).

Uso: python3 scripts/stable_names.py assets.txt   (líneas "<id> <nombre>")  →  imprime "<id> <nombre-fijo>"
"""

import sys

# nombre fijo -> sufijo del instalador que genera Tauri
STABLE = {
    "AICreativeStudio-macOS-AppleSilicon.dmg": "_aarch64.dmg",
    "AICreativeStudio-Windows-x64.exe": "_x64-setup.exe",
    "AICreativeStudio-Windows-ARM64.exe": "_arm64-setup.exe",
}


def pick(lines: list[str]) -> list[tuple[str, str]]:
    assets = [line.split(maxsplit=1) for line in lines if line.strip()]
    names = {name for _, name in assets}
    out = []
    for stable, suffix in STABLE.items():
        if stable in names:
            continue  # ya subido (reintento del job)
        match = next((aid for aid, name in assets if name.endswith(suffix)), None)
        if match:
            out.append((match, stable))
    return out


if __name__ == "__main__":
    for aid, name in pick(open(sys.argv[1]).read().splitlines()):
        print(aid, name)
