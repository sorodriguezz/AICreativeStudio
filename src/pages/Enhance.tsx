import { useCallback, useEffect, useState } from "react";
import { ArrowUp, ImagePlus, Maximize2, ScanFace, SunMedium, Trash2, Waves } from "lucide-react";
import { api, fileUrl, isTerminal, type Asset, type Job, type JobParams } from "../lib/api";
import { errorText, useAssetsDeleted, useJobs, useJobUpdates } from "../lib/hooks";
import { relativeTime } from "../lib/format";
import { DEFAULT_LIGHT, type LightParams } from "../lib/relight";
import CompareSlider from "../components/CompareSlider";
import SourcePicker, { importFiles, useFileDrop } from "../components/SourcePicker";
import { RelightControls, RelightPreview } from "../components/RelightStudio";
import { Progress, Segmented } from "../components/ui";
import { useToast } from "../components/Toasts";
import { SaveToggle, useAssetActions } from "../components/AssetActions";
import { useSession, useSessionSource } from "../lib/session";
import { useFitSize } from "../components/useFitSize";
import { ValidationPanel } from "../components/photo/ValidationBadge";
import type { IncomingAsset } from "./Edit";

interface Props {
  projectId: string;
  engineReady: boolean;
  engineMessage: string;
  incoming: IncomingAsset | null;
}

type Tool = "upscale" | "relight" | "denoise" | "faces";
const OPERATION: Record<Tool, string> = { upscale: "upscale", relight: "relight", denoise: "denoise", faces: "face_restore" };

export default function Enhance({ projectId, engineReady, engineMessage, incoming }: Props) {
  const toast = useToast();
  const actions = useAssetActions();
  const session = useSession("enhance");
  const [source, setSource] = useState<Asset | null>(null);
  const [tool, setTool] = useState<Tool>("upscale");
  const [results, setResults] = useState<Asset[]>([]);
  const [selected, setSelected] = useState<Asset | null>(null);
  const [scale, setScale] = useState(2);
  const [light, setLight] = useState<LightParams>(DEFAULT_LIGHT);
  const [refine, setRefine] = useState(false);
  const [noise, setNoise] = useState(0.8);
  const [fidelity, setFidelity] = useState(0.7);
  const [prepError, setPrepError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { jobs } = useJobs(projectId, 60);

  useEffect(() => {
    if (incoming) api.getAsset(incoming.assetId).then((a) => a && setSource(a));
  }, [incoming]);

  useSessionSource(session.id, source, setSource);

  const load = useCallback(async (selectNewest = false) => {
    if (!source) return;
    const list = (await api.assetChildren(source.id)).filter((a) => a.metadata.operation === OPERATION[tool]);
    setResults(list);
    setSelected((cur) => (selectNewest ? list[0] ?? null : cur && list.find((a) => a.id === cur.id)) ?? (tool === "upscale" ? list[0] ?? null : null));
  }, [source?.id, tool]);
  useEffect(() => { setSelected(null); load(); }, [load]);
  useJobUpdates(useCallback((job: Job) => {
    if (job.input_asset_id !== source?.id) return;
    if (job.status === "completed") load(true);
    if (job.status === "failed") toast({ tone: "error", title: "No se pudo completar", body: job.error ?? "" });
  }, [source?.id, load, toast]));

  useAssetsDeleted(useCallback((ids: string[]) => {
    if (source && ids.includes(source.id)) setSource(null);
    else load();
  }, [source?.id, load]));

  const onDrop = useCallback(async (paths: string[]) => {
    try {
      const [first] = await importFiles(projectId, paths.slice(0, 1));
      setSource(first);
    } catch (e) {
      toast({ tone: "error", title: "No se pudo importar", body: errorText(e) });
    }
  }, [projectId, toast]);
  const dropping = useFileDrop(onDrop);

  const ratio = selected?.width && selected?.height ? selected.width / selected.height : source?.width && source?.height ? source.width / source.height : 1;
  const { ref: stageRef, size } = useFitSize(ratio, 28, `${source?.id}-${selected?.id}-${tool}`);
  const active = jobs.find((j) => j.input_asset_id === source?.id && !isTerminal(j.status));

  async function run() {
    if (!source) return;
    setSubmitting(true);
    try {
      const params: JobParams =
        tool === "upscale" ? { operation: "upscale", scale }
          : tool === "relight" ? { operation: "relight", ...light, refine }
            : tool === "denoise" ? { operation: "denoise", strength: noise }
              : { operation: "face_restore", fidelity };
      const job = await api.createJob({ project_id: projectId, mode: "enhance", prompt: "", params, input_asset_id: source.id, session_id: session.forJob });
      session.adopt(job);
      if (job.status === "failed") toast({ tone: "error", title: "No se pudo iniciar", body: job.error ?? "" });
    } catch (e) {
      toast({ tone: "error", title: "No se pudo iniciar", body: errorText(e) });
    } finally {
      setSubmitting(false);
    }
  }

  if (!source) {
    return (
      <div className={`page ${dropping ? "is-dropping" : ""}`}>
        <SourcePicker projectId={projectId} title="Más detalle, mejor luz" lead="Amplía ×2 o ×4 recuperando textura, o cambia la dirección, el color y la dureza de la luz de una foto." onPick={setSource} />
      </div>
    );
  }

  const target = source.width && source.height ? `${source.width * scale} × ${source.height * scale}` : "";
  const showLive = tool === "relight" && !selected;

  return (
    <div className={`enhance ${dropping ? "is-dropping" : ""}`}>
      <div className="enhance-main">
        <div className="editor-toolbar">
          <button className="btn btn-ghost btn-s" onClick={() => setSource(null)}><ImagePlus size={14} /> Otra imagen</button>
          {tool === "relight" && selected && <button className="btn btn-ghost btn-s" onClick={() => setSelected(null)}><SunMedium size={14} /> Volver a la vista en vivo</button>}
          <span className="muted small mono">{source.width}×{source.height}</span>
          {selected && <SaveToggle asset={selected} />}
          {actions && (
            <button className="btn btn-ghost btn-s" onClick={() => actions.remove([selected ?? source])} title={selected ? "Eliminar el resultado que estás viendo" : "Eliminar esta imagen"}>
              <Trash2 size={14} /> {selected ? "Eliminar resultado" : "Eliminar imagen"}
            </button>
          )}
        </div>
        <div className="enhance-stage" ref={stageRef}>
          {size.width > 0 && (selected ? (
            <CompareSlider before={source} after={selected} size={size} />
          ) : showLive && !prepError ? (
            <RelightPreview source={source} light={light} size={size} onError={setPrepError} />
          ) : (
            <img className="enhance-preview" src={fileUrl(source.path)} alt="" style={{ width: size.width, height: size.height }} />
          ))}
        </div>
      </div>

      <aside className="enhance-panel">
        <div className="tool-grid">
          {([["upscale", Maximize2, "Ampliar"], ["relight", SunMedium, "Reiluminar"], ["denoise", Waves, "Ruido"], ["faces", ScanFace, "Rostros"]] as const).map(([id, Icon, text]) => (
            <button key={id} className={`tool-card ${tool === id ? "on" : ""}`} onClick={() => setTool(id)}><Icon size={16} />{text}</button>
          ))}
        </div>

        {tool === "denoise" ? (
          <>
            <h2 className="display">Reducir ruido</h2>
            <p className="muted small">Quita grano y ruido de fotos con poca luz, móviles o escaneos, conservando bordes y texturas (SCUNet).</p>
            <label className="slider">
              <span className="row between small"><span className="muted">Intensidad</span><span className="mono">{Math.round(noise * 100)}%</span></span>
              <input type="range" min={0.2} max={1} step={0.05} value={noise} onChange={(e) => setNoise(Number(e.target.value))} />
            </label>
          </>
        ) : tool === "faces" ? (
          <>
            <h2 className="display">Recuperar rostros</h2>
            <p className="muted small">Devuelve nitidez a caras borrosas o pequeñas (GFPGAN). Se mezcla con el original y se mide la identidad para no cambiar a la persona.</p>
            <label className="slider">
              <span className="row between small"><span className="muted">Intensidad</span><span className="mono">{Math.round(fidelity * 100)}%</span></span>
              <input type="range" min={0.2} max={1} step={0.05} value={fidelity} onChange={(e) => setFidelity(Number(e.target.value))} />
            </label>
            {selected?.metadata.validation && <ValidationPanel v={selected.metadata.validation} />}
          </>
        ) : tool === "upscale" ? (
          <>
            <h2 className="display">Super-resolución</h2>
            <Segmented value={scale} onChange={setScale} options={[{ value: 2, label: "×2" }, { value: 4, label: "×4" }]} />
            <p className="muted small">Resultado: <span className="mono">{target}</span> px</p>
          </>
        ) : (
          <>
            <h2 className="display">Reiluminar</h2>
            <p className="muted small">Arrastra el punto para mover la luz. La vista previa es instantánea; al aplicar se calcula a resolución completa.</p>
            {prepError && <p className="notice notice-error">{prepError}</p>}
            <RelightControls light={light} onChange={(p) => { setSelected(null); setLight((l) => ({ ...l, ...p })); }} />
            <label className="row gap-xs small refine">
              <input type="checkbox" checked={refine} onChange={(e) => setRefine(e.target.checked)} />
              <span>Refinar con IA <span className="muted">(integra sombras y reflejos; requiere SDXL, más lento)</span></span>
            </label>
          </>
        )}

        {active ? (
          <div className="stack gap-xs">
            <Progress value={active.progress} />
            <span className="muted small mono">{active.message}</span>
            <button className="link small" onClick={() => api.cancelJob(active.id)}>Cancelar</button>
          </div>
        ) : (
          <button className="generate" disabled={!engineReady || submitting || (tool === "relight" && !!prepError)} onClick={run} title={engineReady ? undefined : engineMessage}>
            {submitting ? <span className="spinner" /> : <ArrowUp size={18} strokeWidth={2.4} />}
            <span>{tool === "upscale" ? `Ampliar ×${scale}` : tool === "relight" ? "Aplicar luz" : tool === "denoise" ? "Reducir ruido" : "Recuperar rostros"}</span>
          </button>
        )}
        {!engineReady && <p className="composer-note">{engineMessage}</p>}

        {results.length > 0 && (
          <>
            <span className="eyebrow">Resultados</span>
            <div className="enhance-results">
              {results.map((r) => (
                <button key={r.id} className={`enhance-result ${selected?.id === r.id ? "on" : ""}`} onClick={() => setSelected(r)}>
                  <img src={fileUrl(r.path)} alt="" />
                  <span className="mono small">{r.width}×{r.height}</span>
                  <span className="muted small">{r.saved ? "" : "sin guardar · "}{relativeTime(r.created_at)}</span>
                </button>
              ))}
            </div>
          </>
        )}

      </aside>
    </div>
  );
}
