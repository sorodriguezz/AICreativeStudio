"""Proveedores por suscripción: usan la CLI oficial con la sesión del usuario, nunca una API key.

    codex   ChatGPT (Codex CLI, `codex login` con la cuenta de ChatGPT) — genera y edita imágenes y texto.
    gemini  Gemini (Antigravity CLI `agy`, cuenta de Google) — genera imágenes (experimental) y texto.
    claude  Claude (Claude Code, `claude` con la cuenta de claude.ai) — sólo texto: mejora los prompts.

La política de contenido local se evalúa antes de llegar aquí, igual que con el motor local.
Las variables de API key se quitan del entorno del proceso hijo para que la CLI use la suscripción.
"""

from __future__ import annotations

import getpass
import json
import os
import platform
import shutil
import subprocess
import tempfile
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable

# Si alguna de estas existe, la CLI cobraría por API en vez de usar la suscripción.
API_KEY_VARS = ("OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "GEMINI_API_KEY",
                "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX")
IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp")


@dataclass(frozen=True)
class Provider:
    id: str
    label: str
    binary: str
    images: bool
    login_hint: str
    install_hint: str


PROVIDERS = {
    "codex": Provider("codex", "ChatGPT", "codex", True, "Ejecuta `codex login` y entra con tu cuenta de ChatGPT.",
                      "Instala Codex CLI: npm install -g @openai/codex"),
    "gemini": Provider("gemini", "Gemini", "agy", True, "Abre `agy` una vez y entra con tu cuenta de Google.",
                       "Instala Antigravity CLI desde antigravity.google"),
    "claude": Provider("claude", "Claude", "claude", False, "Ejecuta `claude` y entra con tu cuenta de claude.ai (/login).",
                       "Instala Claude Code: npm install -g @anthropic-ai/claude-code"),
}


class ProviderError(RuntimeError):
    pass


class Cancelled(Exception):
    pass


# ---------- Entorno ----------

_env_lock = threading.Lock()
_env: dict | None = None


def _login_path() -> str:
    """PATH del shell de login: una app de escritorio arranca con un PATH mínimo."""
    if platform.system() == "Windows":
        return ""
    shell = os.environ.get("SHELL") or "/bin/zsh"
    try:
        out = subprocess.run([shell, "-lic", "printf '__AICS__%s' \"$PATH\""], capture_output=True, text=True, timeout=10,
                             stdin=subprocess.DEVNULL).stdout
        return out.rsplit("__AICS__", 1)[1].strip() if "__AICS__" in out else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def child_env() -> dict:
    global _env
    with _env_lock:
        if _env is None:
            home = Path.home()
            extra = [str(home / ".local" / "bin"), "/opt/homebrew/bin", "/usr/local/bin", str(home / ".npm-global" / "bin")]
            if platform.system() == "Windows":
                appdata = os.environ.get("APPDATA", "")
                extra = [str(Path(appdata) / "npm"), str(home / ".local" / "bin"), str(home / "AppData" / "Local" / "Programs")]
            parts = [p for p in (_login_path() + os.pathsep + os.environ.get("PATH", "")).split(os.pathsep) if p] + extra
            env = {k: v for k, v in os.environ.items() if k not in API_KEY_VARS}
            env["PATH"] = os.pathsep.join(dict.fromkeys(parts))
            env.setdefault("NO_COLOR", "1")
            # Claude Code busca su sesión en el llavero por usuario; sin USER la da por cerrada.
            try:
                user = getpass.getuser()
                env.setdefault("USER", user)
                env.setdefault("LOGNAME", user)
            except (OSError, KeyError):
                pass
            _env = env
        return dict(_env)


def which(binary: str) -> str | None:
    return shutil.which(binary, path=child_env()["PATH"])


def _run(args: list[str], timeout: float = 20, cwd: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=child_env(), cwd=cwd,
                          stdin=subprocess.DEVNULL, encoding="utf-8", errors="replace")


# ---------- Estado ----------

@dataclass
class ProviderStatus:
    id: str
    label: str
    images: bool
    installed: bool = False
    path: str | None = None
    version: str | None = None
    ready: bool = False
    account: str | None = None
    message: str = ""
    experimental: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


def _check_login(p: Provider, exe: str) -> tuple[bool, str | None, str]:
    """(lista, cuenta, mensaje). Rechaza el acceso por API key: el usuario quiere su suscripción."""
    if p.id == "codex":
        out = _run([exe, "login", "status"])
        text = (out.stdout + out.stderr).strip()
        if "ChatGPT" in text:
            return True, "Cuenta de ChatGPT", "Sesión iniciada con tu suscripción."
        if "API key" in text:
            return False, None, "Codex está usando una API key. Ejecuta `codex logout` y luego `codex login` con tu cuenta de ChatGPT."
        return False, None, p.login_hint
    if p.id == "claude":
        out = _run([exe, "auth", "status"])
        try:
            data = json.loads(out.stdout)
        except ValueError:
            data = {}
        if data.get("loggedIn") and data.get("authMethod") in ("claude.ai", "oauth", "subscription"):
            return True, data.get("email") or "Cuenta de claude.ai", "Sesión iniciada con tu suscripción."
        if data.get("loggedIn"):
            return False, None, "Claude Code está usando una API key. Entra con tu cuenta de claude.ai (/login)."
        return False, None, p.login_hint
    # Antigravity no tiene "status": listar modelos sólo funciona con sesión iniciada.
    out = _run([exe, "models"], timeout=40)
    if out.returncode == 0 and "gemini" in out.stdout.lower():
        return True, "Cuenta de Google", "Sesión iniciada. La generación de imágenes es experimental y lenta (varios minutos)."
    return False, None, p.login_hint


_status_cache: tuple[float, list[dict]] | None = None


def status(refresh: bool = False) -> list[dict]:
    global _status_cache
    if _status_cache and not refresh and time.time() - _status_cache[0] < 120:
        return _status_cache[1]
    result = []
    for p in PROVIDERS.values():
        st = ProviderStatus(p.id, p.label, p.images, experimental=p.id == "gemini")
        exe = which(p.binary)
        if not exe:
            st.message = p.install_hint
        else:
            st.installed, st.path = True, exe
            try:
                v = _run([exe, "--version"])
                st.version = (v.stdout or v.stderr).strip().splitlines()[0][:60] if (v.stdout or v.stderr).strip() else None
                st.ready, st.account, st.message = _check_login(p, exe)
            except (OSError, subprocess.SubprocessError) as exc:
                st.message = f"No se pudo consultar la CLI: {exc}"
        result.append(st.to_dict())
    _status_cache = (time.time(), result)
    return result


def get(provider_id: str) -> tuple[Provider, str]:
    p = PROVIDERS.get(provider_id)
    if not p:
        raise ProviderError(f"Proveedor desconocido: {provider_id}")
    exe = which(p.binary)
    if not exe:
        raise ProviderError(f"No se encontró la CLI de {p.label}. {p.install_hint}")
    return p, exe


# ---------- Instrucciones ----------

SAFETY = ("Never create nudity, sexual or suggestive content, never remove or reduce clothing, "
          "and never depict minors in any sensitive way. ")


def image_task(op: str, prompt: str, params: dict, count: int, *, has_mask: bool, refs: int, has_pose: bool,
               lighting: str | None = None) -> str:
    """Instrucción en inglés para la herramienta de imágenes de la CLI. Las imágenes adjuntas van en orden fijo:
    [imagen de entrada] [máscara] [referencias de identidad…] [pose]."""
    user = prompt.strip()
    aspect = params.get("aspect")
    keep = "Keep everything else identical: composition, framing, identity, colors and resolution as close as possible. "
    if op == "text_to_image":
        task = f"Create an image: {user}." + (f" Aspect ratio {aspect}." if aspect else "")
        if params.get("transparent"):
            task += " Transparent background (PNG with alpha)."
    elif op == "image_to_image":
        task = f"Edit the first attached image: {user}. Keep the main subject and composition recognizable."
    elif op in ("inpainting", "erase"):
        what = f"replace it with: {user}" if op == "inpainting" and user else "remove what is there and fill it so it blends naturally with the surroundings"
        task = (f"Edit the first attached image. The second attached image is a mask: change ONLY the area that is white in the mask and {what}. "
                + keep)
    elif op == "outpaint":
        sides = ", ".join(f"{k} by {round(float(params.get(f'expand_{k}') or 0) * 100)}%" for k in ("left", "right", "top", "bottom")
                          if float(params.get(f"expand_{k}") or 0) > 0)
        task = f"Extend the canvas of the attached image ({sides}) continuing the scene seamlessly. {user}"
    elif op == "background_removal":
        task = "Cut out the main subject of the attached image and output it on a fully transparent background (PNG with alpha). Do not alter the subject."
    elif op == "background_replace":
        task = f"Replace only the background of the attached image with: {user}. Keep the subject pixel-identical, with matching light."
    elif op == "upscale":
        task = (f"Produce a sharper, higher-resolution version (about {params.get('scale') or 2}x) of the attached image. "
                "Faithful restoration only: do not add, remove or reinterpret any content.")
    elif op == "relight":
        task = f"Relight the attached photo: {lighting or 'soft natural light'}. {user} " + keep
    elif op == "portrait_retouch":
        look = params.get("look", "natural")
        task = (f"Professionally retouch the attached portrait with a {look} look: smooth skin about {round(float(params.get('skin', 0.5)) * 100)}% "
                "while keeping pores and texture, even out skin tone, clean color. The person's identity, face shape, body and clothing must not change.")
    elif op in ("denoise", "face_restore", "restore"):
        colorize = " If it is black and white, colorize it naturally." if params.get("colorize") or params.get("force_colorize") else ""
        task = ("Restore the attached photo: remove noise, scratches, dust and stains, recover contrast and sharpen faces faithfully "
                f"without changing who the people are.{colorize} " + keep)
    elif op == "identity_generate":
        task = (f"The attached reference photos show one real adult person. Create a new photo of that same person: {user}. "
                "The face must be clearly the same person.")
    elif op == "pose_change":
        task = (f"The first attached image shows a person; the reference photos show their face. Create a new photo of the same person, "
                f"same clothing and hairstyle, in a new pose. {user}")
    else:
        raise ProviderError(f"Esta operación no está disponible con la suscripción: {op}")
    if refs and op not in ("identity_generate", "pose_change"):
        task += f" The following {refs} attached photos are references of the person's face."
    if has_pose:
        task += " The last attached image is an OpenPose skeleton: the person must take exactly that body pose."
    many = f"Generate {count} different variations." if count > 1 else "Generate one image."
    return f"{SAFETY}{task} {many}"


def prompt_task(prompt: str, op: str) -> str:
    return ("Rewrite this request as a single, detailed English prompt for an image model. Keep the user's intent, subject and "
            "every concrete detail; add composition, lighting, lens and style details only when they help. "
            f"{SAFETY}Operation: {op}. Reply with the prompt only, no quotes, no preamble.\n\nRequest: {prompt.strip()}")


# ---------- Ejecución ----------

Progress = Callable[[float, str], None]


def _watch(proc: subprocess.Popen, cancelled: Callable[[], bool], timeout: float, on_tick: Callable[[float], None]) -> None:
    start = time.time()
    while proc.poll() is None:
        if cancelled():
            proc.kill()
            raise Cancelled()
        if time.time() - start > timeout:
            proc.kill()
            raise ProviderError("La CLI tardó demasiado y se canceló.")
        on_tick(time.time() - start)
        time.sleep(0.5)


def _collect(folder: Path, since: float) -> list[Path]:
    if not folder.is_dir():
        return []
    files = [f for f in folder.rglob("*") if f.suffix.lower() in IMAGE_EXT and f.stat().st_mtime >= since - 1]
    return sorted(files, key=lambda f: f.stat().st_mtime)


def _error_from(text: str, p: Provider) -> str:
    low, label = text.lower(), p.label
    if "usage limit" in low or "rate limit" in low or "quota" in low or "429" in low:
        return f"Alcanzaste el límite de uso de tu suscripción de {label}. Espera un rato o usa el motor local."
    if "not logged" in low or ("login" in low and "error" in low) or "unauthorized" in low or "401" in low:
        return f"La CLI de {label} no tiene sesión iniciada. {p.login_hint}"
    if "refus" in low or "policy" in low or "safety" in low or "can't help" in low or "cannot help" in low:
        return f"{label} rechazó la solicitud por su política de contenido."
    tail = text.strip().splitlines()[-1][:300] if text.strip() else "sin detalles"
    return f"La CLI de {label} falló: {tail}"


def generate_images(provider_id: str, task: str, inputs: list[str], workdir: Path, progress: Progress,
                    cancelled: Callable[[], bool], expected: int = 1) -> list[Path]:
    p, exe = get(provider_id)
    if not p.images:
        raise ProviderError(f"{p.label} no genera imágenes desde su CLI. Elige ChatGPT, Gemini o el motor local.")
    workdir.mkdir(parents=True, exist_ok=True)
    started = time.time()
    names = " ".join(f"out_{i + 1}.png" for i in range(expected))
    save = f" Save the final image file(s) in the current working directory as {names}. Do not ask questions; reply only with the file names."
    eta = 90 * expected if p.id == "codex" else 300 * expected
    tick = lambda s: progress(min(0.9, 0.05 + 0.85 * s / eta), f"{p.label} está generando… {int(s)} s")  # noqa: E731
    progress(0.03, f"Enviando a {p.label}…")

    if p.id == "codex":
        args = [exe, "exec", "--skip-git-repo-check", "--ephemeral", "--json", "-s", "workspace-write", "-C", str(workdir)]
        for path in inputs:
            args += ["-i", path]
        args += ["--", task + save]
        log = workdir / "codex.jsonl"
        with open(log, "w", encoding="utf-8") as out, open(workdir / "codex.err", "w", encoding="utf-8") as err:
            proc = subprocess.Popen(args, stdout=out, stderr=err, stdin=subprocess.DEVNULL, env=child_env(), cwd=workdir)
            _watch(proc, cancelled, 900, tick)
        thread, message, failure = None, "", ""
        for line in log.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("type") == "thread.started":
                thread = ev.get("thread_id")
            item = ev.get("item") or {}
            if item.get("type") == "agent_message":
                message = item.get("text", "")
            if ev.get("type") in ("error", "turn.failed"):
                failure = json.dumps(ev.get("error") or ev.get("message") or ev)
        found = _collect(workdir, started)
        if not found and thread:  # la herramienta deja las imágenes en ~/.codex/generated_images/<hilo>/
            codex_home = Path(child_env().get("CODEX_HOME") or Path.home() / ".codex")
            found = _collect(codex_home / "generated_images" / thread, started)
        if not found:
            raise ProviderError(_error_from(failure or message or (workdir / "codex.err").read_text(errors="replace"), p))
        return found

    # Antigravity (Gemini): el agente ve los archivos adjuntos por ruta dentro del espacio de trabajo.
    for i, path in enumerate(inputs):
        dest = workdir / f"input_{i + 1}{Path(path).suffix or '.png'}"
        shutil.copy(path, dest)
    attached = " ".join(f"input_{i + 1}{Path(x).suffix or '.png'}" for i, x in enumerate(inputs))
    prompt = task + (f" The attached images are, in order: {attached} (in the current directory)." if inputs else "") + save
    args = [exe, "-p", prompt, "--output-format", "json", "--dangerously-skip-permissions", "--add-dir", str(workdir)]
    with open(workdir / "agy.json", "w", encoding="utf-8") as out, open(workdir / "agy.err", "w", encoding="utf-8") as err:
        proc = subprocess.Popen(args, stdout=out, stderr=err, stdin=subprocess.DEVNULL, env=child_env(), cwd=workdir)
        _watch(proc, cancelled, 1500, tick)
    found = [f for f in _collect(workdir, started) if not f.name.startswith("input_")]
    if not found:
        raw = (workdir / "agy.json").read_text(errors="replace") + (workdir / "agy.err").read_text(errors="replace")
        raise ProviderError(_error_from(raw, p))
    return found


def complete_text(provider_id: str, prompt: str, timeout: float = 180) -> str:
    """Respuesta de texto de una sola vuelta (sin herramientas)."""
    p, exe = get(provider_id)
    with tempfile.TemporaryDirectory(prefix="aics-cli-") as tmp:
        if p.id == "claude":
            out = _run([exe, "-p", prompt, "--output-format", "json", "--tools", "", "--no-session-persistence"], timeout=timeout, cwd=tmp)
            try:
                data = json.loads(out.stdout)
            except ValueError:
                raise ProviderError(_error_from(out.stdout + out.stderr, p)) from None
            if data.get("is_error"):
                raise ProviderError(_error_from(str(data.get("result")), p))
            return str(data.get("result", "")).strip()
        if p.id == "codex":
            last = Path(tmp) / "last.txt"
            out = _run([exe, "exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-C", tmp, "-o", str(last), "--", prompt],
                       timeout=timeout, cwd=tmp)
            if not last.is_file() or not last.read_text().strip():
                raise ProviderError(_error_from(out.stdout + out.stderr, p))
            return last.read_text().strip()
        out = _run([exe, "-p", prompt, "--output-format", "json"], timeout=timeout, cwd=tmp)
        try:
            return str(json.loads(out.stdout).get("response", "")).strip() or _raise(_error_from(out.stderr, p))
        except ValueError:
            raise ProviderError(_error_from(out.stdout + out.stderr, p)) from None


def _raise(msg: str):
    raise ProviderError(msg)

