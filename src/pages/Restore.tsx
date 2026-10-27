import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Brush, Eraser, Eye, History, ImagePlus, Palette, ScanFace, ScanSearch, Sparkles, Trash2 } from "lucide-react";
import { api, fileUrl, isTerminal, type Asset, type Job, type JobParams } from "../lib/api";
import { errorText, useAssetsDeleted, useJobs, useJobUpdates } from "../lib/hooks";
import CompareSlider from "../components/CompareSlider";
import MaskCanvas, { type MaskHandle } from "../components/MaskCanvas";
import SourcePicker, { importFiles, useFileDrop } from "../components/SourcePicker";
import { ValidationPanel } from "../components/photo/ValidationBadge";
import { useFitSize } from "../components/useFitSize";
import { Progress, Segmented, Thumb } from "../components/ui";
import { useToast } from "../components/Toasts";
import { SaveToggle, useAssetActions } from "../components/AssetActions";
import { useSession, useSessionSource } from "../lib/session";
import type { IncomingAsset } from "./Edit";

interface Props {
  projectId: string;
  engineReady: boolean;
  engineMessage: string;
  incoming: IncomingAsset | null;
}

type Mode = "documental" | "creativo";

const MODES: Record<Mode, { label: string; text: string }> = {
  documental: { label: "Documental", text: "Mínima invención: limpia daños y recupera detalle sin cambiar el carácter de la foto. Ideal para archivo y genealogía." },
  creativo: { label: "Creativa", text: "Limpieza y embellecimiento más decididos: rostros más nítidos, menos ruido, color opcional." },
};

export default function Restore({ projectId, engineReady, engineMessage, incoming }: Props) {
  const toast = useToast();
  const actions = useAssetActions();
  const session = useSession("restore");
  const [source, setSource] = useState<Asset | null>(null);
  const [results, setResults] = useState<Asset[]>([]);
  const [selected, setSelected] = useState<Asset | null>(null);
  const [mode, setMode] = useState<Mode>("documental");
  const [scratches, setScratches] = useState(true);
  const [denoise, setDenoise] = useState(0.6);
  const [faces, setFaces] = useState(true);
  const [fidelity, setFidelity] = useState<number | null>(null);
  const [colorize, setColorize] = useState(false);
  const [scale, setScale] = useState(1);
  const [review, setReview] = useState<{ mask: string; pct: number } | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [brush, setBrush] = useState(18);
  const [erase, setErase] = useState(false);
  const [hasMask, setHasMask] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const mask = useRef<MaskHandle>(null);
  const { jobs } = useJobs(projectId, 40);

  useEffect(() => { if (incoming) api.getAsset(incoming.assetId).then((a) => a && setSource(a)); }, [incoming]);
  useEffect(() => { setReview(null); setReviewing(false); }, [source?.id]);

  useSessionSource(session.id, source, setSource);

  const load = useCallback(async (newest = false) => {
    if (!source) return;
    const list = (await api.assetChildren(source.id)).filter((a) => a.metadata.operation === "restore");
    setResults(list);
    setSelected((cur) => (newest ? list[0] : cur && list.find((a) => a.id === cur.id)) ?? list[0] ?? null);
  }, [source?.id]);
  useEffect(() => { setSelected(null); load(); }, [load]);
  useJobUpdates(useCallback((job: Job) => {
    if (job.input_asset_id !== source?.id) return;
    if (job.status === "completed") { load(true); setReviewing(false); }
    if (job.status === "failed") toast({ tone: "error", title: "No se pudo restaurar", body: job.error ?? "" });
  }, [source?.id, load, toast]));
  const dropping = useFileDrop(useCallback(async (paths: string[]) => {
    try { setSource((await importFiles(projectId, paths.slice(0, 1)))[0]); } catch (e) { toast({ tone: "error", title: "No se pudo importar", body: errorText(e) }); }
  }, [projectId, toast]));

  useAssetsDeleted(useCallback((ids: string[]) => {
    if (source && ids.includes(source.id)) setSource(null);
    else load();
  }, [source?.id, load]));

  const shown = selected && !reviewing ? selected : source;
  const ratio = shown?.width && shown?.height ? shown.width / shown.height : 1;
  const { ref, size } = useFitSize(ratio, 28, `${source?.id}-${selected?.id}-${reviewing}`);
  const active = jobs.find((j) => j.input_asset_id === source?.id && !isTerminal(j.status));
  const nothing = !scratches && denoise === 0 && !faces && !colorize && scale === 1;

  async function detect() {
    if (!source) return;
    try {
      const r = await api.restoreDetect(source.id, mode === "documental" ? 0.35 : 0.6);
      setReview({ mask: r.mask, pct: r.damaged_pct });
      setReviewing(true);
      setSelected(null);
    } catch (e) {
      toast({ tone: "error", title: "No se pudieron detectar los daños", body: errorText(e) });
    }
  }

  async function run() {
    if (!source || nothing) return;
    setSubmitting(true);
    try {
      const params: JobParams = { operation: "restore", restore_mode: mode, scratches, denoise, faces, colorize, scale };
      if (fidelity !== null) params.fidelity = fidelity;
      if (scratches && reviewing && mask.current) params.damage_mask_path = await api.saveMask(projectId, mask.current.exportPng());
      const job = await api.createJob({ project_id: projectId, mode: "restore", prompt: "", params, input_asset_id: source.id, session_id: session.forJob });
      session.adopt(job);
      if (job.status === "failed") toast({ tone: "error", title: "No se pudo iniciar", body: job.error ?? "" });
    } catch (e) {
      toast({ tone: "error", title: "No se pudo restaurar", body: errorText(e) });
    } finally {
      setSubmitting(false);
    }
  }

  if (!source) {
    return (
      <div className={`page ${dropping ? "is-dropping" : ""}`}>
        <SourcePicker projectId={projectId} title="Recupera tus fotos antiguas" lead="Rayas, polvo, grano, rostros borrosos y colores apagados. Elige si quieres una restauración fiel al original o una más embellecida." onPick={setSource} />
      </div>
    );
  }

  const report = selected?.metadata.report;

  return (
    <div className={`enhance ${dropping ? "is-dropping" : ""}`}>
      <div className="enhance-main">
        <div className="editor-toolbar">
          <button className="btn btn-ghost btn-s" onClick={() => setSource(null)}><ImagePlus size={14} /> Otra foto</button>
          {reviewing ? (
            <div className="brushbar brushbar-inline">
              <Segmented size="s" value={erase ? "erase" : "brush"} onChange={(v) => setErase(v === "erase")}
                options={[{ value: "brush", label: <><Brush size={13} /> Marcar daño</> }, { value: "erase", label: <><Eraser size={13} /> No es daño</> }]} />
              <input type="range" min={4} max={80} value={brush} onChange={(e) => setBrush(Number(e.target.value))} title="Tamaño del pincel" />
              <button className="icon-btn" title="Quitar todo" onClick={() => mask.current?.clear()}><Trash2 size={14} /></button>
              <span className="muted small">{hasMask ? "Se rellenará lo marcado en naranja" : "Sin daños marcados"}</span>
            </div>
          ) : selected ? (
            <span className="row gap-xs">
              {report?.damaged_pct !== undefined && <span className="chip chip-ghost">{report.damaged_pct}% reparado</span>}
              {report?.faces_restored ? <span className="chip chip-ghost">{report.faces_restored} rostro{report.faces_restored > 1 ? "s" : ""}</span> : null}
              {report?.colorized && <span className="chip chip-ghost">coloreada</span>}
            </span>
          ) : null}
          <span className="row gap-xs">
            <span className="muted small mono">{source.width}×{source.height}</span>
            {selected && !reviewing && <SaveToggle asset={selected} />}
            {actions && !reviewing && (
              <button className="btn btn-ghost btn-s" onClick={() => actions.remove([selected ?? source])} title={selected ? "Eliminar el resultado que estás viendo" : "Eliminar esta foto"}>
                <Trash2 size={14} /> {selected ? "Eliminar resultado" : "Eliminar foto"}
              </button>
            )}
          </span>
        </div>
        <div className="enhance-stage" ref={ref}>
          {size.width > 0 && (reviewing ? (
            <div className="stage-frame" style={{ width: size.width, height: size.height }}>
              <img src={fileUrl(source.path)} alt="" draggable={false} />
              <MaskCanvas ref={mask} width={source.width ?? 1024} height={source.height ?? 1024} brush={brush} erase={erase} enabled onChange={setHasMask} initial={review?.mask} />
            </div>
          ) : selected ? (
            <CompareSlider before={source} after={selected} size={size} />
          ) : (
            <img className="enhance-preview" src={fileUrl(source.path)} alt="" style={{ width: size.width, height: size.height }} />
          ))}
        </div>
      </div>

      <aside className="enhance-panel">
        <h2 className="display">Restaurar</h2>
        <Segmented value={mode} onChange={(m) => { setMode(m); setFidelity(null); if (m === "creativo" && scale === 1) setScale(2); if (m === "documental") setScale(1); }}
          options={(Object.keys(MODES) as Mode[]).map((m) => ({ value: m, label: m === "documental" ? <><History size={14} /> {MODES[m].label}</> : <><Sparkles size={14} /> {MODES[m].label}</> }))} />
        <p className="muted small">{MODES[mode].text}</p>

        <div className="restore-opts">
          <label className="restore-opt">
            <input type="checkbox" checked={scratches} onChange={(e) => setScratches(e.target.checked)} />
            <span className="grow"><strong>Rayas, polvo y manchas</strong><span className="muted small">Detecta y rellena daños finos con LaMa</span></span>
          </label>
          {scratches && (
            <div className="restore-sub">
              {reviewing ? (
                <span className="small">{review?.pct}% detectado · ajusta con el pincel <button className="link small" onClick={() => setReviewing(false)}><Eye size={12} /> ver foto</button></span>
              ) : (
                <button className="btn btn-s" onClick={detect} disabled={!engineReady}><ScanSearch size={14} /> Revisar daños antes de aplicar</button>
              )}
            </div>
          )}
          <div className="restore-opt">
            <span className="grow"><strong>Reducir ruido y grano</strong></span>
            <span className="mono small">{Math.round(denoise * 100)}%</span>
          </div>
          <input className="range" type="range" min={0} max={1} step={0.05} value={denoise} onChange={(e) => setDenoise(Number(e.target.value))} />
          <label className="restore-opt">
            <input type="checkbox" checked={faces} onChange={(e) => setFaces(e.target.checked)} />
            <span className="grow"><strong><ScanFace size={13} /> Restaurar rostros</strong><span className="muted small">GFPGAN, mezclado con el original</span></span>
          </label>
          {faces && (
            <div className="restore-sub">
              <span className="row between small"><span className="muted">Intensidad</span><span className="mono">{Math.round((fidelity ?? (mode === "documental" ? 0.5 : 0.85)) * 100)}%</span></span>
              <input className="range" type="range" min={0.2} max={1} step={0.05} value={fidelity ?? (mode === "documental" ? 0.5 : 0.85)} onChange={(e) => setFidelity(Number(e.target.value))} />
            </div>
          )}
          <label className="restore-opt">
            <input type="checkbox" checked={colorize} onChange={(e) => setColorize(e.target.checked)} />
            <span className="grow"><strong><Palette size={13} /> Colorear</strong><span className="muted small">Sólo si la foto es en blanco y negro o sepia (DDColor)</span></span>
          </label>
          <div className="restore-opt">
            <span className="grow"><strong>Ampliar</strong></span>
            <Segmented size="s" value={scale} onChange={setScale} options={[{ value: 1, label: "No" }, { value: 2, label: "×2" }, { value: 4, label: "×4" }]} />
          </div>
        </div>

        {active ? (
          <div className="stack gap-xs"><Progress value={active.progress} /><span className="muted small mono">{active.message}</span><button className="link small" onClick={() => api.cancelJob(active.id)}>Cancelar</button></div>
        ) : (
          <button className="generate" disabled={!engineReady || submitting || nothing} onClick={run} title={engineReady ? undefined : engineMessage}>
            {submitting ? <span className="spinner" /> : <ArrowUp size={18} strokeWidth={2.4} />}<span>Restaurar</span>
          </button>
        )}
        {!engineReady && <p className="composer-note">{engineMessage}</p>}
        {selected?.metadata.validation && selected.metadata.validation.faces > 0 && <ValidationPanel v={selected.metadata.validation} />}
        {results.length > 1 && (
          <>
            <span className="eyebrow">Versiones</span>
            <div className="picker-grid">{results.map((r) => <Thumb key={r.id} asset={r} onOpen={() => { setSelected(r); setReviewing(false); }} />)}</div>
          </>
        )}
      </aside>
    </div>
  );
}
