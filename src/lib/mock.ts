/**
 * Backend simulado para previsualizar la UI en un navegador (`pnpm dev`) sin Tauri ni motor.
 * Sólo se carga en desarrollo cuando no existe `window.__TAURI_INTERNALS__`.
 */
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { Asset, Batch, BatchItem, BrandKit, Job, Mode, ModelInfo, Preset, Project, Workflow } from "./api";

// Rutas simuladas → data URLs (para que fileUrl/convertFileSrc funcione en el navegador).
const files = new Map<string, string>();

async function canvasFrom(url: string, w: number, h: number) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d")!.drawImage(img, 0, 0, w, h);
  return c;
}

/** Normales de un "domo" suave sobre el horizonte del arte simulado. */
function fakeNormals(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - w / 2) / (w * 0.45);
      const dy = (y - h * 0.45) / (h * 0.5);
      const d = Math.min(1, Math.hypot(dx, dy));
      let nx = dx * 0.8, ny = -dy * 0.8;
      const nz = Math.sqrt(Math.max(0.05, 1 - d * d));
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len;
      const i = (y * w + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz / len * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL();
}

const kits: BrandKit[] = [];

const workflows: Workflow[] = [
  { id: "wf-restore-doc", name: "Restaurar foto antigua", description: "Modo documental: limpia rayas y polvo, reduce ruido y recupera rostros sin inventar.", builtin: true, created_at: "", steps: [{ kind: "job", label: "Restaurar (documental)", mode: "restore", params: { operation: "restore", restore_mode: "documental" } }] },
  { id: "wf-restore-color", name: "Restaurar y colorear", description: "Modo creativo con coloreado y ampliación ×2.", builtin: true, created_at: "", steps: [{ kind: "job", label: "Restaurar y colorear", mode: "restore", params: { operation: "restore", restore_mode: "creativo", colorize: true } }, { kind: "job", label: "Ampliar ×2", mode: "enhance", params: { operation: "upscale", scale: 2 } }] },
  { id: "wf-product", name: "Producto con fondo blanco", description: "Quita el fondo y exporta en cuadrado 2000 px.", builtin: true, created_at: "", steps: [{ kind: "job", label: "Quitar fondo", mode: "edit", params: { operation: "background_removal" } }, { kind: "export", label: "Exportar catálogo", targets: [{ name: "catalogo", format: "jpg", width: 2000, height: 2000 }] }] },
  { id: "wf-social", name: "Pack para redes", description: "Exporta post 4:5, historia 9:16 y post para X en JPG.", builtin: true, created_at: "", steps: [{ kind: "export", label: "Exportar redes", targets: [{ name: "instagram-post", format: "jpg", width: 1080, height: 1350 }] }] },
];
const batches: (Batch & { items: BatchItem[] })[] = [];

function runBatch(b: Batch & { items: BatchItem[] }) {
  const wf = workflows.find((w) => w.id === b.workflow_id)!;
  let i = 0;
  const next = () => {
    if (i >= b.items.length || b.status === "cancelled") {
      if (b.status !== "cancelled") b.status = b.failed ? "partial" : "completed";
      b.current = null;
      b.finished_at = now();
      emit("batch-update", { ...b, items: undefined });
      return;
    }
    const it = b.items[i];
    it.status = "running";
    b.current = it.input?.id ?? null;
    emit("batch-update", { ...b, items: undefined });
    let step = 0;
    const t = setInterval(() => {
      it.step = step;
      step++;
      if (step >= wf.steps.length + 1) {
        clearInterval(t);
        const src = it.input!;
        const out: Asset = { ...src, id: id(), path: art(200 + i, src.width ?? 1024, src.height ?? 1024), metadata: { ...src.metadata, operation: "restore", parent_id: src.id }, created_at: now() };
        assets.unshift(out);
        it.output = out;
        it.status = "completed";
        b.done++;
        i++;
        emit("batch-update", { ...b, items: undefined });
        next();
      }
    }, 400);
  };
  setTimeout(next, 200);
}

type MockPerson = import("./api").Person & { refs: import("./api").PersonReference[]; audit: { action: string; detail: Record<string, unknown>; created_at: string }[] };
const persons: MockPerson[] = [];
const personSummary = ({ refs, audit, ...p }: MockPerson) => ({ ...p, reference_count: refs.length, cover_path: refs[0]?.path ?? null });

const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const id = () => Math.random().toString(16).slice(2, 14);

const PALETTES = [
  ["#1b2a49", "#e98a5c", "#f4d58d"],
  ["#0f3d3e", "#64a6a0", "#f1e6c9"],
  ["#2d1e2f", "#c65f7a", "#f6c1a6"],
  ["#14213d", "#fca311", "#e5e5e5"],
  ["#233d2f", "#8fb996", "#f2efe4"],
  ["#3a2e39", "#7d84b2", "#d9dbf1"],
];

function art(seed: number, w: number, h: number): string {
  const [a, b, c] = PALETTES[seed % PALETTES.length];
  const cx = 30 + ((seed * 37) % 40);
  const cy = 25 + ((seed * 53) % 35);
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}'>
    <defs><radialGradient id='g' cx='${cx}%' cy='${cy}%' r='75%'><stop offset='0' stop-color='${c}'/><stop offset='.45' stop-color='${b}'/><stop offset='1' stop-color='${a}'/></radialGradient></defs>
    <rect width='100%' height='100%' fill='url(#g)'/>
    <path d='M0 ${h * 0.72} Q ${w * 0.3} ${h * 0.55} ${w * 0.55} ${h * 0.7} T ${w} ${h * 0.62} V ${h} H0Z' fill='${a}' opacity='.65'/>
    <path d='M0 ${h * 0.85} Q ${w * 0.4} ${h * 0.75} ${w} ${h * 0.86} V ${h} H0Z' fill='${a}' opacity='.9'/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const SIZES: Record<string, [number, number]> = { "1:1": [1024, 1024], "16:9": [1344, 768], "9:16": [768, 1344], "4:5": [896, 1088], "3:2": [1216, 832], "2:3": [832, 1216], "4:3": [1152, 896], "3:4": [896, 1152] };

const projects: Project[] = [
  { id: "general", name: "General", kind: "general", created_at: now(), updated_at: now(), asset_count: 0, cover_path: null, cover_asset_id: null },
  { id: "cafe", name: "Café Aurora — marca", kind: "brand", created_at: now(), updated_at: now(), asset_count: 0, cover_path: null, cover_asset_id: null },
  { id: "walls", name: "Wallpapers otoño", kind: "general", created_at: now(), updated_at: now(), asset_count: 0, cover_path: null, cover_asset_id: null },
];

const presets: Preset[] = [
  ["free", "create", "Libre", {}],
  ["photo", "create", "Fotográfico", { prompt_suffix: "photorealistic" }],
  ["cinematic", "create", "Cinematográfico", { prompt_suffix: "cinematic" }],
  ["illustration", "create", "Ilustración", { prompt_suffix: "illustration" }],
  ["watercolor", "create", "Acuarela", { prompt_suffix: "watercolor" }],
  ["anime", "create", "Anime", { prompt_suffix: "anime" }],
  ["wallpaper", "create", "Wallpaper 16:9", { aspect: "16:9" }],
  ["phone-wallpaper", "create", "Wallpaper móvil 9:16", { aspect: "9:16" }],
  ["logo-minimal", "brand", "Logo minimalista", { aspect: "1:1" }],
  ["logo-emblem", "brand", "Logo emblema", { aspect: "1:1" }],
  ["app-icon", "brand", "Ícono de app", { aspect: "1:1" }],
  ["deck-cover", "brand", "Portada de presentación", { aspect: "16:9" }],
  ["social-post", "brand", "Post redes 4:5", { aspect: "4:5" }],
  ["social-story", "brand", "Historia 9:16", { aspect: "9:16" }],
  ["edit-free", "edit", "Libre", {}],
  ["edit-photo", "edit", "Fotográfico", { prompt_suffix: "photorealistic" }],
  ["edit-cinematic", "edit", "Cinematográfico", { prompt_suffix: "cinematic" }],
  ["edit-watercolor", "edit", "Acuarela", { prompt_suffix: "watercolor" }],
  ["edit-studio", "edit", "Estudio de producto", { prompt_suffix: "studio" }],
].map(([pid, category, name, settings]) => ({ id: pid, category, name, settings, builtin: true }) as Preset);

const models: ModelInfo[] = [
  { id: "sdxl-base", name: "Stable Diffusion XL 1.0", tasks: ["text_to_image"], backend: "diffusers", repo_id: "stabilityai/stable-diffusion-xl-base-1.0", license: "CreativeML Open RAIL++-M (uso comercial permitido)", size_gb: 6.9, min_memory_gb: 12, base_resolution: 1024, profiles: ["full", "balanced"], dev: false, notes: "Motor general de calidad: paisajes, animales, wallpapers, conceptos, logos.", status: "installed", error: null, downloaded_bytes: 0, total_bytes: 0, supported: true, unsupported_reason: null },
  { id: "sd15", name: "Stable Diffusion 1.5", tasks: ["text_to_image"], backend: "diffusers", repo_id: "stable-diffusion-v1-5/stable-diffusion-v1-5", license: "CreativeML Open RAIL-M (uso comercial permitido)", size_gb: 2.1, min_memory_gb: 6, base_resolution: 512, profiles: ["full", "balanced", "compatible"], dev: false, notes: "Perfil Compatible: equipos limitados y Windows ARM64.", status: "not_installed", error: null, downloaded_bytes: 0, total_bytes: 0, supported: true, unsupported_reason: null },
  { id: "tiny-test", name: "Tiny SD (pruebas)", tasks: ["text_to_image"], backend: "diffusers", repo_id: "hf-internal-testing/tiny-stable-diffusion-torch", license: "Apache-2.0", size_gb: 0.01, min_memory_gb: 0, base_resolution: 64, profiles: ["full", "balanced", "compatible"], dev: true, notes: "Modelo diminuto para verificar el pipeline de punta a punta. Produce ruido.", status: "not_installed", error: null, downloaded_bytes: 0, total_bytes: 0, supported: true, unsupported_reason: null },
  { id: "birefnet-lite", name: "BiRefNet Lite (recorte de sujetos)", tasks: ["segmentation", "background_removal"], backend: "onnx", repo_id: "onnx-community/BiRefNet_lite-ONNX", license: "MIT", size_gb: 0.22, min_memory_gb: 0, base_resolution: 1024, profiles: ["full", "balanced", "compatible"], dev: false, notes: "Detecta el sujeto principal.", status: "installed", error: null, downloaded_bytes: 0, total_bytes: 0, supported: true, unsupported_reason: null },
  { id: "depth-anything-v2-small", name: "Depth Anything V2 Small", tasks: ["depth", "relight"], backend: "onnx", repo_id: "onnx-community/depth-anything-v2-small", license: "Apache-2.0", size_gb: 0.1, min_memory_gb: 0, base_resolution: 518, profiles: ["full", "balanced", "compatible"], dev: false, notes: "Estima el volumen de la escena para reiluminarla.", status: "installed", error: null, downloaded_bytes: 0, total_bytes: 0, supported: true, unsupported_reason: null },
  ...[
    ["inpaint", "Inpainting / edición localizada", ["inpainting", "image_to_image"], "Fase 2"],
    ["segmentation", "Segmentación de sujetos", ["segmentation", "background_removal"], "Fase 2"],
    ["upscale", "Super-resolución", ["upscale"], "Fase 2"],
    ["restoration", "Restauración de fotos antiguas", ["denoise", "scratch_removal", "face_restore"], "Fase 3/5"],
    ["pose", "Pose y estructura", ["pose_estimation", "pose_change"], "Fase 4"],
    ["identity", "Preservación de identidad", ["identity_preservation"], "Fase 4"],
  ].map(([mid, name, tasks, notes]) => ({ id: mid, name, tasks, backend: "planned", repo_id: null, license: "", size_gb: 0, min_memory_gb: 0, base_resolution: 0, profiles: [], dev: false, notes, status: "planned", error: null, downloaded_bytes: 0, total_bytes: 0, supported: true, unsupported_reason: null }) as ModelInfo),
];

const jobs: Job[] = [];
const assets: Asset[] = [];
type MockSession = { id: string; project_id: string; section: string; name: string; created_at: string; updated_at: string };
const sessions: MockSession[] = [];
function mockSession(projectId: string, section: string, name: string) {
  const s = { id: id(), project_id: projectId, section, name, created_at: now(), updated_at: now() };
  sessions.unshift(s);
  return s.id;
}
const sessionView = (s: MockSession) => {
  const own = assets.filter((a) => jobs.some((j) => j.id === a.job_id && j.session_id === s.id));
  return { ...s, jobs: jobs.filter((j) => j.session_id === s.id).length, images: own.length, unsaved: own.filter((a) => !a.saved).length, cover_path: own[0]?.path ?? null };
};

function addFinishedJob(projectId: string, prompt: string, aspect: string, count: number, seed: number) {
  const job = baseJob(projectId, prompt, { aspect, count, seed });
  job.session_id = sessions.find((s) => s.project_id === projectId && s.section === job.mode)?.id ?? mockSession(projectId, job.mode, `${job.mode === "brand" ? "Marca" : "Creación"} · ${prompt.slice(0, 40)}`);
  job.status = "completed";
  job.progress = 1;
  job.message = "Listo";
  job.finished_at = now();
  jobs.unshift(job);
  for (let i = 0; i < count; i++) pushAsset(job, aspect, seed + i);
  // En los datos de ejemplo, la primera de cada tirada ya está en la biblioteca.
  assets.filter((x) => x.job_id === job.id).slice(-1).forEach((x) => (x.saved = true));
}

function baseJob(projectId: string, prompt: string, params: Record<string, unknown>, mode?: Mode): Job {
  const brand = /logo|ícono|icono|marca|portada/i.test(prompt);
  return {
    id: id(), project_id: projectId, mode: mode ?? (brand ? "brand" : "create"), prompt, negative_prompt: "", params,
    intent: { domain: brand ? "brand" : "create", tasks: ["text_to_image"], output: brand ? "logo" : "image", aspect: (params.aspect as string) ?? null, constraints: [], style_hints: [], confidence: 0.8 },
    plan: { operation: "text_to_image", steps: [{ op: "text_to_image", available: true, optional: false, model_id: "sdxl-base", note: null }], executable: true, prompt, negative_prompt: "", warnings: [] },
    policy: { allowed: true, rating: "general", reason: null, rule: null },
    status: "queued", progress: 0, message: "En cola", error: null, output_asset_id: null, input_asset_id: null, session_id: null, created_at: now(), finished_at: null,
  };
}

function pushAsset(job: Job, aspect: string, seed: number, size?: [number, number]) {
  const [w, h] = size ?? SIZES[aspect] ?? SIZES["1:1"];
  const operation = job.plan?.operation ?? "text_to_image";
  const person = (job as Job & { person_id?: string }).person_id;
  const ident = ["portrait_retouch", "restore", "face_restore"].includes(operation) ? 0.9 : 0.3 + ((seed * 37) % 55) / 100;
  const report = operation === "restore" ? { damaged_pct: 2.6, faces_restored: 1, colorized: !!job.params.colorize, mode: String(job.params.restore_mode) } : undefined;
  const validation = ["portrait_retouch", "identity_generate", "pose_change", "restore", "face_restore"].includes(operation)
    ? { faces: 1, identity: Math.round(ident * 100) / 100, identity_label: (ident >= 0.5 ? "alta" : ident >= 0.363 ? "media" : "baja") as "alta" | "media" | "baja", sharpness: 0.6, clipped_shadows: 0.01, clipped_highlights: 0.002, warnings: ident < 0.363 ? ["La identidad no coincide lo suficiente con las referencias."] : [] }
    : undefined;
  const asset: Asset = {
    id: id(), project_id: job.project_id, job_id: job.id, kind: "result", path: art(seed, w, h), width: w, height: h,
    rating: "general", metadata: { seed, model_id: operation === "upscale" ? "realesrgan-x4" : "sdxl-base", prompt: job.prompt, operation, parent_id: job.input_asset_id, validation, person_id: person, report }, saved: !job.session_id, created_at: now(),
  };
  assets.unshift(asset);
  const p = projects.find((x) => x.id === job.project_id)!;
  p.asset_count += 1;
  p.cover_path = asset.path;
  job.output_asset_id ??= asset.id;
}

addFinishedJob("walls", "Bosque de arces al atardecer, niebla baja, luz dorada", "16:9", 2, 11);
addFinishedJob("cafe", "Logo minimalista para una cafetería llamada Aurora, taza con un sol", "1:1", 4, 3);
addFinishedJob("general", "Un lobo blanco en una montaña nevada al amanecer", "3:2", 2, 21);
addFinishedJob("general", "Ciudad futurista de noche reflejada en la lluvia, neón", "9:16", 1, 40);
addFinishedJob("general", "Jirafa leyendo un libro, ilustración infantil cálida", "4:5", 3, 7);

function simulate(job: Job) {
  const steps = 24;
  let step = 0;
  const count = ["upscale", "background_removal", "portrait_retouch", "relight", "restore", "denoise", "face_restore", "erase"].includes(job.plan?.operation ?? "") ? 1 : Number(job.params.count ?? 1);
  const tick = setInterval(() => {
    step += 1;
    job.status = "running";
    job.progress = step / (steps * count);
    job.message = `Imagen ${Math.min(count, Math.ceil(step / steps) || 1)}/${count} · paso ${((step - 1) % steps) + 1}/${steps}`;
    if (step >= steps * count) {
      clearInterval(tick);
      const seed = Number(job.params.seed ?? Math.floor(Math.random() * 1000));
      const src = assets.find((a) => a.id === job.input_asset_id);
      const k = job.plan?.operation === "upscale" || (job.plan?.operation === "restore" && job.params.scale) ? Number(job.params.scale ?? 2) : 1;
      const pose = job.params.pose as { width: number; height: number } | undefined;
      const ex = job.params as Record<string, number>;
      const size: [number, number] | undefined = job.plan?.operation === "outpaint" && src ? [Math.round((src.width ?? 1024) * (1 + (ex.expand_left ?? 0) + (ex.expand_right ?? 0))), Math.round((src.height ?? 1024) * (1 + (ex.expand_top ?? 0) + (ex.expand_bottom ?? 0)))] : pose ? [768, 1024] : job.plan?.operation === "identity_generate" ? [896, 1152] : src ? [(src.width ?? 1024) * k, (src.height ?? 1024) * k] : undefined;
      for (let i = 0; i < count; i++) pushAsset(job, (job.params.aspect as string) ?? "1:1", seed + i, size);
      job.status = "completed";
      job.progress = 1;
      job.message = "Listo";
      job.finished_at = now();
    }
    emit("job-update", { ...job });
  }, 120);
}

const BLOCK = /desnud|nude|naked/i;

function editOperation(prompt: string, params: Record<string, any>): NonNullable<Job["plan"]>["operation"] {
  if (params.operation && params.operation !== "auto") return params.operation;
  if (params.mask_path) return "inpainting";
  if (/quita el fondo|sin fondo|transparente/i.test(prompt)) return "background_removal";
  if (/fondo/i.test(prompt)) return "background_replace";
  return "image_to_image";
}

const settings = new Map<string, string>();

export function installMock() {
  // convertFileSrc simulado: rutas de kits → data URLs registradas arriba.
  (window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }).__TAURI_INTERNALS__ ??= {};
  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, any>;
      switch (cmd) {
        case "engine_status":
          return { state: "ready", message: "Motor listo (simulado)", python: "mock", port: 0, setup: null, runtime: { fingerprint: "mock", variant: "pypi", torch: true, gpu: null }, setup_failed: false };
        case "restart_engine":
          return { state: "ready", message: "Motor listo (simulado)", python: "mock", port: 0, setup: null, runtime: null, setup_failed: false };
        case "hardware_info":
          return { platform: "macos", arch: "arm64", device: "mps", device_name: "Apple Silicon (Metal)", total_memory_gb: 16, accelerator_memory_gb: 16, torch_available: true, profile: "balanced", defaults: { max_side: 1024, steps_scale: 0.8, max_batch: 4 } };
        case "list_models":
          return models;
        case "download_model": {
          const m = models.find((x) => x.id === a.modelId)!;
          m.status = "downloading";
          m.total_bytes = m.size_gb * 1e9;
          const t = setInterval(() => {
            m.downloaded_bytes = Math.min(m.total_bytes, m.downloaded_bytes + m.total_bytes / 12);
            if (m.downloaded_bytes >= m.total_bytes) {
              m.status = "installed";
              clearInterval(t);
            }
          }, 500);
          return m;
        }
        case "analyze_prompt": {
          const blocked = BLOCK.test(a.prompt) && (/foto|referencia/i.test(a.prompt) || !!a.inputAssetId);
          const j = baseJob("general", a.prompt, a.params ?? {});
          if (a.inputAssetId) j.plan!.operation = editOperation(a.prompt, a.params ?? {});
          return { intent: j.intent, policy: blocked ? { allowed: false, rating: "blocked", reason: "No se generan desnudos de personas reales a partir de fotos o referencias.", rule: "real_person_nudity" } : j.policy, plan: blocked ? null : j.plan };
        }
        case "list_projects":
          return [...projects].sort((x, y) => (x.updated_at < y.updated_at ? 1 : -1));
        case "create_project": {
          const p: Project = { id: id(), name: a.name, kind: a.kind ?? "general", created_at: now(), updated_at: now(), asset_count: 0, cover_path: null, cover_asset_id: null };
          projects.unshift(p);
          return p.id;
        }
        case "set_project_cover": {
          const p = projects.find((x) => x.id === a.projectId)!;
          p.cover_asset_id = a.assetId;
          p.cover_path = assets.find((x) => x.id === a.assetId)?.path ?? p.cover_path;
          return null;
        }
        case "rename_project":
          projects.find((p) => p.id === a.id)!.name = a.name;
          return null;
        case "list_presets":
          return presets.filter((p) => !a.category || p.category === a.category);
        case "create_job": {
          const input = a.input;
          const job = baseJob(input.project_id, input.prompt, input.params ?? {}, input.mode);
          job.session_id = input.session_id === "new" ? mockSession(input.project_id, input.mode, input.prompt?.slice(0, 50) || "Sesión") : input.session_id ?? null;
          if (input.input_asset_id) {
            job.input_asset_id = input.input_asset_id;
            job.plan!.operation = editOperation(input.prompt, input.params ?? {});
          }
          if (input.params?.operation === "identity_generate" || input.params?.operation === "pose_change") {
            job.plan!.operation = input.params.operation;
            (job as Job & { person_id?: string }).person_id = input.person_id;
            if (/sexy|lencer|bikini/i.test(input.prompt)) {
              job.status = "rejected";
              job.error = "Con la identidad de una persona real no se generan imágenes sugerentes ni de ropa interior o baño.";
              jobs.unshift(job);
              setTimeout(() => emit("job-update", { ...job }), 50);
              return { ...job };
            }
          }
          jobs.unshift(job);
          setTimeout(() => simulate(job), 300);
          return { ...job };
        }
        case "cancel_job":
          return null;
        case "get_job":
          return jobs.find((j) => j.id === a.id) ?? null;
        case "delete_history": {
          const done = (j: Job) => !["queued", "running"].includes(j.status);
          const ids = new Set<string>(a.ids ?? jobs.filter((j) => done(j) && (!a.projectId || j.project_id === a.projectId)).map((j) => j.id));
          const gone = a.withImages ? assets.filter((x) => x.job_id && ids.has(x.job_id)).map((x) => x.id) : [];
          for (let i = assets.length - 1; i >= 0; i--) if (gone.includes(assets[i].id)) assets.splice(i, 1);
          const before = jobs.length;
          for (let i = jobs.length - 1; i >= 0; i--) if (ids.has(jobs[i].id) && done(jobs[i])) jobs.splice(i, 1);
          return { jobs: before - jobs.length, assets: gone };
        }
        case "list_jobs":
          return jobs.filter((j) => !a.projectId || j.project_id === a.projectId).slice(0, a.limit ?? 100);
        case "list_sessions":
          return sessions.filter((s) => s.project_id === a.projectId && s.section === a.section).map(sessionView);
        case "rename_session":
          sessions.find((s) => s.id === a.id)!.name = a.name;
          return null;
        case "delete_session": {
          const own = new Set(jobs.filter((j) => j.session_id === a.id).map((j) => j.id));
          const gone = assets.filter((x) => x.job_id && own.has(x.job_id) && !x.saved).map((x) => x.id);
          for (let i = assets.length - 1; i >= 0; i--) if (gone.includes(assets[i].id)) assets.splice(i, 1);
          for (let i = jobs.length - 1; i >= 0; i--) if (own.has(jobs[i].id)) jobs.splice(i, 1);
          sessions.splice(sessions.findIndex((s) => s.id === a.id), 1);
          return gone;
        }
        case "set_assets_saved":
          for (const x of assets) if (a.ids.includes(x.id)) x.saved = a.saved;
          return null;
        case "list_assets":
          return assets
            .filter((x) => (!a.projectId || x.project_id === a.projectId) && (!a.jobId || x.job_id === a.jobId) && (a.all || a.jobId || x.saved))
            .slice(0, a.limit ?? 200);
        case "get_asset":
          return assets.find((x) => x.id === a.id) ?? null;
        case "asset_children":
          return assets.filter((x) => x.metadata.parent_id === a.id);
        case "deletion_preview": {
          const tree = (rootId: string): string[] => [rootId, ...assets.filter((x) => x.metadata.parent_id === rootId).flatMap((x) => tree(x.id))];
          const all = new Set((a.ids as string[]).flatMap(tree));
          return { versions: [...all].filter((x) => !a.ids.includes(x)).length };
        }
        case "delete_assets": {
          const tree = (rootId: string): string[] => [rootId, ...assets.filter((x) => x.metadata.parent_id === rootId).flatMap((x) => tree(x.id))];
          const ids = new Set(a.withVersions ? (a.ids as string[]).flatMap(tree) : (a.ids as string[]));
          const busy = jobs.some((j) => j.input_asset_id && ids.has(j.input_asset_id) && !["completed", "failed", "cancelled", "rejected"].includes(j.status));
          if (busy) throw "Una de las imágenes se está usando en un trabajo en curso. Espera a que termine o cancélalo.";
          for (let i = assets.length - 1; i >= 0; i--) if (ids.has(assets[i].id)) assets.splice(i, 1);
          return [...ids];
        }
        case "plugin:dialog|open":
          return "/Users/demo/Fotos/retrato.jpg";
        case "import_image": {
          const asset: Asset = { id: id(), project_id: a.projectId, job_id: null, kind: "original", path: art(77, 1200, 900), width: 1200, height: 900, rating: "general", metadata: { source_name: String(a.path).split("/").pop(), operation: "import" }, saved: true, created_at: now() };
          assets.unshift(asset);
          return asset;
        }
        case "save_mask":
          return "/tmp/mask.png";
        case "relight_prepare": {
          const src = assets.find((x) => x.id === a.assetId)!;
          const k = Math.min(1, 768 / Math.max(src.width ?? 1024, src.height ?? 1024));
          const w = Math.round((src.width ?? 1024) * k), h = Math.round((src.height ?? 1024) * k);
          return canvasFrom(src.path, w, h).then((c) => ({ image: c.toDataURL(), normals: fakeNormals(w, h), width: w, height: h }));
        }
        case "export_asset":
          return { dir: "/Users/demo/Exportaciones", files: (a.targets as { name: string; format: string }[]).map((t) => `/Users/demo/Exportaciones/imagen-${t.name}.${t.format}`) };
        case "vectorize_asset": {
          const src = assets.find((x) => x.id === a.assetId)!;
          const svg: Asset = { ...src, id: id(), path: src.path, metadata: { ...src.metadata, operation: "vectorize", parent_id: src.id }, created_at: now() };
          assets.unshift(svg);
          return svg;
        }
        case "create_brand_kit": {
          const logo = assets.find((x) => x.id === a.assetId)!;
          const dir = `/mock/kits/${id()}`;
          const palette = [
            { hex: "#E0592A", rgb: [224, 89, 42], share: 0.52 },
            { hex: "#2B2A33", rgb: [43, 42, 51], share: 0.28 },
            { hex: "#F4D58D", rgb: [244, 213, 141], share: 0.2 },
          ];
          const colors = { primary: "#E0592A", light: "#FFFFFF", dark: "#141414" };
          const spec: [string, string, string, number, number, string][] = [
            ["Logotipo", "Logo · fondo transparente", "logo/logo.png", 1600, 1000, "checker"],
            ["Logotipo", "Logo vectorial (SVG)", "logo/logo.svg", 1600, 1000, "checker"],
            ["Logotipo", "Sobre fondo claro", "logo/logo-sobre-claro.png", 1600, 1000, "#FFFFFF"],
            ["Logotipo", "Sobre fondo oscuro", "logo/logo-sobre-oscuro.png", 1600, 1000, "#141414"],
            ["Logotipo", "Sobre color de marca", "logo/logo-sobre-marca.png", 1600, 1000, "#E0592A"],
            ["Íconos", "Favicon .ico (16, 32, 48)", "iconos/favicon.ico", 48, 48, "checker"],
            ["Íconos", "Apple touch 180 px", "iconos/apple-touch-icon.png", 180, 180, "#FFFFFF"],
            ["Íconos", "Ícono de app 1024 px", "iconos/app-icon-1024.png", 1024, 1024, "#FFFFFF"],
            ["Redes sociales", "Avatar 400 px", "redes/avatar-400.png", 400, 400, "#FFFFFF"],
            ["Redes sociales", "Avatar de marca 400 px", "redes/avatar-marca-400.png", 400, 400, "#E0592A"],
            ["Paleta y guía", "Paleta (JSON)", "paleta.json", 0, 0, ""],
            ["Paleta y guía", "Guía de marca (HTML)", "guia.html", 0, 0, ""],
          ];
          for (const [, , rel] of spec) files.set(`${dir}/${rel}`, logo.path);
          const kit: BrandKit = {
            id: id(), project_id: logo.project_id, name: a.name, logo_asset_id: logo.id, colors, palette: palette as BrandKit["palette"],
            files: spec.map(([group, label, rel, width, height, surface]) => ({ group, label, rel, width, height, surface })), dir, created_at: now(), logo,
          };
          kits.unshift(kit);
          return kit;
        }
        case "list_brand_kits":
          return kits.filter((k) => !a.projectId || k.project_id === a.projectId);
        case "export_brand_kit":
          return `${a.destDir}/marca-kit`;
        case "list_persons":
          return persons.map(personSummary);
        case "person_detail": {
          const p = persons.find((x) => x.id === a.id)!;
          return { person: personSummary(p), references: p.refs, audit: [...p.audit].reverse(), generated: assets.filter((x) => x.metadata.person_id === p.id) };
        }
        case "create_person": {
          const p: MockPerson = { id: id(), name: a.name, notes: null, is_adult: a.isAdult, created_at: now(), reference_count: 0, cover_path: null, generated_count: 0, refs: [], audit: [{ action: "persona_creada", detail: {}, created_at: now() }] };
          persons.push(p);
          return p.id;
        }
        case "add_person_reference": {
          const p = persons.find((x) => x.id === a.personId)!;
          const ref = { id: id(), person_id: p.id, path: art(90 + p.refs.length, 600, 800), width: 600, height: 800, face: { box: [200, 160, 200, 240], score: 0.93 }, created_at: now() };
          p.refs.push(ref);
          p.audit.push({ action: "referencia_agregada", detail: {}, created_at: now() });
          return ref;
        }
        case "remove_person_reference":
          for (const p of persons) p.refs = p.refs.filter((r) => r.id !== a.id);
          return null;
        case "update_person": {
          const p = persons.find((x) => x.id === a.id)!;
          Object.assign(p, { name: a.name, notes: a.notes }, a.isAdult === undefined ? {} : { is_adult: a.isAdult });
          return null;
        }
        case "delete_person":
          persons.splice(persons.findIndex((p) => p.id === a.id), 1);
          return null;
        case "pose_estimate":
          return { width: 768, height: 1024, body: [[0.52,0.15,1],[0.5,0.25,1],[0.41,0.26,1],[0.34,0.36,1],[0.42,0.45,1],[0.59,0.26,1],[0.66,0.36,1],[0.6,0.46,1],[0.45,0.53,1],[0.44,0.71,1],[0.43,0.89,1],[0.55,0.53,1],[0.58,0.7,1],[0.6,0.88,1],[0.5,0.14,1],[0.54,0.14,1],[0.48,0.15,1],[0.56,0.15,1]] };
        case "restore_detect": {
          const src = assets.find((x) => x.id === a.assetId)!;
          const w = src.width ?? 1024, h = src.height ?? 1024;
          const c = document.createElement("canvas"); c.width = w; c.height = h;
          const g = c.getContext("2d")!; g.fillStyle = "#000"; g.fillRect(0, 0, w, h); g.strokeStyle = "#fff"; g.lineWidth = Math.max(3, w / 250);
          for (let k = 0; k < 6; k++) { g.beginPath(); g.moveTo(w * (0.1 + k * 0.14), h * 0.05); g.lineTo(w * (0.2 + k * 0.12), h * 0.9); g.stroke(); }
          g.fillStyle = "#fff"; for (let k = 0; k < 40; k++) { g.beginPath(); g.arc(((k * 97) % 100) / 100 * w, ((k * 53) % 100) / 100 * h, w / 200, 0, 7); g.fill(); }
          return { mask: c.toDataURL(), width: w, height: h, damaged_pct: 2.6, faces: 1 };
        }
        case "list_workflows":
          return workflows;
        case "save_workflow": {
          const wf: Workflow = { id: a.id || id(), name: a.name, description: a.description ?? "", steps: a.steps, builtin: false, created_at: now() };
          const k = workflows.findIndex((w) => w.id === wf.id);
          if (k >= 0) workflows[k] = wf; else workflows.push(wf);
          return wf.id;
        }
        case "delete_workflow":
          workflows.splice(workflows.findIndex((w) => w.id === a.id && !w.builtin), 1);
          return null;
        case "start_batch": {
          const wf = workflows.find((w) => w.id === a.workflowId)!;
          const b = { id: id(), project_id: a.projectId, workflow_id: wf.id, name: wf.name, status: "running" as const, total: a.assetIds.length, done: 0, failed: 0, current: null, export_dir: "/Users/demo/lote", created_at: now(), finished_at: null,
            items: (a.assetIds as string[]).map((x) => ({ id: id(), input: assets.find((y) => y.id === x) ?? null, output: null, status: "pending" as const, step: 0, error: null, exports: [] })) };
          batches.unshift(b);
          runBatch(b);
          return b.id;
        }
        case "list_batches":
          return batches.map(({ items, ...b }) => b);
        case "batch_detail": {
          const b = batches.find((x) => x.id === a.id)!;
          const { items, ...rest } = b;
          return { batch: rest, items, workflow: workflows.find((w) => w.id === b.workflow_id) ?? null };
        }
        case "cancel_batch":
          for (const b of batches) if (b.id === a.id) b.status = "cancelled";
          return null;
        case "model_packs": {
          const inst = (ids: string[]) => ids.filter((x) => models.find((m) => m.id === x)?.status !== "installed");
          const size = (ids: string[]) => ids.reduce((a, x) => a + (models.find((m) => m.id === x)?.size_gb ?? 0.1) * 1e9, 0);
          const def = [
            ["essential", "Esencial", "Crear y editar imágenes, quitar fondos y ampliar.", ["sdxl-base", "birefnet-lite", "realesrgan-x4"], true],
            ["restore", "Restauración", "Fotos antiguas: rayas, ruido, rostros y coloreado; borrar objetos.", ["lama", "scunet", "gfpgan", "ddcolor-tiny", "yunet", "sface"], true],
            ["light", "Reiluminar", "Cambiar la dirección y el color de la luz de una foto.", ["depth-anything-v2-small"], true],
            ["photo", "Photo Studio", "Retoque de retratos, sesiones con identidad y cambio de pose.", ["yunet", "sface", "dwpose", "ip-adapter-face-sdxl", "controlnet-openpose-sdxl"], false],
            ["quality", "Calidad extra", "Rellenos y cambios de fondo más coherentes (opcional).", ["sdxl-inpaint"], false],
          ] as const;
          return { profile: "balanced", device: "mps", torch: true, free_disk_bytes: 182e9, packs: def.map(([pid, name, description, ids, rec]) => {
            const missing = inst([...ids]);
            return { id: pid, name, description, optional: pid === "quality", models: [...ids], missing, missing_bytes: size(missing), installed: missing.length === 0, available: true, recommended: rec, reason: null };
          }) };
        }
        case "queue_models":
          for (const x of a.ids as string[]) { const m = models.find((y) => y.id === x); if (m) { m.status = "downloading"; m.total_bytes = m.size_gb * 1e9; const t = setInterval(() => { m.downloaded_bytes += m.total_bytes / 6; if (m.downloaded_bytes >= m.total_bytes) { m.status = "installed"; clearInterval(t); } }, 500); } }
          return { queued: a.ids };
        case "delete_model": {
          const m = models.find((y) => y.id === a.modelId)!; m.status = "not_installed"; m.downloaded_bytes = 0;
          return { freed_bytes: m.size_gb * 1e9 };
        }
        case "app_info":
          return { data_dir: "~/Library/Application Support/com.aicreativestudio.desktop", version: "0.6.0 (mock)" };
        case "get_setting":
          return settings.get(a.key) ?? null;
        case "set_setting":
          settings.set(a.key, a.value);
          return null;
        case "providers_status":
          return [
            { id: "codex", label: "ChatGPT", images: true, installed: true, path: "/usr/local/bin/codex", version: "codex-cli 0.163.0", ready: true, account: "Cuenta de ChatGPT", message: "Sesión iniciada con tu suscripción.", experimental: false },
            { id: "gemini", label: "Gemini", images: true, installed: true, path: "/usr/local/bin/agy", version: "1.4.7", ready: false, account: null, message: "Abre `agy` una vez y entra con tu cuenta de Google.", experimental: true },
            { id: "claude", label: "Claude", images: false, installed: true, path: "/usr/local/bin/claude", version: "2.1.310 (Claude Code)", ready: true, account: "Cuenta de claude.ai", message: "Sesión iniciada con tu suscripción.", experimental: false },
          ];
        case "jobs_running":
          return jobs.some((j) => j.status === "queued" || j.status === "running");
        case "stop_engine":
          return null;
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );
  (window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }).__TAURI_INTERNALS__.convertFileSrc = (p: string) => files.get(p) ?? p;
}
