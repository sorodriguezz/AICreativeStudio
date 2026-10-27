import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Analysis, type Asset, type HardwareInfo, type Job, type JobParams, type Mode, type ModelInfo, type Preset } from "../lib/api";
import { errorText, useAssetsDeleted, useAssetsSaved, useJobs, useJobUpdates } from "../lib/hooks";
import Composer, { emptyDraft, type Draft } from "../components/Composer";
import ModelOnboarding from "../components/ModelOnboarding";
import RunCard from "../components/RunCard";
import Viewer from "../components/Viewer";
import { useSession } from "../lib/session";
import { useToast } from "../components/Toasts";
import BrandKits from "../components/BrandKits";
import { Segmented } from "../components/ui";
import { useProviderSetting } from "../lib/providers";

export interface IncomingDraft {
  prompt: string;
  seed?: number;
  nonce: number;
}

interface Props {
  mode: Extract<Mode, "create" | "brand">;
  projectId: string;
  engineReady: boolean;
  engineMessage: string;
  incoming: IncomingDraft | null;
  onOpenIn: (page: "edit" | "enhance", asset: Asset) => void;
  focusKit?: { kitId: string; nonce: number } | null;
}

const COPY = {
  create: {
    headline: (
      <>
        ¿Qué quieres <em>crear</em> hoy?
      </>
    ),
    lead: "Describe la imagen con tus palabras. Paisajes, animales, wallpapers, escenas, conceptos.",
    placeholder: "Describe la imagen…  p. ej. un lobo blanco en una montaña nevada al amanecer",
    category: "create",
    examples: [
      { title: "Paisaje", prompt: "Un lago alpino al amanecer, niebla sobre el agua, montañas nevadas, luz dorada" },
      { title: "Animal", prompt: "Retrato de un zorro rojo en la nieve, mirada a cámara, fondo desenfocado" },
      { title: "Wallpaper", prompt: "Ciudad futurista de noche reflejada en la lluvia, neón cian y magenta, wallpaper" },
      { title: "Ilustración", prompt: "Una jirafa leyendo un libro bajo un árbol, ilustración infantil cálida" },
    ],
  },
  brand: {
    headline: (
      <>
        Identidad visual, <em>en minutos</em>.
      </>
    ),
    lead: "Logos, íconos, portadas y piezas para redes y presentaciones. Siempre diseño original, nunca copias de marcas existentes.",
    placeholder: "Describe la pieza…  p. ej. logo minimalista para una cafetería llamada Aurora",
    category: "brand",
    examples: [
      { title: "Logo", prompt: "Logo minimalista para una cafetería llamada Aurora, taza con un sol naciente" },
      { title: "Ícono de app", prompt: "Ícono de app para una clínica veterinaria, huella y corazón, verde menta" },
      { title: "Portada 16:9", prompt: "Portada corporativa tecnológica azul para una presentación de ciberseguridad" },
      { title: "Post", prompt: "Post de Instagram para lanzamiento de una panadería artesanal, cálido y limpio" },
    ],
  },
} as const;

export default function Studio({ mode, projectId, engineReady, engineMessage, incoming, onOpenIn, focusKit }: Props) {
  const copy = COPY[mode];
  const toast = useToast();
  const [presets, setPresets] = useState<Preset[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft("", mode === "brand"));
  const [tab, setTab] = useState<"generate" | "kits">(focusKit ? "kits" : "generate");
  useEffect(() => { if (focusKit) setTab("kits"); }, [focusKit]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [viewer, setViewer] = useState<number | null>(null);
  const { jobs } = useJobs(projectId, 200);
  const session = useSession(mode);
  const patch = useCallback((p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p })), []);

  useEffect(() => {
    api.presets(copy.category).then((list) => {
      setPresets(list);
      setDraft((d) => (d.presetId ? d : { ...d, presetId: list[0]?.id ?? "" }));
    });
  }, [copy.category]);

  useEffect(() => {
    if (incoming) setDraft((d) => ({ ...d, prompt: incoming.prompt, seed: incoming.seed !== undefined ? String(incoming.seed) : d.seed }));
  }, [incoming]);

  const loadModels = useCallback(() => {
    if (!engineReady) return;
    api.models().then(setModels).catch(() => undefined);
    api.hardware().then(setHardware).catch(() => undefined);
  }, [engineReady]);
  useEffect(loadModels, [loadModels]);
  const downloading = models.some((m) => m.status === "downloading");
  useEffect(() => {
    if (!downloading) return;
    const t = setInterval(loadModels, 1500);
    return () => clearInterval(t);
  }, [downloading, loadModels]);

  const loadAssets = useCallback(() => {
    api.assets({ projectId, limit: 600, all: true }).then(setAssets);
  }, [projectId]);
  useEffect(loadAssets, [loadAssets]);
  useJobUpdates(useCallback((job: Job) => job.status === "completed" && job.project_id === projectId && loadAssets(), [projectId, loadAssets]));
  useAssetsDeleted(useCallback(() => loadAssets(), [loadAssets]));
  useAssetsSaved(useCallback(() => loadAssets(), [loadAssets]));

  const preset = presets.find((p) => p.id === draft.presetId);
  const params: JobParams = useMemo(() => {
    const p: JobParams = { count: draft.count };
    const aspect = draft.aspect !== "auto" ? draft.aspect : preset?.settings.aspect;
    if (aspect) p.aspect = aspect;
    if (preset?.settings.prompt_suffix) p.prompt_suffix = preset.settings.prompt_suffix;
    if (preset?.settings.negative_suffix) p.negative_suffix = preset.settings.negative_suffix;
    if (draft.seed) p.seed = Number(draft.seed);
    if (draft.steps) p.steps = Number(draft.steps);
    if (draft.modelId) p.model_id = draft.modelId;
    if (mode === "brand" && draft.transparent) p.transparent = true;
    return p;
  }, [draft, preset]);

  // Vista previa en vivo de lo que el sistema entiende (Intent Router + Planner + política).
  useEffect(() => {
    if (!engineReady || draft.prompt.trim().length < 3) {
      setAnalysis(null);
      return;
    }
    const t = setTimeout(() => api.analyze(draft.prompt, mode, params).then(setAnalysis).catch(() => setAnalysis(null)), 300);
    return () => clearTimeout(t);
  }, [draft.prompt, mode, params, engineReady]);

  const t2iInstalled = models.filter((m) => m.tasks.includes("text_to_image") && m.status === "installed");
  // Con una suscripción (ChatGPT/Gemini) no hace falta un modelo local.
  const cloud = useProviderSetting().images !== "local";
  const needsModel = engineReady && !cloud && models.length > 0 && t2iInstalled.length === 0;
  const planIssue = analysis?.plan && !analysis.plan.executable ? analysis.plan.warnings[0] ?? "Esta solicitud todavía no se puede ejecutar." : null;
  const disabledReason = !engineReady ? engineMessage : needsModel ? "Descarga un modelo para empezar a generar." : planIssue;

  async function submit(override?: { prompt: string; negative: string; params: JobParams; mode: Mode }) {
    setSubmitting(true);
    try {
      const job = await api.createJob({
        project_id: projectId,
        mode: override?.mode ?? mode,
        prompt: override?.prompt ?? draft.prompt,
        negative_prompt: override?.negative ?? draft.negative,
        params: override?.params ?? params,
        session_id: session.forJob,
      });
      session.adopt(job);
    } catch (e) {
      toast({ tone: "error", title: "No se pudo generar", body: errorText(e) });
    } finally {
      setSubmitting(false);
    }
  }

  const variations = (job: Job) => {
    const { seed: _seed, ...rest } = job.params as JobParams;
    submit({ prompt: job.prompt, negative: job.negative_prompt, params: rest, mode: job.mode });
  };
  const reusePrompt = (job: Job) => patch({ prompt: job.prompt, negative: job.negative_prompt });

  // Sólo las tiradas de la sesión abierta; una sesión nueva empieza vacía.
  const runs = session.id ? jobs.filter((j) => j.mode === mode && j.session_id === session.id) : [];
  const assetsByJob = useMemo(() => {
    const map = new Map<string, Asset[]>();
    for (const a of [...assets].reverse()) if (a.job_id) map.set(a.job_id, [...(map.get(a.job_id) ?? []), a]);
    return map;
  }, [assets]);
  const viewerAssets = useMemo(() => runs.flatMap((j) => assetsByJob.get(j.id) ?? []), [runs, assetsByJob]);
  const presetName = (job: Job) => presets.find((p) => p.settings.prompt_suffix && p.settings.prompt_suffix === job.params.prompt_suffix)?.name;
  const jobOf = (a: Asset) => jobs.find((j) => j.id === a.job_id);

  if (mode === "brand" && tab === "kits") {
    return (
      <div className="studio">
        <div className="studio-tabs"><Segmented value={tab} onChange={setTab} options={[{ value: "generate", label: "Generar" }, { value: "kits", label: "Kits de marca" }]} /></div>
        <BrandKits projectId={projectId} focusKitId={focusKit?.kitId ?? null} onGenerate={() => setTab("generate")} />
      </div>
    );
  }

  return (
    <div className="studio">
      {mode === "brand" && (
        <div className="studio-tabs"><Segmented value={tab} onChange={setTab} options={[{ value: "generate", label: "Generar" }, { value: "kits", label: "Kits de marca" }]} /></div>
      )}
      <div className="feed">
        {needsModel && <ModelOnboarding models={models} hardware={hardware} onChanged={loadModels} />}

        {runs.length === 0 && !needsModel && (
          <section className="hero">
            <span className="eyebrow">{mode === "brand" ? "Brand Studio · beta" : "Crear"}</span>
            <h1 className="display display-xl">{copy.headline}</h1>
            <p className="muted hero-lead">{copy.lead}</p>
            <div className="examples">
              {copy.examples.map((ex, i) => (
                <button key={ex.title} className="example" style={{ animationDelay: `${80 * i}ms` }} onClick={() => patch({ prompt: ex.prompt })}>
                  <span className="eyebrow">{ex.title}</span>
                  <span>{ex.prompt}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {runs.map((job) => (
          <RunCard
            key={job.id}
            job={job}
            assets={assetsByJob.get(job.id) ?? []}
            presetName={presetName(job)}
            onOpen={(a) => setViewer(viewerAssets.findIndex((x) => x.id === a.id))}
            onReusePrompt={reusePrompt}
            onVariations={variations}
          />
        ))}
      </div>

      <Composer
        draft={draft}
        onChange={patch}
        presets={presets}
        models={t2iInstalled}
        analysis={analysis}
        placeholder={copy.placeholder}
        disabledReason={disabledReason}
        submitting={submitting}
        onSubmit={() => submit()}
        showTransparent={mode === "brand"}
      />

      {viewer !== null && viewerAssets.length > 0 && (
        <Viewer
          assets={viewerAssets}
          index={viewer}
          onIndex={setViewer}
          onClose={() => setViewer(null)}
          onVariations={(a) => { const j = jobOf(a); if (j) variations(j); }}
          onReusePrompt={(a) => patch({ prompt: a.metadata.prompt ?? "" })}
          onReuseSeed={(a) => patch({ prompt: a.metadata.prompt ?? "", seed: String(a.metadata.seed ?? "") })}
          onEdit={(a) => onOpenIn("edit", a)}
          onEnhance={(a) => onOpenIn("enhance", a)}
        />
      )}
    </div>
  );
}
