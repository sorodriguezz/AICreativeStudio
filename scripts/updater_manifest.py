#!/usr/bin/env python3
"""Escribe latest.json para el actualizador de Tauri a partir de los paquetes firmados de una release.

Cada sistema del matrix fusiona su entrada en latest.json a la vez, y dos que terminan juntos
pueden perder una. Reconstruirlo desde los .sig de la release no tiene esa carrera.

Uso: python3 scripts/updater_manifest.py <tag> <owner/repo> <carpeta-con-.sig>
"""

import json
import sys
import time
from pathlib import Path

# clave de plataforma del actualizador -> sufijo del paquete que instala
BUNDLES = {
    "darwin-aarch64": "aarch64.app.tar.gz",
    "darwin-aarch64-app": "aarch64.app.tar.gz",
    "windows-x86_64": "x64-setup.exe",
    "windows-x86_64-nsis": "x64-setup.exe",
    "windows-aarch64": "arm64-setup.exe",
    "windows-aarch64-nsis": "arm64-setup.exe",
}
REQUIRED = ("darwin-aarch64", "windows-x86_64", "windows-aarch64")


def build(tag: str, repo: str, sigs: dict[str, str]) -> dict:
    platforms = {}
    for key, suffix in BUNDLES.items():
        name = next((n for n in sorted(sigs) if n.endswith(suffix)), None)
        if name:
            platforms[key] = {"signature": sigs[name], "url": f"https://github.com/{repo}/releases/download/{tag}/{name}"}
    missing = [k for k in REQUIRED if k not in platforms]
    if missing:
        raise SystemExit(f"faltan paquetes firmados para: {', '.join(missing)}")
    return {"version": tag.lstrip("v"), "notes": f"AICreativeStudio {tag}",
            "pub_date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "platforms": platforms}


def main() -> None:
    tag, repo, folder = sys.argv[1], sys.argv[2], Path(sys.argv[3])
    sigs = {p.name[: -len(".sig")]: p.read_text().strip() for p in folder.glob("*.sig")}
    manifest = build(tag, repo, sigs)
    Path("latest.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
