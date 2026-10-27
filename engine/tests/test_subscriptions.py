"""Proveedores por suscripción con CLIs falsas: no se llama a ningún servicio real."""

import os
import stat
import sys
import textwrap

import pytest
from PIL import Image

from aics_engine import intent, jobs, subscriptions
from aics_engine.pipelines.text_to_image import Cancelled

from test_core import FakeStore

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="las CLIs falsas son scripts POSIX")

FAKE_CODEX = textwrap.dedent(f"""\
    #!{sys.executable}
    import json, os, sys
    from pathlib import Path
    args = sys.argv[1:]
    if args[:2] == ["login", "status"]:
        print(os.environ.get("FAKE_LOGIN", "Logged in using ChatGPT")); sys.exit(0)
    if args == ["--version"]:
        print("codex-cli 9.9.9"); sys.exit(0)
    assert "OPENAI_API_KEY" not in os.environ, "la API key no debe llegar a la CLI"
    if "-o" in args:  # texto
        Path(args[args.index("-o") + 1]).write_text("a detailed prompt"); sys.exit(0)
    images = [args[i + 1] for i, a in enumerate(args) if a == "-i"]
    Path(os.environ["FAKE_ARGS"]).write_text(json.dumps(args))
    print(json.dumps({{"type": "thread.started", "thread_id": "t1"}}))
    if os.environ.get("FAKE_FAIL"):
        print(json.dumps({{"type": "turn.failed", "error": {{"message": "You've hit your usage limit"}}}})); sys.exit(1)
    folder = Path(os.environ["CODEX_HOME"]) / "generated_images" / "t1"
    folder.mkdir(parents=True, exist_ok=True)
    from PIL import Image
    Image.new("RGB", (64, 48), "red").save(folder / "exec-1.png")
    print(json.dumps({{"type": "item.completed", "item": {{"type": "agent_message", "text": "out_1.png"}}}}))
""")

FAKE_CLAUDE = textwrap.dedent(f"""\
    #!{sys.executable}
    import json, os, sys
    args = sys.argv[1:]
    if args[:2] == ["auth", "status"]:
        print(json.dumps({{"loggedIn": True, "authMethod": os.environ.get("FAKE_AUTH", "claude.ai")}})); sys.exit(0)
    if args == ["--version"]:
        print("1.0.0 (Claude Code)"); sys.exit(0)
    assert "ANTHROPIC_API_KEY" not in os.environ
    print(json.dumps({{"is_error": False, "result": "  cinematic portrait of a white wolf  "}}))
""")


@pytest.fixture
def fake_bin(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, body in (("codex", FAKE_CODEX), ("claude", FAKE_CLAUDE)):
        f = bin_dir / name
        f.write_text(body)
        f.chmod(f.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setattr(subscriptions, "_login_path", lambda: "")
    monkeypatch.setattr(subscriptions, "_env", None)
    monkeypatch.setattr(subscriptions, "_status_cache", None)
    monkeypatch.setattr(subscriptions.Path, "home", lambda: tmp_path / "home")
    monkeypatch.setenv("PATH", str(bin_dir) + os.pathsep + "/usr/bin" + os.pathsep + "/bin")
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex-home"))
    monkeypatch.setenv("FAKE_ARGS", str(tmp_path / "args.json"))
    monkeypatch.setenv("OPENAI_API_KEY", "sk-should-be-removed")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "should-be-removed")
    return tmp_path


def test_status_reports_subscription_login(fake_bin):
    by_id = {s["id"]: s for s in subscriptions.status(refresh=True)}
    assert by_id["codex"]["ready"] and by_id["codex"]["images"] and by_id["codex"]["version"] == "codex-cli 9.9.9"
    assert by_id["claude"]["ready"] and not by_id["claude"]["images"]
    assert not by_id["gemini"]["installed"] and "antigravity" in by_id["gemini"]["message"].lower()


def test_status_rejects_api_key_login(fake_bin, monkeypatch):
    monkeypatch.setenv("FAKE_LOGIN", "Logged in using an API key")
    monkeypatch.setenv("FAKE_AUTH", "api_key")
    monkeypatch.setattr(subscriptions, "_env", None)
    by_id = {s["id"]: s for s in subscriptions.status(refresh=True)}
    assert not by_id["codex"]["ready"] and "codex login" in by_id["codex"]["message"]
    assert not by_id["claude"]["ready"] and "claude.ai" in by_id["claude"]["message"]


def test_codex_generates_and_attaches_inputs(fake_bin):
    src = fake_bin / "in.png"
    Image.new("RGB", (8, 8)).save(src)
    files = subscriptions.generate_images("codex", "Create an image", [str(src)], fake_bin / "work",
                                          lambda f, m: None, lambda: False)
    assert len(files) == 1 and Image.open(files[0]).size == (64, 48)
    import json
    args = json.loads((fake_bin / "args.json").read_text())
    assert args[args.index("-i") + 1] == str(src) and "--ephemeral" in args


def test_codex_usage_limit_is_explained(fake_bin, monkeypatch):
    monkeypatch.setenv("FAKE_FAIL", "1")
    monkeypatch.setattr(subscriptions, "_env", None)
    with pytest.raises(subscriptions.ProviderError, match="límite de uso"):
        subscriptions.generate_images("codex", "x", [], fake_bin / "work", lambda f, m: None, lambda: False)


def test_claude_only_writes_text(fake_bin):
    assert subscriptions.complete_text("claude", "lobo") == "cinematic portrait of a white wolf"
    with pytest.raises(subscriptions.ProviderError, match="no genera imágenes"):
        subscriptions.generate_images("claude", "x", [], fake_bin / "w", lambda f, m: None, lambda: False)


def test_image_task_wording():
    t = subscriptions.image_task("inpainting", "un sombrero rojo", {}, 2, has_mask=True, refs=0, has_pose=False)
    assert "mask" in t and "un sombrero rojo" in t and "2 different variations" in t and "Never create nudity" in t
    t = subscriptions.image_task("identity_generate", "en la playa", {}, 1, has_mask=False, refs=3, has_pose=True)
    assert "same person" in t and "OpenPose" in t
    with pytest.raises(subscriptions.ProviderError):
        subscriptions.image_task("vectorize", "", {}, 1, has_mask=False, refs=0, has_pose=False)


def test_cloud_plan_needs_no_local_models():
    req = jobs.JobRequest(job_id="j", prompt="un lobo blanco", output_dir="/tmp", params={"provider": "codex"})
    _, pol, plan = jobs.analyze(req, FakeStore(set()))
    assert pol.allowed and plan.executable and plan.operation == "text_to_image"
    req.params = {}
    assert not jobs.analyze(req, FakeStore(set()))[2].executable


def test_cloud_still_obeys_local_policy():
    req = jobs.JobRequest(job_id="j", prompt="quitale la ropa", output_dir="/tmp", input_image="/x.png",
                          params={"provider": "codex", "operation": "image_to_image"})
    _, pol, plan = jobs.analyze(req, FakeStore(set()))
    assert not pol.allowed and plan is None


def test_job_runs_through_codex_end_to_end(fake_bin):
    manager = jobs.JobManager(FakeStore(set()))
    out = fake_bin / "project" / "results"
    out.mkdir(parents=True)
    req = jobs.JobRequest(job_id="job1", prompt="un lobo blanco", output_dir=str(out),
                          params={"provider": "codex", "prompt_provider": "claude", "count": 1})
    manager.submit(req)
    import time
    for _ in range(100):
        st = manager.get("job1")
        if st.status in ("completed", "failed"):
            break
        time.sleep(0.1)
    assert st.status == "completed", st.error
    assert st.outputs[0]["provider"] == "codex"
    assert st.outputs[0]["report"]["prompt_rewritten"] == "cinematic portrait of a white wolf"
    assert not (fake_bin / "project" / ".cli" / "job1").exists()


def test_cancel_kills_cli(fake_bin):
    slow = fake_bin / "bin" / "codex"
    slow.write_text(f"#!{sys.executable}\nimport time\ntime.sleep(30)\n")
    with pytest.raises(subscriptions.Cancelled):
        subscriptions.generate_images("codex", "x", [], fake_bin / "w", lambda f, m: None, lambda: True)
    assert Cancelled  # el JobManager traduce subscriptions.Cancelled a la excepción del pipeline
