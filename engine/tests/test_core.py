import pytest

from aics_engine import intent, planner, policy, registry
from aics_engine.pipelines.text_to_image import resolve_size


class FakeStore(registry.ModelStore):
    def __init__(self, installed: set[str]):
        super().__init__()
        self.installed = installed

    def is_installed(self, spec):
        return spec.id in self.installed


def test_intent_brand_logo():
    it = intent.classify("Diseña un logo minimalista para una cafetería")
    assert it.domain == "brand"
    assert it.output == "logo"
    assert "logo_design" in it.tasks
    assert it.aspect == "1:1"


def test_intent_create_wallpaper():
    it = intent.classify("Crea un wallpaper 4K cyberpunk")
    assert it.domain == "create"
    assert it.tasks == ["text_to_image", "upscale"]
    assert it.aspect == "16:9"


def test_intent_edit_with_image():
    it = intent.classify("Cambia el fondo por una playa", has_input_image=True)
    assert it.domain == "edit"
    assert "background_replace" in it.tasks


def test_intent_photo_pose_identity():
    it = intent.classify("Cambia la pose y mejora la iluminación conservando su identidad", has_input_image=True)
    assert "pose_change" in it.tasks and "relight" in it.tasks
    assert "high_fidelity" in it.constraints and "identity" in it.constraints


def test_policy_blocks_real_person_nudity():
    r = policy.evaluate("desnudo artístico en estudio", identity_references=2)
    assert not r.allowed and r.rule == "real_person_nudity"
    r = policy.evaluate("hazla desnuda", has_input_image=True)
    assert not r.allowed


def test_policy_blocks_undress_and_minors():
    assert policy.evaluate("quita la ropa", has_input_image=True).rule == "undress"
    assert policy.evaluate("niña desnuda").rule == "minors"


def test_policy_allows_synthetic_art_nude_as_sensitive():
    r = policy.evaluate("desnudo artístico clásico, escultura de mármol")
    assert r.allowed and r.rating == "sensitive"
    assert policy.evaluate("un lobo blanco en la nieve").rating == "general"


def test_planner_requires_installed_model():
    it = intent.classify("un lobo blanco en una montaña nevada")
    plan = planner.build(it, "un lobo blanco", profile="balanced", store=FakeStore(set()))
    assert not plan.executable and plan.steps[0].model_id == "sdxl-base"
    plan = planner.build(it, "un lobo blanco", profile="balanced", store=FakeStore({"sdxl-base"}))
    assert plan.executable


def test_planner_compatible_profile_prefers_sd15():
    it = intent.classify("un paisaje")
    plan = planner.build(it, "un paisaje", profile="compatible", store=FakeStore({"sd15", "sdxl-base"}))
    assert plan.steps[0].model_id == "sd15"


def test_planner_optional_followups_do_not_block():
    it = intent.classify("logo para una cafetería")
    plan = planner.build(it, "logo para una cafetería", store=FakeStore({"sdxl-base"}))
    assert plan.executable
    assert "logo design" in plan.prompt


def test_planner_unavailable_task():
    it = intent.classify("Restaura esta foto antigua", has_input_image=True)
    plan = planner.build(it, "Restaura esta foto antigua", store=FakeStore({"sdxl-base"}), has_input_image=True)
    assert not plan.executable


def test_resolve_size():
    assert resolve_size("1:1", 1024, 1024) == (1024, 1024)
    w, h = resolve_size("16:9", 1024, 1536)
    assert w % 64 == 0 and h % 64 == 0 and w > h
    assert max(resolve_size("16:9", 1024, 640)) <= 640


def test_intent_enhance_face():
    it = intent.classify("Mejora el rostro sin cambiarlo", has_input_image=True)
    assert it.domain == "enhance" and it.tasks == ["face_restore"]


ALL_EDIT = {"sdxl-base", "birefnet-lite", "realesrgan-x4"}


def edit_plan(prompt, installed=ALL_EDIT, **kw):
    it = intent.classify(prompt, has_input_image=True)
    return planner.build(it, prompt, store=FakeStore(set(installed)), has_input_image=True, **kw)


def test_edit_operations_resolve_from_prompt():
    assert edit_plan("Cambia el fondo por una playa").operation == "background_replace"
    assert edit_plan("Quita el fondo").operation == "background_removal"
    assert edit_plan("Llévala a 4K").operation == "upscale"
    assert edit_plan("Hazla estilo acuarela").operation == "image_to_image"
    assert edit_plan("pon un sombrero rojo", has_mask=True).operation == "inpainting"


def test_background_replace_needs_segmentation_and_inpainting():
    plan = edit_plan("Cambia el fondo por una playa")
    assert [s.op for s in plan.steps] == ["background_removal", "inpainting"]
    assert plan.executable
    plan = edit_plan("Cambia el fondo por una playa", installed={"sdxl-base"})
    assert not plan.executable and "BiRefNet" in plan.warnings[0]


def test_optional_inpaint_model_is_preferred_only_when_installed():
    assert edit_plan("x", has_mask=True).step("inpainting").model_id == "sdxl-base"
    assert edit_plan("x", installed=ALL_EDIT | {"sdxl-inpaint"}, has_mask=True).step("inpainting").model_id == "sdxl-inpaint"
    assert edit_plan("x", installed=set(), has_mask=True).step("inpainting").model_id == "sdxl-base"


def test_promptless_operations_and_prompt_required():
    assert edit_plan("", operation="upscale").executable
    assert edit_plan("", operation="background_removal").executable
    assert not edit_plan("", operation="image_to_image").executable


def test_unsupported_edit_is_reported_not_silently_replaced():
    plan = edit_plan("Cambia la pose de la modelo")
    assert not plan.executable
    assert edit_plan("Cambia la pose de la modelo", operation="image_to_image").executable


def test_text_followups_transparent_and_4k():
    it = intent.classify("logo de una taza, fondo transparente")
    plan = planner.build(it, "logo de una taza", store=FakeStore(ALL_EDIT))
    assert plan.step("background_removal").optional and plan.step("background_removal").available
    it = intent.classify("wallpaper 4k de montañas")
    assert planner.build(it, "wallpaper", store=FakeStore(ALL_EDIT)).step("upscale").available


def test_working_size_keeps_aspect():
    from aics_engine.pipelines.edit import working_size
    w, h = working_size(4000, 3000, 1024, 1024)
    assert w % 64 == 0 and h % 64 == 0 and abs(w / h - 4 / 3) < 0.1 and max(w, h) <= 1024


def test_transparent_param_adds_background_removal_followup():
    it = intent.classify("logo de una cafetería")
    plan = planner.build(it, "logo de una cafetería", store=FakeStore(ALL_EDIT), transparent=True)
    assert plan.executable and plan.step("background_removal").optional


def test_relight_operation_and_refine():
    installed = ALL_EDIT | {"depth-anything-v2-small"}
    plan = edit_plan("reilumina con luz desde la izquierda", installed=installed)
    assert plan.operation == "relight" and plan.executable
    assert edit_plan("", installed=installed, operation="relight").executable
    plan = edit_plan("", installed=installed, operation="relight", refine=True)
    assert plan.step("image_to_image").optional
    assert not edit_plan("", installed=ALL_EDIT, operation="relight").executable


def test_relight_shading_math():
    import numpy as np
    from PIL import Image
    from aics_engine.pipelines import relight as rl

    flat = rl.normals_from_depth(np.zeros((32, 32), dtype=np.float32))
    assert np.allclose(flat[..., 2], 1.0)
    img = Image.new("RGB", (32, 32), (128, 128, 128))
    assert np.asarray(rl.shade(img, flat, rl.Light(strength=0.0))).tolist() == np.asarray(img).tolist()

    # Superficie inclinada hacia la derecha (más cerca a la izquierda): la luz desde la derecha la ilumina más.
    ramp = np.tile(np.linspace(1, 0, 64, dtype=np.float32), (64, 1))
    n = rl.normals_from_depth(ramp)
    assert n[32, 32, 0] > 0.05
    big = Image.new("RGB", (64, 64), (128, 128, 128))
    right = np.asarray(rl.shade(big, n, rl.Light(azimuth=0, elevation=20, strength=1, kelvin=6600))).mean()
    left = np.asarray(rl.shade(big, n, rl.Light(azimuth=180, elevation=20, strength=1, kelvin=6600))).mean()
    assert right > left

    warm, cool = rl.kelvin_to_rgb(3000), rl.kelvin_to_rgb(9000)
    assert warm[0] == 1.0 and warm[2] < 0.6 and cool[2] == 1.0
    assert "from the left" in rl.lighting_prompt(rl.Light(azimuth=180))


# ---------- Fase 4: Photo Studio ----------

PHOTO = ALL_EDIT | {"yunet", "sface", "dwpose", "controlnet-openpose-sdxl", "ip-adapter-face-sdxl"}


def test_identity_operations_require_person_and_references():
    r = policy.evaluate("retrato editorial en estudio", operation="identity_generate")
    assert not r.allowed and r.rule == "identity_without_person"
    r = policy.evaluate("retrato editorial en estudio", operation="pose_change", person_id="p1", identity_references=0)
    assert not r.allowed
    assert policy.evaluate("retrato editorial en estudio", operation="identity_generate", person_id="p1", identity_references=3).allowed


def test_identity_operations_block_suggestive_and_nudity():
    kw = dict(operation="identity_generate", person_id="p1", identity_references=2)
    assert policy.evaluate("foto sexy en la cama", **kw).rule == "identity_suggestive"
    assert policy.evaluate("sesión en bikini en la playa", **kw).rule == "identity_suggestive"
    assert not policy.evaluate("desnudo artístico", **kw).allowed
    assert policy.evaluate("retrato corporativo con traje azul", **kw).allowed


def test_retouch_is_promptless_and_validated():
    plan = edit_plan("", installed=PHOTO, operation="portrait_retouch")
    assert plan.executable
    assert plan.step("face_identity").optional


def test_identity_generate_plan_forces_sdxl_and_optional_pose():
    it = intent.classify("retrato de estudio")
    store = FakeStore(PHOTO | {"sd15"})
    plan = planner.build(it, "retrato de estudio", profile="compatible", store=store, requested_model="sd15", operation="identity_generate")
    assert plan.step("text_to_image").model_id == "sdxl-base" and plan.executable
    assert plan.step("pose_control") is None
    plan = planner.build(it, "retrato", store=store, operation="identity_generate", with_pose=True)
    assert plan.step("pose_control").available


def test_pose_change_needs_a_pose_and_models():
    assert not edit_plan("misma ropa", installed=PHOTO, operation="pose_change").executable
    assert edit_plan("misma ropa", installed=PHOTO, operation="pose_change", with_pose=True).executable
    plan = edit_plan("misma ropa", installed=PHOTO, operation="pose_change", pose_from_image=True)
    assert plan.executable and plan.step("pose_estimation").available
    missing = edit_plan("misma ropa", installed=ALL_EDIT, operation="pose_change", with_pose=True)
    assert not missing.executable and any("ControlNet" in w or "IP-Adapter" in w for w in missing.warnings)


def test_similarity_transform_recovers_known_transform():
    import numpy as np
    from aics_engine.pipelines.faces import ARCFACE_112, similarity_transform

    angle, scale, t = 0.3, 1.7, np.array([12.0, -5.0])
    rot = np.array([[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]])
    src = ARCFACE_112.astype(np.float64)
    dst = (scale * (rot @ src.T)).T + t
    m = similarity_transform(src, dst)
    assert np.allclose(m[:, :2], scale * rot, atol=1e-6) and np.allclose(m[:, 2], t, atol=1e-6)


def test_pose_render_and_conversion():
    import numpy as np
    from aics_engine.pipelines import pose

    kps = np.zeros((133, 3), dtype=np.float32)
    kps[:17, 2] = 0.9
    kps[5, :2], kps[6, :2] = (40, 50), (60, 50)  # hombros
    kps[0, :2] = (50, 30)  # nariz
    op = pose.to_openpose(kps, 100, 200)
    assert op["body"][1][:2] == [0.5, 0.25]  # cuello = punto medio de los hombros
    assert op["body"][2][:2] == [0.6, 0.25]  # hombro derecho (OpenPose) = COCO 6
    img = pose.render(op, 300, 300)
    assert img.size == (300, 300) and np.asarray(img).max() > 0
    assert pose.render({"width": 1, "height": 1, "body": [[0, 0, 0]] * 18}, 64, 64).getbbox() is None


def test_retouch_grades_without_moving_pixels():
    import numpy as np
    from PIL import Image
    from aics_engine.pipelines import retouch

    img = Image.fromarray((np.random.default_rng(1).random((64, 64, 3)) * 255).astype(np.uint8))
    same = retouch.retouch(img, [], skin=0.8, look="natural", intensity=0.0)
    assert np.abs(np.asarray(same, dtype=int) - np.asarray(img, dtype=int)).max() <= 1
    mono = np.asarray(retouch.retouch(img, [], look="bn_editorial"))
    assert np.allclose(mono[..., 0], mono[..., 1], atol=1) and np.allclose(mono[..., 1], mono[..., 2], atol=1)


# ---------- Fase 5: restauración ----------

RESTORE = PHOTO | {"lama", "scunet", "gfpgan", "ddcolor-tiny"}


def test_restore_plan_depends_on_chosen_corrections():
    plan = edit_plan("", installed=RESTORE, operation="restore")
    assert plan.executable and [s.op for s in plan.steps][:4] == ["scratch_removal", "denoise", "face_detection", "face_restore"]
    plan = edit_plan("", installed=RESTORE, operation="restore", restore_options={"scratches": False, "denoise": 0, "faces": False, "colorize": True, "scale": 2})
    assert {s.op for s in plan.steps if not s.optional} == {"colorize", "upscale"}
    assert not edit_plan("", installed=RESTORE, operation="restore", restore_options={"scratches": False, "denoise": 0, "faces": False}).executable
    missing = edit_plan("", installed=PHOTO, operation="restore")
    assert not missing.executable and any("LaMa" in w for w in missing.warnings)


def test_auto_operations_for_restoration_requests():
    assert edit_plan("Restaura esta foto antigua", installed=RESTORE).operation == "restore"
    assert edit_plan("quita el ruido", installed=RESTORE).operation == "denoise"
    assert edit_plan("extiende la imagen hacia los lados", installed=RESTORE).operation == "outpaint"
    assert edit_plan("quita el cable", installed=RESTORE, has_mask=True).operation == "erase"
    assert edit_plan("pon un sombrero", installed=RESTORE, has_mask=True).operation == "inpainting"


def test_erase_needs_mask_and_outpaint_is_promptless():
    assert not edit_plan("", installed=RESTORE, operation="erase").executable
    assert edit_plan("", installed=RESTORE, operation="erase", has_mask=True).executable
    assert edit_plan("", installed=RESTORE, operation="outpaint").executable


def test_damage_detection_finds_scratches_and_spares_faces():
    import numpy as np
    from PIL import Image, ImageDraw
    from aics_engine.pipelines import restore
    from aics_engine.pipelines.faces import Face

    img = Image.new("L", (400, 300), 120)
    d = ImageDraw.Draw(img)
    d.line([(10, 50), (390, 60)], fill=250, width=2)  # raya clara
    d.line([(200, 10), (210, 290)], fill=10, width=2)  # raya oscura
    mask = np.asarray(restore.detect_damage(img.convert("RGB"), 0.5)) > 127
    assert mask[48:58, 100].any() and mask[150, 200:212].any() and not mask[250, 50]
    # Mota oscura sobre un ojo: se protege; una raya que cruza la cara: se borra.
    d.ellipse([228, 178, 232, 182], fill=5)
    face = Face(box=(180, 140, 100, 100), landmarks=np.array([[230, 180], [260, 180], [245, 200], [232, 222], [258, 222]], float), score=0.9)
    protected = np.asarray(restore.detect_damage(img.convert("RGB"), 0.5, protect=[face])) > 127
    assert not protected[176:185, 226:235].any()
    assert protected[48:58, 100].any()
    # Un pliegue en tono medio no es daño.
    crease = Image.new("L", (400, 300), 120)
    ImageDraw.Draw(crease).line([(10, 150), (390, 160)], fill=95, width=2)
    assert not (np.asarray(restore.detect_damage(crease.convert("RGB"), 0.5)) > 127).any()


def test_outpaint_canvas_and_tone_helpers():
    import numpy as np
    from PIL import Image
    from aics_engine.pipelines import edit, restore

    img = Image.new("RGB", (100, 80), (200, 50, 50))
    canvas, mask, offset = edit.outpaint_canvas(img, 0.5, 0.5, 0, 0)
    assert canvas.size == (200, 80) and offset == (50, 0)
    m = np.asarray(mask)
    assert m[40, 10] == 255 and m[40, 100] == 0 and m[40, 60] == 255  # solape de 24 px repintable
    faded = Image.fromarray(np.full((10, 10, 3), [100, 110, 120], np.uint8))
    faded.putpixel((0, 0), (90, 90, 90))
    faded.putpixel((1, 1), (140, 140, 140))
    t = np.asarray(restore.auto_tone(faded))
    assert t.min() < 20 and t.max() > 230
    assert restore.is_monochrome(Image.new("RGB", (32, 32), (112, 100, 86)))  # sepia
    colorful = Image.fromarray(np.dstack([np.tile(np.linspace(0, 255, 32), (32, 1))] * 1 + [np.full((32, 32), 80), np.tile(np.linspace(255, 0, 32), (32, 1))]).astype(np.uint8))
    assert not restore.is_monochrome(colorful)


# ---------- Fase 6: modelos por perfil ----------

def test_packs_follow_profile_and_runtime(monkeypatch):
    from aics_engine import hardware, registry as reg

    def fake(profile, torch_ok):
        hw = hardware.HardwareInfo("macos", "arm64", "mps", "x", 16, 16, torch_ok, profile, hardware.PROFILE_DEFAULTS[profile])
        monkeypatch.setattr(hardware, "detect", lambda: hw)

    store = FakeStore(set())
    fake("balanced", True)
    packs = {p["id"]: p for p in reg.describe_packs(store)["packs"]}
    assert "sdxl-base" in packs["essential"]["models"] and packs["essential"]["recommended"]
    assert packs["photo"]["available"] and not packs["quality"]["recommended"]
    fake("compatible", True)
    packs = {p["id"]: p for p in reg.describe_packs(store)["packs"]}
    assert "sd15" in packs["essential"]["models"] and not packs["photo"]["available"]
    fake("compatible", False)  # p. ej. Windows ARM64 sin PyTorch
    packs = {p["id"]: p for p in reg.describe_packs(store)["packs"]}
    assert packs["essential"]["models"] == ["birefnet-lite"]
    assert set(packs["restore"]["models"]) == {"lama", "yunet", "sface"}
    assert not reg.runtime_support(reg.get("sdxl-base"))[0]
    assert reg.choose_model("text_to_image", "compatible", store) is None


def test_enqueue_checks_disk_space(monkeypatch):
    from aics_engine import registry as reg

    store = reg.ModelStore()
    monkeypatch.setattr(store, "state", lambda spec: reg.ModelState(status="not_installed"))
    monkeypatch.setattr(reg, "free_disk_bytes", lambda: int(3e9))
    with pytest.raises(ValueError, match="espacio"):
        store.enqueue([reg.get("sdxl-base")])
