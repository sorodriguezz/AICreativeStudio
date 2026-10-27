#!/usr/bin/env python3
"""Cambia la versión de la app en todos los sitios donde se declara.

Uso: python3 scripts/bump_version.py 0.7.0
Después: git commit -am "Release v0.7.0" && git tag v0.7.0 && git push --follow-tags
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    if len(sys.argv) != 2 or not re.fullmatch(r"\d+\.\d+\.\d+", sys.argv[1]):
        raise SystemExit("uso: bump_version.py X.Y.Z")
    v = sys.argv[1]

    for path in (ROOT / "src-tauri/tauri.conf.json", ROOT / "package.json"):
        data = json.loads(path.read_text())
        data["version"] = v
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")

    for path in (ROOT / "src-tauri/Cargo.toml", ROOT / "engine/pyproject.toml"):
        path.write_text(re.sub(r'(?m)^version = "[^"]+"', f'version = "{v}"', path.read_text(), count=1))

    init = ROOT / "engine/src/aics_engine/__init__.py"
    init.write_text(re.sub(r'__version__ = "[^"]+"', f'__version__ = "{v}"', init.read_text()))

    print(f"versión {v}")
    print(f'siguiente: git commit -am "Release v{v}" && git tag v{v} && git push --follow-tags')


if __name__ == "__main__":
    main()
