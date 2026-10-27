import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft, ArrowUp, Ban, Brush, Eraser, Expand, Eye, FlipHorizontal2, ImageMinus, ImagePlus, Paintbrush, Replace, RotateCcw, Trash2, Wand2,
} from "lucide-react";
import { api, fileUrl, isTerminal, type Analysis, type Asset, type Job, type JobParams, type Operation, type Preset } from "../lib/api";
import { errorText, useAssetsDeleted, useJobs, useJobUpdates } from "../lib/hooks";
import { modKey, relativeTime } from "../lib/format";
import { OPERATION_LABEL, label } from "../lib/labels";
import MaskCanvas, { type MaskHandle } from "../components/MaskCanvas";
import SourcePicker, { importFiles, useFileDrop } from "../components/SourcePicker";
import { useFitSize } from "../components/useFitSize";
import { Kbd, Segmented, StatusPill } from "../components/ui";
import { useToast } from "../components/Toasts";
import { SaveToggle, useAssetActions } from "../components/AssetActions";
import { useSession, useSessionSource } from "../lib/session";

export interface IncomingAsset {
  assetId: string;
  nonce: number;
}

interface Props {
  projectId: string;
  engineReady: boolean;
  engineMessage: string;
  incoming: IncomingAsset | null;
}

type Op = "auto" | Extract<Operation, "image_to_image" | "inpainting" | "erase" | "outpaint" | "background_replace" | "background_removal">;

const OPS: { value: Op; label: string; icon: typeof Wand2; hint: string; placeholder: string }[] = [
  { value: "auto", label: "Auto", icon: Wand2, hint: "La app decide según tu prompt y si pintaste una zona.", placeholder: "Describe el cambio…  p. ej. cambia el fondo por una playa al atardecer" },
  { value: "image_to_image", label: "Transformar", icon: FlipHorizontal2, hint: "Reinterpreta toda la imagen conservando su composición.", placeholder: "¿En qué la conviertes?  p. ej. pintura al óleo, luz de atardecer" },
  { value: "inpainting", label: "Pintar zona", icon: Paintbrush, hint: "Pinta sobre la imagen lo que quieres cambiar. El resto queda intacto.", placeholder: "¿Qué va en la zona pintada?  p. ej. una chaqueta de cuero roja" },
  { value: "erase", label: "Borrar", icon: Eraser, hint: "Pinta lo que sobra (cables, personas, manchas) y se rellena con el entorno. Sin prompt.", placeholder: "No hace falta prompt" },
  { value: "outpaint", label: "Extender", icon: Expand, hint: "Agranda el encuadre: la IA continúa la escena hacia los lados elegidos.", placeholder: "Opcional: qué debería aparecer en lo nuevo" },
  { value: "background_replace", label: "Cambiar fondo", icon: Replace, hint: "Detecta el sujeto y reemplaza sólo el fondo.", placeholder: "Describe el nuevo fondo…  p. ej. estudio fotográfico gris claro" },
  { value: "background_removal", label: "Quitar fondo", icon: ImageMinus, hint: "PNG con fondo transparente. No necesita prompt.", placeholder: "No hace falta prompt" },
];

export default function Edit({ projectId, engineReady, engineMessage, incoming }: Props) {
  const toast = useToast();
  const actions = useAssetActions();
  const session = useSession("edit");
  const [source, setSource] = useState<Asset | null>(null);
  const [children, setChildren] = useState<Asset[]>([]);
  const [op, setOp] = useState<Op>("auto");
  const [prompt, setPrompt] = useState("");
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetId, setPresetId] = useState("edit-free");
  const [strength, setStrength] = useState(0.55);
  const [count, setCount] = useState(2);
  const [brush, setBrush] = useState(48);
  const [erase, setErase] = useState(false);
  const [hasMask, setHasMask] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [expand, setExpand] = useState({ left: 0.25, right: 0.25, top: 0, bottom: 0 });
  const [parent, setParent] = useState<Asset | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const mask = useRef<MaskHandle>(null);
  const { jobs } = useJobs(projectId, 60);

  useEffect(() => {
    api.presets("edit").then(setPresets);
  }, []);

  useEffect(() => {
    if (incoming) api.getAsset(incoming.assetId).then((a) => a && setSource(a));
  }, [incoming]);

  useEffect(() => {
    setParent(null);
    if (source?.metadata.parent_id) api.getAsset(source.metadata.parent_id).then(setParent);
  }, [source?.id]);

  useSessionSource(session.id, source, setSource);

  const loadChildren = useCallback(() => {
    if (source) api.assetChildren(source.id).then(setChildren);
    else setChildren([]);
  }, [source?.id]);
  useEffect(loadChildren, [loadChildren]);
  useJobUpdates(useCallback((job: Job) => {
    if (job.input_asset_id !== source?.id) return;
    if (job.status === "completed") loadChildren();
    if (job.status === "failed" || job.status === "rejected") toast({ tone: "error", title: job.status === "rejected" ? "Solicitud rechazada" : "La edición falló", body: job.error ?? "" });
  }, [source?.id, loadChildren, toast]));

  // Si se elimina la imagen abierta, volvemos a la versión de la que salió (o al selector).
  useAssetsDeleted(useCallback((ids: string[]) => {
    if (source && ids.includes(source.id)) setSource(parent && !ids.includes(parent.id) ? parent : null);
    else loadChildren();
  }, [source?.id, parent, loadChildren]));

  const onDrop = useCallback(async (paths: string[]) => {
    try {
      const [first] = await importFiles(projectId, paths.slice(0, 1));
      setSource(first);
    } catch (e) {
      toast({ tone: "error", title: "No se pudo importar", body: errorText(e) });
    }
  }, [projectId, toast]);
  const dropping = useFileDrop(onDrop);

  const preset = presets.find((p) => p.id === presetId);
  const params: JobParams = useMemo(() => {
    const p: JobParams = { operation: op, count };
    if (op === "image_to_image" || (op === "auto" && !hasMask)) p.strength = strength;
    if (hasMask && (op === "auto" || op === "inpainting" || op === "erase")) p.mask_path = "pending";
    if (op === "outpaint") Object.assign(p, { expand_left: expand.left, expand_right: expand.right, expand_top: expand.top, expand_bottom: expand.bottom });
    if (preset?.settings.prompt_suffix && !["background_removal", "erase"].includes(op)) p.prompt_suffix = preset.settings.prompt_suffix;
    if (op === "erase") p.count = 1;
    return p;
  }, [op, count, strength, hasMask, preset, expand]);

  useEffect(() => {
    if (!engineReady || !source) return setAnalysis(null);
    const t = setTimeout(() => api.analyze(prompt, "edit", params, source.id).then(setAnalysis).catch(() => setAnalysis(null)), 250);
    return () => clearTimeout(t);
  }, [prompt, params, source?.id, engineReady]);

  const activeJobs = jobs.filter((j) => j.input_asset_id === source?.id && !isTerminal(j.status));
  const effectiveOp = analysis?.plan?.operation ?? (op === "auto" ? "image_to_image" : op);
  const blocked = analysis && !analysis.policy.allowed;
  const planIssue = analysis?.plan && !analysis.plan.executable ? analysis.plan.warnings[0] ?? "Esta edición todavía no se puede hacer." : null;
  const disabledReason = !engineReady ? engineMessage : blocked ? analysis!.policy.reason : planIssue;
  const canSubmit = !!source && !disabledReason && !submitting;
  const painting = op === "inpainting" || op === "auto" || op === "erase";
  const meta = OPS.find((o) => o.value === op)!;

  async function submit() {
    if (!canSubmit || !source) return;
    setSubmitting(true);
    try {
      const p: JobParams = { ...params };
      if (p.mask_path) p.mask_path = await api.saveMask(projectId, mask.current!.exportPng());
      if (effectiveOp === "background_removal") delete p.prompt_suffix;
      session.adopt(await api.createJob({ project_id: projectId, mode: "edit", prompt, params: p, input_asset_id: source.id, session_id: session.forJob }));
    } catch (e) {
      toast({ tone: "error", title: "No se pudo editar", body: errorText(e) });
    } finally {
      setSubmitting(false);
    }
  }

  // Atajos: ⌘Z deshace un trazo, B pincel, E borrador, [ ] tamaño, mantener C compara.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement).tagName);
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !typing) { e.preventDefault(); mask.current?.undo(); return; }
      if (typing || e.metaKey || e.ctrlKey) return;
      if (e.key === "b") setErase(false);
      else if (e.key === "e") setErase(true);
      else if (e.key === "[") setBrush((b) => Math.max(8, b - 8));
      else if (e.key === "]") setBrush((b) => Math.min(240, b + 8));
      else if (e.key === "c" && parent) setComparing(true);
    };
    const onUp = (e: KeyboardEvent) => e.key === "c" && setComparing(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onUp);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("keyup", onUp); };
  }, [parent]);

  const baseRatio = source?.width && source?.height ? source.width / source.height : 1;
  const outW = 1 + expand.left + expand.right;
  const outH = 1 + expand.top + expand.bottom;
  const ratio = op === "outpaint" ? (baseRatio * outW) / outH : baseRatio;
  const { ref: stageRef, size } = useFitSize(ratio, 28, `${source?.id}-${op === "outpaint" ? "x" : ""}`);

  if (!source) {
    return (
      <div className={`page ${dropping ? "is-dropping" : ""}`}>
        <SourcePicker
          projectId={projectId}
          title="Edita con palabras"
          lead="Transforma una imagen, pinta una zona para cambiarla, reemplaza el fondo o quítalo. Lo que no toques queda intacto."
          onPick={setSource}
        />
      </div>
    );
  }

  const shown = comparing && parent ? parent : source;

  return (
    <div className={`editor ${dropping ? "is-dropping" : ""}`}>
      <div className="editor-main">
        <div className="editor-toolbar">
          <div className="row gap-s">
            {parent ? (
              <button className="btn btn-ghost btn-s" onClick={() => setSource(parent)} title="Volver a la imagen de la que salió esta"><ArrowLeft size={14} /> Versión anterior</button>
            ) : (
              <button className="btn btn-ghost btn-s" onClick={() => setSource(null)}><ImagePlus size={14} /> Otra imagen</button>
            )}
            <span className="muted small mono">{source.width}×{source.height}</span>
            <span className="chip chip-ghost">{label(OPERATION_LABEL, source.metadata.operation ?? (source.kind === "original" ? "import" : "text_to_image"))}</span>
          </div>
          <Segmented
            value={op}
            onChange={(v) => setOp(v)}
            options={OPS.map((o) => ({ value: o.value, label: <><o.icon size={14} /> {o.label}</>, title: o.hint }))}
          />
          <div className="row gap-xs">
            {parent && (
              <button className="btn btn-ghost btn-s" onPointerDown={() => setComparing(true)} onPointerUp={() => setComparing(false)} onPointerLeave={() => setComparing(false)} title="Mantén presionado (o la tecla C) para ver la versión anterior">
                <Eye size={14} /> Comparar
              </button>
            )}
            <SaveToggle asset={source} />
            {actions && <button className="btn btn-ghost btn-s" onClick={() => actions.remove([source])} title="Eliminar esta imagen"><Trash2 size={14} /> Eliminar</button>}
          </div>
        </div>

        <div className="stage" ref={stageRef}>
          {size.width > 0 && op === "outpaint" && (
            <div className="outpaint-frame" style={{ width: size.width, height: size.height }}>
              <img src={fileUrl(source.path)} alt="" draggable={false}
                style={{ left: `${(expand.left / outW) * 100}%`, top: `${(expand.top / outH) * 100}%`, width: `${100 / outW}%`, height: `${100 / outH}%` }} />
              <span className="stage-tag">{Math.round((source.width ?? 0) * outW)} × {Math.round((source.height ?? 0) * outH)}</span>
            </div>
          )}
          {size.width > 0 && op !== "outpaint" && (
            <div className="stage-frame" style={{ width: size.width, height: size.height }}>
              <img src={fileUrl(shown.path)} alt="" draggable={false} className={source.rating === "sensitive" ? "blur" : ""} />
              <MaskCanvas
                ref={mask}
                width={source.width ?? 1024}
                height={source.height ?? 1024}
                brush={brush}
                erase={erase}
                enabled={painting && !comparing}
                onChange={setHasMask}
              />
              {comparing && <span className="stage-tag">Versión anterior</span>}
            </div>
          )}
        </div>

        {op === "outpaint" && (
          <div className="brushbar expandbar">
            {(["left", "right", "top", "bottom"] as const).map((side) => (
              <label key={side} className="row gap-xs small">
                <span className="muted">{{ left: "Izq.", right: "Der.", top: "Arriba", bottom: "Abajo" }[side]}</span>
                <input type="range" min={0} max={1} step={0.05} value={expand[side]} onChange={(e) => setExpand((x) => ({ ...x, [side]: Number(e.target.value) }))} />
                <span className="mono">{Math.round(expand[side] * 100)}%</span>
              </label>
            ))}
            <span className="row gap-xs">
              {([["16:9", 16 / 9], ["1:1", 1], ["9:16", 9 / 16]] as const).map(([label, target]) => (
                <button key={label} className="chip chip-button" onClick={() => {
                  const r = baseRatio;
                  if (target >= r) { const extra = (target / r - 1) / 2; setExpand({ left: extra, right: extra, top: 0, bottom: 0 }); }
                  else { const extra = (r / target - 1) / 2; setExpand({ left: 0, right: 0, top: extra, bottom: extra }); }
                }}>{label}</button>
              ))}
            </span>
          </div>
        )}

        {painting && (
          <div className="brushbar">
            <Segmented size="s" value={erase ? "erase" : "brush"} onChange={(v) => setErase(v === "erase")}
              options={[{ value: "brush", label: <><Brush size={13} /> Pincel</>, title: "Pincel (B)" }, { value: "erase", label: <><Eraser size={13} /> Borrar</>, title: "Borrador (E)" }]} />
            <label className="row gap-xs small muted" title="Tamaño del pincel ( [ y ] )">
              <span className="brush-dot" style={{ width: Math.min(22, brush / 5 + 4), height: Math.min(22, brush / 5 + 4) }} />
              <input type="range" min={8} max={240} value={brush} onChange={(e) => setBrush(Number(e.target.value))} />
            </label>
            <button className="icon-btn" title={`Deshacer (${modKey}Z)`} onClick={() => mask.current?.undo()}><RotateCcw size={15} /></button>
            <button className="icon-btn" title="Invertir zona" onClick={() => mask.current?.invert()}><FlipHorizontal2 size={15} /></button>
            <button className="icon-btn" title="Borrar todo" onClick={() => mask.current?.clear()} disabled={!hasMask}><Trash2 size={15} /></button>
            <span className="muted small">{hasMask ? (op === "erase" ? "Se borrará lo pintado" : "Se cambiará sólo la zona pintada") : op === "inpainting" ? "Pinta la zona a cambiar" : op === "erase" ? "Pinta lo que quieres borrar" : "Opcional: pinta para limitar el cambio a una zona"}</span>
          </div>
        )}

        <div className="editbar">
          <div className="editbar-intent">
            <span className="intent-domain">{label(OPERATION_LABEL, effectiveOp)}</span>
            <span className="muted">{meta.hint}</span>
          </div>
          <div className="editbar-row">
            <input
              className="editbar-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={meta.placeholder}
              disabled={op === "background_removal" || op === "erase"}
              onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && submit()}
            />
            {(effectiveOp === "image_to_image") && (
              <label className="editbar-strength" title="Cuánto puede alejarse de la imagen original">
                <span className="small muted">Intensidad</span>
                <input type="range" min={0.2} max={0.9} step={0.05} value={strength} onChange={(e) => setStrength(Number(e.target.value))} />
                <span className="mono small">{Math.round(strength * 100)}%</span>
              </label>
            )}
            {!["background_removal", "erase"].includes(effectiveOp) && (
              <>
                <select value={presetId} onChange={(e) => setPresetId(e.target.value)} title="Estilo">
                  {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <Segmented size="s" value={count} onChange={setCount} options={[1, 2, 3, 4].map((n) => ({ value: n, label: n, title: `${n} variación(es)` }))} />
              </>
            )}
            <button className="generate" disabled={!canSubmit} onClick={submit} title={disabledReason ?? `Aplicar (${modKey}↵)`}>
              {submitting ? <span className="spinner" /> : <ArrowUp size={18} strokeWidth={2.4} />}
              <span>Aplicar</span>
              <Kbd>{modKey}↵</Kbd>
            </button>
          </div>
          {blocked && <div className="composer-block"><Ban size={13} /> {analysis!.policy.reason}</div>}
        </div>
      </div>

      <aside className="versions">
        <span className="eyebrow">Ediciones de esta imagen</span>
        {activeJobs.map((j) => (
          <div key={j.id} className="version version-active">
            <div className="developing on" style={{ aspectRatio: String(ratio) }}>
              <div className="developing-wash" style={{ opacity: 0.3 + j.progress * 0.6 }} />
              <div className="developing-label"><span className="mono">{Math.round(j.progress * 100)}%</span><span>{j.message}</span></div>
            </div>
            <div className="row between">
              <span className="small">{label(OPERATION_LABEL, j.plan?.operation ?? "auto")}</span>
              <button className="link small" onClick={() => api.cancelJob(j.id)}>Cancelar</button>
            </div>
          </div>
        ))}
        {children.map((a) => (
          <button key={a.id} className="version" onClick={() => setSource(a)} title="Seguir editando desde esta versión">
            <img src={fileUrl(a.path)} alt="" className={`checker ${a.rating === "sensitive" ? "blur" : ""}`} style={{ aspectRatio: String((a.width ?? 1) / (a.height ?? 1)) }} />
            <div className="row between">
              <span className="small">{label(OPERATION_LABEL, a.metadata.operation ?? "")}</span>
              <span className="muted small">{a.saved ? "" : "sin guardar · "}{relativeTime(a.created_at)}</span>
            </div>
            {a.metadata.prompt && <span className="muted small version-prompt">{a.metadata.prompt}</span>}
          </button>
        ))}
        {children.length === 0 && activeJobs.length === 0 && (
          <p className="muted small">Cada edición aparece aquí como una versión nueva. El original nunca se modifica; haz clic en una versión para seguir editando desde ella.</p>
        )}
        {jobs.filter((j) => j.input_asset_id === source.id && (j.status === "failed" || j.status === "rejected")).slice(0, 2).map((j) => (
          <div key={j.id} className="version-error">
            <StatusPill status={j.status} />
            <span className="small">{j.error}</span>
          </div>
        ))}
      </aside>
    </div>
  );
}
