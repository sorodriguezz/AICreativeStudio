import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Mode = "create" | "edit" | "enhance" | "restore" | "brand" | "photo";

export interface SetupProgress {
  step: number;
  total: number;
  title: string;
  detail: string;
  variant: string | null;
}

export interface EngineStatus {
  state: "preparing" | "starting" | "ready" | "idle" | "error" | "stopped";
  message: string;
  python: string | null;
  port: number | null;
  setup: SetupProgress | null;
  runtime: { fingerprint: string; variant: string; torch: boolean; gpu: string | null } | null;
  setup_failed: boolean;
}

export interface ModelPack {
  id: string;
  name: string;
  description: string;
  optional: boolean;
  models: string[];
  missing: string[];
  missing_bytes: number;
  installed: boolean;
  available: boolean;
  recommended: boolean;
  reason: string | null;
}

export interface PacksInfo {
  profile: "full" | "balanced" | "compatible";
  device: string;
  torch: boolean;
  free_disk_bytes: number;
  packs: ModelPack[];
}

export interface HardwareInfo {
  platform: string;
  arch: string;
  device: "cuda" | "mps" | "cpu";
  device_name: string;
  total_memory_gb: number;
  accelerator_memory_gb: number | null;
  torch_available: boolean;
  profile: "full" | "balanced" | "compatible";
  defaults: { max_side: number; steps_scale: number; max_batch: number };
}

export interface ModelInfo {
  id: string;
  name: string;
  tasks: string[];
  backend: string;
  repo_id: string | null;
  license: string;
  size_gb: number;
  min_memory_gb: number;
  base_resolution: number;
  profiles: string[];
  dev: boolean;
  notes: string;
  status: "planned" | "not_installed" | "queued" | "downloading" | "installed" | "error";
  error: string | null;
  downloaded_bytes: number;
  total_bytes: number;
  supported: boolean;
  unsupported_reason: string | null;
}

export interface Intent {
  domain: Mode;
  tasks: string[];
  output: string;
  aspect: string | null;
  constraints: string[];
  style_hints: string[];
  confidence: number;
}

export interface PlanStep {
  op: string;
  available: boolean;
  optional: boolean;
  model_id: string | null;
  note: string | null;
}

export type Operation = "text_to_image" | "image_to_image" | "inpainting" | "background_replace" | "background_removal" | "upscale" | "relight"
  | "portrait_retouch" | "identity_generate" | "pose_change" | "denoise" | "face_restore" | "erase" | "outpaint" | "restore";

export interface Plan {
  operation: Operation;
  steps: PlanStep[];
  executable: boolean;
  prompt: string;
  negative_prompt: string;
  warnings: string[];
}

export interface Policy {
  allowed: boolean;
  rating: "general" | "sensitive" | "blocked";
  reason: string | null;
  rule: string | null;
}

export interface Analysis {
  intent: Intent;
  policy: Policy;
  plan: Plan | null;
}

export interface Project {
  id: string;
  name: string;
  kind: string;
  created_at: string;
  updated_at: string;
  asset_count: number;
  cover_path: string | null;
  cover_asset_id: string | null;
}

export type Section = "create" | "brand" | "edit" | "enhance" | "restore" | "photo";

export interface Session {
  id: string;
  project_id: string;
  section: Section;
  name: string;
  created_at: string;
  updated_at: string;
  jobs: number;
  images: number;
  /** Imágenes que se borran con la sesión (no agregadas a la biblioteca). */
  unsaved: number;
  cover_path: string | null;
}

export interface Preset {
  id: string;
  category: string;
  name: string;
  settings: { prompt_suffix?: string; negative_suffix?: string; aspect?: string; mode?: Mode };
  builtin: boolean;
}

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "rejected";

export interface Job {
  id: string;
  project_id: string;
  mode: Mode;
  prompt: string;
  negative_prompt: string;
  params: Record<string, unknown>;
  intent: Intent | null;
  plan: Plan | null;
  policy: Policy | null;
  status: JobStatus;
  progress: number;
  message: string | null;
  error: string | null;
  output_asset_id: string | null;
  input_asset_id: string | null;
  session_id: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface Asset {
  id: string;
  project_id: string;
  job_id: string | null;
  kind: string;
  path: string;
  width: number | null;
  height: number | null;
  rating: "general" | "sensitive";
  metadata: {
    seed?: number | null; model_id?: string; prompt?: string; operation?: string; parent_id?: string | null; source_name?: string;
    validation?: Validation; person_id?: string;
    report?: { damaged_pct?: number; faces_restored?: number; colorized?: boolean; mode?: string };
  };
  /** En la biblioteca. Los resultados de una sesión empiezan sin guardar. */
  saved: boolean;
  created_at: string;
}

export interface Validation {
  faces: number;
  identity: number | null;
  identity_label: "alta" | "media" | "baja" | null;
  sharpness: number;
  clipped_shadows: number;
  clipped_highlights: number;
  warnings: string[];
}

/** Pose en formato OpenPose (18 puntos) normalizada sobre un lienzo. */
export interface PoseData {
  width: number;
  height: number;
  body: [number, number, number][];
  hands?: [number, number, number][][];
}

export interface Person {
  id: string;
  name: string;
  notes: string | null;
  is_adult: boolean;
  created_at: string;
  reference_count: number;
  cover_path: string | null;
  generated_count: number;
}

export interface PersonReference {
  id: string;
  person_id: string;
  path: string;
  width: number | null;
  height: number | null;
  face: { box: number[]; score: number } | null;
  created_at: string;
}

export interface PersonDetail {
  person: Person;
  references: PersonReference[];
  audit: { action: string; detail: Record<string, unknown>; created_at: string }[];
  generated: Asset[];
}

export interface JobParams {
  model_id?: string;
  aspect?: string;
  count?: number;
  seed?: number;
  steps?: number;
  guidance?: number;
  prompt_suffix?: string;
  negative_suffix?: string;
  operation?: Operation | "auto";
  strength?: number;
  mask_path?: string;
  scale?: number;
  transparent?: boolean;
  refine?: boolean;
  azimuth?: number;
  elevation?: number;
  kelvin?: number;
  ambient?: number;
  relief?: number;
  look?: string;
  skin?: number;
  intensity?: number;
  vignette?: number;
  grain?: number;
  body_skin?: boolean;
  pose?: PoseData;
  pose_image_asset_id?: string;
  identity_strength?: number;
  pose_strength?: number;
  min_identity?: number;
  restore_mode?: "documental" | "creativo";
  scratches?: boolean;
  sensitivity?: number;
  denoise?: number;
  faces?: boolean;
  fidelity?: number;
  colorize?: boolean;
  tone?: boolean;
  damage_mask_path?: string;
  expand_left?: number;
  expand_right?: number;
  expand_top?: number;
  expand_bottom?: number;
}

export type WorkflowStep =
  | { kind: "job"; label: string; mode: Mode; prompt?: string; params: JobParams }
  | { kind: "export"; label: string; targets: ExportTarget[] };

export interface Workflow {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  builtin: boolean;
  created_at: string;
}

export interface Batch {
  id: string;
  project_id: string;
  workflow_id: string | null;
  name: string;
  status: "running" | "completed" | "partial" | "failed" | "cancelled";
  total: number;
  done: number;
  failed: number;
  current: string | null;
  export_dir: string;
  created_at: string;
  finished_at: string | null;
}

export interface BatchItem {
  id: string;
  input: Asset | null;
  output: Asset | null;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  step: number;
  error: string | null;
  exports: string[][];
}

export type ExportFormat = "png" | "jpg" | "webp" | "ico" | "svg";

export interface ExportTarget {
  name: string;
  format: ExportFormat;
  width?: number;
  height?: number;
  fit?: "cover" | "contain";
  background?: string; // "transparent" o #hex
  padding?: number;
  quality?: number;
}

export interface Swatch {
  hex: string;
  rgb: [number, number, number];
  share: number;
}

export interface KitFile {
  group: string;
  label: string;
  rel: string;
  width: number;
  height: number;
  surface: string; // "checker" o #hex
}

export interface BrandKit {
  id: string;
  project_id: string;
  name: string;
  logo_asset_id: string | null;
  colors: { primary: string; light: string; dark: string };
  palette: Swatch[];
  files: KitFile[];
  dir: string;
  created_at: string;
  logo: Asset | null;
}

export interface RelightPreview {
  image: string; // data URL
  normals: string; // data URL
  width: number;
  height: number;
}

export const isTerminal = (s: JobStatus) => ["completed", "failed", "cancelled", "rejected"].includes(s);

export const fileUrl = (path: string) => (path.startsWith("data:") ? path : convertFileSrc(path));

export const api = {
  engineStatus: () => invoke<EngineStatus>("engine_status"),
  restartEngine: () => invoke<EngineStatus>("restart_engine"),
  hardware: () => invoke<HardwareInfo>("hardware_info"),
  models: () => invoke<ModelInfo[]>("list_models"),
  downloadModel: (modelId: string) => invoke<ModelInfo>("download_model", { modelId }),
  modelPacks: () => invoke<PacksInfo>("model_packs"),
  queueModels: (ids: string[]) => invoke<{ queued: string[] }>("queue_models", { ids }),
  deleteModel: (modelId: string) => invoke<{ freed_bytes: number }>("delete_model", { modelId }),
  analyze: (prompt: string, mode: Mode, params?: JobParams, inputAssetId?: string) =>
    invoke<Analysis>("analyze_prompt", { prompt, mode, params, inputAssetId }),
  projects: () => invoke<Project[]>("list_projects"),
  createProject: (name: string, kind?: string) => invoke<string>("create_project", { name, kind }),
  renameProject: (id: string, name: string) => invoke<void>("rename_project", { id, name }),
  setProjectCover: (projectId: string, assetId: string | null) => invoke<void>("set_project_cover", { projectId, assetId }),
  presets: (category?: string) => invoke<Preset[]>("list_presets", { category }),
  /** `session_id`: la sesión actual, o "new" para abrir una al lanzar el trabajo. */
  createJob: (input: { project_id: string; mode: Mode; prompt: string; negative_prompt?: string; params?: JobParams; input_asset_id?: string; person_id?: string; session_id?: string }) =>
    invoke<Job>("create_job", { input }),
  cancelJob: (id: string) => invoke<void>("cancel_job", { id }),
  getJob: (id: string) => invoke<Job | null>("get_job", { id }),
  jobs: (projectId?: string, limit?: number) => invoke<Job[]>("list_jobs", { projectId, limit }),
  /** Sin `ids`, borra todo el historial terminado (del proyecto indicado o de todos). */
  deleteHistory: async (opts: { ids?: string[]; projectId?: string; withImages: boolean }) => {
    const r = await invoke<{ jobs: number; assets: string[] }>("delete_history", opts);
    if (r.assets.length) window.dispatchEvent(new CustomEvent<string[]>(ASSETS_DELETED, { detail: r.assets }));
    return r;
  },
  /** Por defecto sólo la biblioteca (guardadas); `all` incluye los resultados de sesiones sin guardar. */
  assets: (opts: { projectId?: string; jobId?: string; limit?: number; all?: boolean } = {}) => invoke<Asset[]>("list_assets", opts),
  setAssetsSaved: async (ids: string[], saved: boolean) => {
    await invoke<void>("set_assets_saved", { ids, saved });
    window.dispatchEvent(new CustomEvent<string[]>(ASSETS_SAVED, { detail: ids }));
  },
  sessions: (projectId: string, section: Section) => invoke<Session[]>("list_sessions", { projectId, section }),
  renameSession: (id: string, name: string) => invoke<void>("rename_session", { id, name }),
  deleteSession: async (id: string) => {
    const deleted = await invoke<string[]>("delete_session", { id });
    if (deleted.length) window.dispatchEvent(new CustomEvent<string[]>(ASSETS_DELETED, { detail: deleted }));
    return deleted;
  },
  getAsset: (id: string) => invoke<Asset | null>("get_asset", { id }),
  assetChildren: (id: string) => invoke<Asset[]>("asset_children", { id }),
  deletionPreview: (ids: string[]) => invoke<{ versions: number }>("deletion_preview", { ids }),
  deleteAssets: async (ids: string[], withVersions = false) => {
    const deleted = await invoke<string[]>("delete_assets", { ids, withVersions });
    window.dispatchEvent(new CustomEvent<string[]>(ASSETS_DELETED, { detail: deleted }));
    return deleted;
  },
  importImage: (projectId: string, path: string) => invoke<Asset>("import_image", { projectId, path }),
  saveMask: (projectId: string, dataUrl: string) => invoke<string>("save_mask", { projectId, dataUrl }),
  relightPrepare: (assetId: string, maxSide = 768) => invoke<RelightPreview>("relight_prepare", { assetId, maxSide }),
  exportAsset: (assetId: string, targets: ExportTarget[], destDir?: string) =>
    invoke<{ dir: string; files: string[] }>("export_asset", { assetId, targets, destDir }),
  vectorizeAsset: (assetId: string, style?: "logo" | "detailed") => invoke<Asset>("vectorize_asset", { assetId, style }),
  createBrandKit: (assetId: string, name: string) => invoke<BrandKit>("create_brand_kit", { assetId, name }),
  listBrandKits: (projectId?: string) => invoke<BrandKit[]>("list_brand_kits", { projectId }),
  exportBrandKit: (kitId: string, destDir: string) => invoke<string>("export_brand_kit", { kitId, destDir }),
  persons: () => invoke<Person[]>("list_persons"),
  personDetail: (id: string) => invoke<PersonDetail>("person_detail", { id }),
  createPerson: (name: string, notes: string | null, isAdult: boolean) => invoke<string>("create_person", { name, notes, isAdult }),
  updatePerson: (id: string, name: string, notes: string | null, isAdult?: boolean) => invoke<void>("update_person", { id, name, notes, isAdult }),
  deletePerson: (id: string) => invoke<void>("delete_person", { id }),
  addPersonReference: (personId: string, path: string) => invoke<PersonReference>("add_person_reference", { personId, path }),
  removePersonReference: (id: string) => invoke<void>("remove_person_reference", { id }),
  poseEstimate: (assetId: string) => invoke<PoseData>("pose_estimate", { assetId }),
  restoreDetect: (assetId: string, sensitivity?: number) =>
    invoke<{ mask: string; width: number; height: number; damaged_pct: number; faces: number }>("restore_detect", { assetId, sensitivity }),
  workflows: () => invoke<Workflow[]>("list_workflows"),
  saveWorkflow: (input: { id?: string; name: string; description?: string; steps: WorkflowStep[] }) => invoke<string>("save_workflow", input),
  deleteWorkflow: (id: string) => invoke<void>("delete_workflow", { id }),
  startBatch: (projectId: string, workflowId: string, assetIds: string[], exportDir?: string) =>
    invoke<string>("start_batch", { projectId, workflowId, assetIds, exportDir }),
  batches: (projectId?: string) => invoke<Batch[]>("list_batches", { projectId }),
  batchDetail: (id: string) => invoke<{ batch: Batch; items: BatchItem[]; workflow: Workflow | null }>("batch_detail", { id }),
  cancelBatch: (id: string) => invoke<void>("cancel_batch", { id }),
  appInfo: () => invoke<{ data_dir: string; version: string }>("app_info"),
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) => invoke<void>("set_setting", { key, value }),
  providers: (refresh = false) => invoke<ProviderStatus[]>("providers_status", { refresh }),
  stopEngine: () => invoke<void>("stop_engine"),
  jobsRunning: () => invoke<boolean>("jobs_running"),
};

/** CLI de una suscripción (ChatGPT, Gemini o Claude) que puede reemplazar al motor local. */
export type ProviderId = "codex" | "gemini" | "claude";
export interface ProviderStatus {
  id: ProviderId;
  label: string;
  images: boolean;
  installed: boolean;
  path: string | null;
  version: string | null;
  ready: boolean;
  account: string | null;
  message: string;
  experimental: boolean;
}

const ASSETS_DELETED = "aics:assets-deleted";
const ASSETS_SAVED = "aics:assets-saved";
/** Avisa cuando imágenes entran o salen de la biblioteca. */
export function onAssetsSaved(cb: (ids: string[]) => void): () => void {
  const handler = (e: Event) => cb((e as CustomEvent<string[]>).detail);
  window.addEventListener(ASSETS_SAVED, handler);
  return () => window.removeEventListener(ASSETS_SAVED, handler);
}
/** Avisa a todas las vistas cuando se eliminan imágenes (desde el visor, la biblioteca o un editor). */
export function onAssetsDeleted(cb: (ids: string[]) => void): () => void {
  const handler = (e: Event) => cb((e as CustomEvent<string[]>).detail);
  window.addEventListener(ASSETS_DELETED, handler);
  return () => window.removeEventListener(ASSETS_DELETED, handler);
}

export const onJobUpdate = (cb: (job: Job) => void): Promise<UnlistenFn> => listen<Job>("job-update", (e) => cb(e.payload));
export const onBatchUpdate = (cb: (b: Batch) => void): Promise<UnlistenFn> => listen<Batch>("batch-update", (e) => cb(e.payload));
export const onEngineStatus = (cb: (s: EngineStatus) => void): Promise<UnlistenFn> =>
  listen<EngineStatus>("engine-status", (e) => cb(e.payload));
