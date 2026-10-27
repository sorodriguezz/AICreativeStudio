"""Punto de entrada del sidecar.

    python -m aics_engine --port 8765 --token <secreto> --data-dir <dir> [--parent-pid N]
"""

from __future__ import annotations

import argparse
import os
import sys
import threading
import time
from pathlib import Path


def _watch_parent(parent_pid: int) -> None:
    """Termina el sidecar si el proceso de la app desaparece."""
    while True:
        time.sleep(2)
        if os.getppid() != parent_pid:
            os._exit(0)


def main() -> None:
    parser = argparse.ArgumentParser(prog="aics_engine")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--token", default=os.environ.get("AICS_TOKEN", ""))
    parser.add_argument("--data-dir", default=os.environ.get("AICS_DATA_DIR", ""))
    parser.add_argument("--parent-pid", type=int, default=0)
    args = parser.parse_args()

    data_dir = Path(args.data_dir or Path.home() / ".aicreativestudio").expanduser()
    data_dir.mkdir(parents=True, exist_ok=True)
    # Los modelos se descargan dentro del directorio de la app, no en ~/.cache.
    os.environ.setdefault("HF_HOME", str(data_dir / "models"))
    os.environ.setdefault("AICS_MODELS_DIR", str(data_dir / "models" / "direct"))
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

    if args.parent_pid:
        threading.Thread(target=_watch_parent, args=(args.parent_pid,), daemon=True).start()

    import uvicorn

    from .api import create_app

    app = create_app(token=args.token, data_dir=data_dir)
    print(f"AICS_ENGINE_READY port={args.port}", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    sys.exit(main())
