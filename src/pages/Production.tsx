import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { ArrowDown, ArrowUp, Check, CircleSlash, Copy, FolderOpen, ImagePlus, Layers, Pencil, Play, Plus, Trash2, Workflow as WorkflowIcon, X } from "lucide-react";
import { api, onBatchUpdate, type Asset, type Batch, type BatchItem, type ExportTarget, type Workflow, type WorkflowStep } from "../lib/api";
import { errorText } from "../lib/hooks";
import { relativeTime } from "../lib/format";
import { ALL_PRESETS, EXPORT_GROUPS } from "../lib/exportPresets";
import { importFiles } from "../components/SourcePicker";
import { Empty, PageHeader, Progress, Segmented, StatusPill, Thumb } from "../components/ui";
import { useToast } from "../components/Toasts";

/** Pasos disponibles en el editor de workflows. */
const STEP_TEMPLATES: { id: string; group: string; step: WorkflowStep }[] = [
  { id: "restore-doc", group: "Restaurar", step: { kind: "job", label: "Restaurar (documental)", mode: "restore", params: { operation: "restore", restore_mode: "documental" } } },
  { id: "restore-color", group: "Restaurar", step: { kind: "job", label: "Restaurar y colorear", mode: "restore", params: { operation: "restore", restore_mode: "creativo", colorize: true } } },
  { id: "denoise", group: "Mejorar", step: { kind: "job", label: "Reducir ruido", mode: "enhance", params: { operation: "denoise", strength: 0.8 } } },
  { id: "faces", group: "Mejorar", step: { kind: "job", label: "Recuperar rostros", mode: "enhance", params: { operation: "face_restore", fidelity: 0.7 } } },
  { id: "x2", group: "Mejorar", step: { kind: "job", label: "Ampliar ×2", mode: "enhance", params: { operation: "upscale", scale: 2 } } },
  { id: "x4", group: "Mejorar", step: { kind: "job", label: "Ampliar ×4", mode: "enhance", params: { operation: "upscale", scale: 4 } } },
  { id: "light", group: "Mejorar", step: { kind: "job", label: "Luz suave lateral", mode: "enhance", params: { operation: "relight", azimuth: 160, elevation: 40, kelvin: 5200, strength: 0.6, ambient: 0.45 } } },
  { id: "nobg", group: "Editar", step: { kind: "job", label: "Quitar fondo", mode: "edit", params: { operation: "background_removal" } } },
  { id: "retouch", group: "Retrato", step: { kind: "job", label: "Retoque editorial", mode: "photo", params: { operation: "portrait_retouch", look: "editorial", skin: 0.5 } } },
  { id: "retouch-bw", group: "Retrato", step: { kind: "job", label: "B/N editorial", mode: "photo", params: { operation: "portrait_retouch", look: "bn_editorial", skin: 0.4 } } },
];

const describe = (s: WorkflowStep) => s.label || (s.kind === "export" ? `Exportar (${s.targets.length})` : String(s.params.operation));

export default function Production({ projectId }: { projectId: string }) {
  const [tab, setTab] = useState<"workflows" | "batches">("workflows");
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [editing, setEditing] = useState<Workflow | "new" | null>(null);
  const [running, setRunning] = useState<Workflow | null>(null);
  const [focusBatch, setFocusBatch] = useState<string | null>(null);

  const load = useCallback(() => api.workflows().then(setWorkflows), []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="page">
      <PageHeader
        eyebrow="Producción"
        title="Workflows y lotes"
        subtitle="Encadena pasos una vez y aplícalos a cien fotos. Cada resultado queda como versión de su original."
        actions={<Segmented value={tab} onChange={setTab} options={[{ value: "workflows", label: <><WorkflowIcon size={14} /> Workflows</> }, { value: "batches", label: <><Layers size={14} /> Lotes</> }]} />}
      />
      {tab === "workflows" ? (
        <div className="workflows">
          {workflows.map((w) => (
            <article key={w.id} className="workflow">
              <div className="row between">
                <h3>{w.name}</h3>
                {w.builtin && <span className="chip chip-ghost">incluido</span>}
              </div>
              <p className="muted small">{w.description}</p>
              <ol className="steps">
                {w.steps.map((s, i) => <li key={i}><span className="mono muted">{i + 1}</span> {describe(s)}</li>)}
              </ol>
              <div className="row gap-xs">
                <button className="btn btn-primary btn-s" onClick={() => setRunning(w)}><Play size={13} /> Usar</button>
                {w.builtin ? (
                  <button className="btn btn-ghost btn-s" onClick={() => setEditing({ ...w, id: "", name: `${w.name} (copia)`, builtin: false })}><Copy size={13} /> Duplicar</button>
                ) : (
                  <>
                    <button className="btn btn-ghost btn-s" onClick={() => setEditing(w)}><Pencil size={13} /> Editar</button>
                    <button className="btn btn-ghost btn-s danger" onClick={async () => { if (confirm(`¿Eliminar "${w.name}"?`)) { await api.deleteWorkflow(w.id); load(); } }}><Trash2 size={13} /></button>
                  </>
                )}
              </div>
            </article>
          ))}
          <button className="workflow workflow-add" onClick={() => setEditing("new")}><Plus size={22} /> Nuevo workflow</button>
        </div>
      ) : (
        <Batches projectId={projectId} focus={focusBatch} />
      )}
      {editing && <WorkflowEditor initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {running && <StartBatch workflow={running} projectId={projectId} onClose={() => setRunning(null)} onStarted={(id) => { setRunning(null); setFocusBatch(id); setTab("batches"); }} />}
    </div>
  );
}

// ---------- Editor ----------

function WorkflowEditor({ initial, onClose, onSaved }: { initial: Workflow | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [steps, setSteps] = useState<WorkflowStep[]>(initial?.steps ?? []);
  const [exportSel, setExportSel] = useState<Set<string>>(new Set(["ig-post"]));
  const [exportFormat, setExportFormat] = useState<"jpg" | "png" | "webp">("jpg");

  const move = (i: number, d: number) => setSteps((s) => { const n = s.slice(); const [x] = n.splice(i, 1); n.splice(i + d, 0, x); return n; });
  const addExport = () => {
    const targets: ExportTarget[] = ALL_PRESETS.filter((p) => exportSel.has(p.id)).map((p) => ({ ...p.target, format: p.target.format ?? exportFormat, fit: p.target.fit ?? "cover", quality: 90 }));
    if (targets.length) setSteps((s) => [...s, { kind: "export", label: `Exportar ${targets.map((t) => t.name).join(", ")}`, targets }]);
  };

  async function save() {
    try {
      await api.saveWorkflow({ id: initial?.id || undefined, name, description, steps });
      onSaved();
    } catch (e) {
      toast({ tone: "error", title: "No se pudo guardar", body: errorText(e) });
    }
  }

  const groups = [...new Set(STEP_TEMPLATES.map((t) => t.group))];
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal modal-wide" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head"><h2 className="display">{initial?.id ? "Editar workflow" : "Nuevo workflow"}</h2><button className="icon-btn" onClick={onClose}><X size={18} /></button></header>
        <div className="modal-body wf-editor">
          <div className="stack gap-s">
            <label className="field"><span>Nombre</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Catálogo de primavera" autoFocus /></label>
            <label className="field"><span>Descripción</span><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Para qué sirve" /></label>
            <span className="eyebrow">Pasos (en orden)</span>
            <ol className="wf-steps">
              {steps.map((s, i) => (
                <li key={i}>
                  <span className="mono muted">{i + 1}</span>
                  <span className="grow">{describe(s)}</span>
                  <button className="icon-btn icon-btn-s" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={13} /></button>
                  <button className="icon-btn icon-btn-s" disabled={i === steps.length - 1} onClick={() => move(i, 1)}><ArrowDown size={13} /></button>
                  <button className="icon-btn icon-btn-s" onClick={() => setSteps((x) => x.filter((_, j) => j !== i))}><Trash2 size={13} /></button>
                </li>
              ))}
              {steps.length === 0 && <li className="muted small">Agrega pasos desde la derecha.</li>}
            </ol>
          </div>
          <div className="stack gap-s wf-palette">
            {groups.map((g) => (
              <div key={g} className="stack gap-xs">
                <span className="eyebrow">{g}</span>
                <div className="row gap-xs wrap">
                  {STEP_TEMPLATES.filter((t) => t.group === g).map((t) => (
                    <button key={t.id} className="chip chip-button" onClick={() => setSteps((s) => [...s, t.step])}><Plus size={11} /> {t.step.label}</button>
                  ))}
                </div>
              </div>
            ))}
            <div className="stack gap-xs">
              <span className="eyebrow">Exportar</span>
              <div className="row gap-xs wrap">
                {EXPORT_GROUPS.flatMap((g) => g.presets).filter((p) => !p.original).map((p) => (
                  <button key={p.id} className={`chip chip-button ${exportSel.has(p.id) ? "active" : ""}`} onClick={() => setExportSel((s) => { const n = new Set(s); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; })}>{p.label}</button>
                ))}
              </div>
              <div className="row gap-xs">
                <Segmented size="s" value={exportFormat} onChange={setExportFormat} options={[{ value: "jpg", label: "JPG" }, { value: "png", label: "PNG" }, { value: "webp", label: "WebP" }]} />
                <button className="btn btn-s" onClick={addExport} disabled={!exportSel.size}><Plus size={13} /> Agregar exportación</button>
              </div>
            </div>
          </div>
        </div>
        <footer className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <span className="grow" />
          <button className="btn btn-primary" disabled={!name.trim() || !steps.length} onClick={save}><Check size={15} /> Guardar workflow</button>
        </footer>
      </div>
    </div>
  );
}

// ---------- Lanzar un lote ----------

function StartBatch({ workflow, projectId, onClose, onStarted }: { workflow: Workflow; projectId: string; onClose: () => void; onStarted: (id: string) => void }) {
  const toast = useToast();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dest, setDest] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.assets({ projectId, limit: 500 }).then((list) => setAssets(list.filter((a) => !a.path.endsWith(".svg")))), [projectId]);
  useEffect(() => { load(); }, [load]);
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function importMany() {
    const picked = await open({ multiple: true, filters: [{ name: "Imágenes", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff"] }] });
    if (!picked) return;
    setBusy(true);
    try {
      const added = await importFiles(projectId, (Array.isArray(picked) ? picked : [picked]) as string[]);
      await load();
      setSelected((s) => new Set([...s, ...added.map((a) => a.id)]));
    } catch (e) {
      toast({ tone: "error", title: "No se pudo importar", body: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    try {
      onStarted(await api.startBatch(projectId, workflow.id, [...selected], dest ?? undefined));
      toast({ tone: "info", title: `Lote iniciado: ${workflow.name}`, body: `${selected.size} imágenes` });
    } catch (e) {
      toast({ tone: "error", title: "No se pudo iniciar el lote", body: errorText(e) });
    }
  }

  const hasExport = workflow.steps.some((s) => s.kind === "export");
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal modal-wide" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head"><h2 className="display">{workflow.name}</h2><button className="icon-btn" onClick={onClose}><X size={18} /></button></header>
        <div className="modal-body stack gap-s">
          <div className="row between">
            <span className="small muted">{workflow.steps.map(describe).join(" → ")}</span>
            <span className="row gap-xs">
              <button className="btn btn-s" onClick={importMany} disabled={busy}>{busy ? <span className="spinner" /> : <ImagePlus size={14} />} Importar varias…</button>
              <button className="btn btn-ghost btn-s" onClick={() => setSelected(selected.size === assets.length ? new Set() : new Set(assets.map((a) => a.id)))}>{selected.size === assets.length ? "Ninguna" : "Todas"}</button>
            </span>
          </div>
          <div className="batch-pick">
            {assets.map((a) => (
              <div key={a.id} className={`batch-pick-item ${selected.has(a.id) ? "on" : ""}`}>
                <Thumb asset={a} onOpen={() => toggle(a.id)} />
                {selected.has(a.id) && <span className="batch-check"><Check size={12} strokeWidth={3} /></span>}
              </div>
            ))}
            {assets.length === 0 && <Empty title="El proyecto no tiene imágenes">Usa “Importar varias…”.</Empty>}
          </div>
        </div>
        <footer className="modal-foot">
          {hasExport && <button className="btn btn-ghost" onClick={async () => { const d = await open({ directory: true }); if (d) setDest(d as string); }}><FolderOpen size={15} /> {dest ? `…/${dest.split(/[\\/]/).slice(-2).join("/")}` : "Exportar en la carpeta del proyecto"}</button>}
          <span className="grow" />
          <button className="btn btn-primary" disabled={!selected.size} onClick={start}><Play size={15} /> Procesar {selected.size} {selected.size === 1 ? "imagen" : "imágenes"}</button>
        </footer>
      </div>
    </div>
  );
}

// ---------- Lotes ----------

function Batches({ projectId, focus }: { projectId: string; focus: string | null }) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [open_, setOpen] = useState<string | null>(focus);
  const [detail, setDetail] = useState<{ batch: Batch; items: BatchItem[]; workflow: Workflow | null } | null>(null);

  const load = useCallback(() => api.batches(projectId).then(setBatches), [projectId]);
  const loadDetail = useCallback(() => { if (open_) api.batchDetail(open_).then(setDetail); }, [open_]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setOpen(focus); }, [focus]);
  useEffect(() => { loadDetail(); }, [loadDetail]);
  useEffect(() => {
    const off = onBatchUpdate((b) => {
      setBatches((list) => (list.some((x) => x.id === b.id) ? list.map((x) => (x.id === b.id ? b : x)) : [b, ...list]));
      if (b.id === open_) loadDetail();
    });
    return () => void off.then((f) => f());
  }, [open_, loadDetail]);

  const statusText = useMemo(() => ({ running: "En curso", completed: "Completado", partial: "Con errores", failed: "Falló", cancelled: "Cancelado" }), []);
  if (!batches.length) return <Empty icon={<Layers size={22} />} title="Todavía no hay lotes">Elige un workflow y pulsa “Usar”.</Empty>;

  return (
    <div className="batches">
      <div className="batch-list">
        {batches.map((b) => (
          <button key={b.id} className={`batch-row ${open_ === b.id ? "on" : ""}`} onClick={() => setOpen(b.id)}>
            <div className="row between"><strong>{b.name}</strong><span className={`pill pill-${b.status === "running" ? "running" : b.status === "completed" ? "completed" : b.status === "cancelled" ? "" : "failed"}`}>{statusText[b.status]}</span></div>
            <Progress value={(b.done + b.failed) / Math.max(1, b.total)} />
            <span className="muted small">{b.done} de {b.total}{b.failed ? ` · ${b.failed} con error` : ""} · {relativeTime(b.created_at)}</span>
          </button>
        ))}
      </div>
      {detail && (
        <div className="batch-detail">
          <div className="row between">
            <div className="stack gap-xs">
              <h2 className="display">{detail.batch.name}</h2>
              <span className="muted small">{detail.workflow?.steps.map(describe).join(" → ")}</span>
            </div>
            <span className="row gap-xs">
              <button className="btn btn-s" onClick={() => openPath(detail.batch.export_dir).catch(() => undefined)}><FolderOpen size={14} /> Carpeta</button>
              {detail.batch.status === "running" && <button className="btn btn-ghost btn-s danger" onClick={() => api.cancelBatch(detail.batch.id)}><CircleSlash size={14} /> Detener</button>}
            </span>
          </div>
          <div className="batch-items">
            {detail.items.map((it) => (
              <div key={it.id} className={`batch-item batch-item-${it.status}`}>
                <div className="batch-pair">
                  {it.input && <Thumb asset={it.input} onOpen={() => undefined} />}
                  <span className="muted">→</span>
                  {it.output ? <Thumb asset={it.output} onOpen={() => undefined} /> : <div className={`batch-placeholder ${it.status === "running" ? "developing on" : ""}`}>{it.status === "running" && <div className="developing-wash" />}</div>}
                </div>
                <div className="row between small">
                  <StatusPill status={it.status === "pending" ? "queued" : it.status} />
                  {it.status === "running" && detail.workflow && <span className="muted">paso {it.step + 1}/{detail.workflow.steps.length}</span>}
                </div>
                {it.error && <span className="small danger-text">{it.error}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
