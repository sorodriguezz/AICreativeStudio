import { useCallback, useEffect, useMemo, useState } from "react";
import { CircleSlash, History as HistoryIcon, PenLine, RotateCcw, Trash2 } from "lucide-react";
import { api, isTerminal, type Asset, type Job, type JobParams, type Project } from "../lib/api";
import { errorText, useAssetsDeleted, useJobs } from "../lib/hooks";
import { relativeTime } from "../lib/format";
import { DOMAIN_LABEL, OPERATION_LABEL, TASK_LABEL, label } from "../lib/labels";
import { Empty, PageHeader, Segmented, StatusPill, Thumb } from "../components/ui";
import Viewer from "../components/Viewer";
import { useToast } from "../components/Toasts";
import { Modal } from "../components/AssetActions";

type Filter = "all" | "completed" | "problems";

export default function History({ projects, onReuse, onOpenIn }: { projects: Project[]; onReuse: (prompt: string, seed?: number, mode?: "create" | "brand") => void; onOpenIn: (page: "edit" | "enhance", asset: Asset) => void }) {
  const toast = useToast();
  const [projectId, setProjectId] = useState<string>("");
  const [filter, setFilter] = useState<Filter>("all");
  const { jobs, reload } = useJobs(projectId || undefined, 300);
  const [clearing, setClearing] = useState<Job[] | "all" | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [viewer, setViewer] = useState<{ list: Asset[]; index: number } | null>(null);

  const finishedCount = jobs.filter((j) => j.status === "completed").length;
  useEffect(() => {
    api.assets({ projectId: projectId || undefined, limit: 2000, all: true }).then(setAssets);
  }, [projectId, finishedCount]);

  useAssetsDeleted(useCallback((ids: string[]) => {
    setAssets((list) => list.filter((a) => !ids.includes(a.id)));
    setViewer((v) => v && { ...v, list: v.list.filter((a) => !ids.includes(a.id)) });
  }, []));

  const byJob = useMemo(() => {
    const map = new Map<string, Asset[]>();
    for (const a of [...assets].reverse()) if (a.job_id) map.set(a.job_id, [...(map.get(a.job_id) ?? []), a]);
    return map;
  }, [assets]);

  const shown = jobs.filter((j) => filter === "all" || (filter === "completed" ? j.status === "completed" : ["failed", "rejected", "cancelled"].includes(j.status)));
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const studioMode = (job: Job) => (job.mode === "brand" ? "brand" : "create");

  async function rerun(job: Job) {
    try {
      const { seed: _seed, ...params } = job.params as JobParams;
      await api.createJob({ project_id: job.project_id, mode: job.mode, prompt: job.prompt, negative_prompt: job.negative_prompt, params, session_id: job.session_id ?? "new" });
      toast({ tone: "info", title: "Trabajo enviado", body: job.prompt });
    } catch (e) {
      toast({ tone: "error", title: "No se pudo generar", body: errorText(e) });
    }
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow="Historial"
        title="Todo lo que has generado"
        subtitle="Cada trabajo guarda el prompt, lo que la app entendió, el plan que ejecutó y sus resultados."
        actions={
          <>
            <Segmented value={filter} onChange={setFilter} options={[{ value: "all", label: "Todos" }, { value: "completed", label: "Listos" }, { value: "problems", label: "Con problemas" }]} />
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Todos los proyectos</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button className="btn btn-ghost" onClick={() => setClearing("all")} disabled={!jobs.some((j) => isTerminal(j.status))}><Trash2 size={15} /> Borrar historial</button>
          </>
        }
      />

      {shown.length === 0 && <Empty icon={<HistoryIcon size={22} />} title={jobs.length ? "Nada con este filtro" : "Todavía no hay trabajos"} />}

      <div className="history">
        {shown.map((job) => {
          const images = byJob.get(job.id) ?? [];
          return (
            <article key={job.id} className="history-row">
              <div className="history-main">
                <div className="row gap-s wrap">
                  <span className="chip">{label(DOMAIN_LABEL, job.intent?.domain ?? job.mode)}</span>
                  {job.intent?.tasks.map((t) => <span key={t} className="chip chip-ghost">{label(TASK_LABEL, t)}</span>)}
                  <StatusPill status={job.status} />
                </div>
                <p className="history-prompt">{job.prompt || <span className="muted">{label(OPERATION_LABEL, job.plan?.operation ?? "")}</span>}</p>
                <div className="row gap-s muted small">
                  <span>{projectName(job.project_id)}</span>
                  <span>·</span>
                  <span>{relativeTime(job.created_at)}</span>
                  {job.params.aspect !== undefined && <><span>·</span><span className="mono">{String(job.params.aspect)}</span></>}
                </div>
                {job.error && <p className={job.status === "rejected" ? "notice notice-block" : "notice notice-error"}>{job.error}</p>}
                <div className="row gap-xs">
                  {!isTerminal(job.status) ? (
                    <button className="btn btn-ghost btn-s" onClick={() => api.cancelJob(job.id)}><CircleSlash size={14} /> Cancelar</button>
                  ) : (
                    <>
                      {job.status !== "rejected" && !job.input_asset_id && <button className="btn btn-ghost btn-s" onClick={() => rerun(job)}><RotateCcw size={14} /> Repetir</button>}
                      {!job.input_asset_id && <button className="btn btn-ghost btn-s" onClick={() => onReuse(job.prompt, undefined, studioMode(job))}><PenLine size={14} /> Editar prompt</button>}
                      <button className="btn btn-ghost btn-s" onClick={() => setClearing([job])} title="Quitar del historial"><Trash2 size={14} /> Borrar</button>
                    </>
                  )}
                </div>
              </div>
              {images.length > 0 && (
                <div className="history-images">
                  {images.map((a, i) => <Thumb key={a.id} asset={a} height={112} onOpen={() => setViewer({ list: images, index: i })} />)}
                </div>
              )}
            </article>
          );
        })}
      </div>

      {clearing && (
        <ClearHistoryDialog
          jobs={clearing === "all" ? jobs.filter((j) => isTerminal(j.status)) : clearing}
          all={clearing === "all"}
          scope={projectId ? projectName(projectId) : null}
          imagesOf={(j) => byJob.get(j.id)?.length ?? 0}
          onClose={() => setClearing(null)}
          onConfirm={async (withImages) => {
            try {
              const r = await api.deleteHistory(clearing === "all" ? { projectId: projectId || undefined, withImages } : { ids: clearing.map((j) => j.id), withImages });
              toast({ tone: "success", title: r.jobs === 1 ? "Trabajo borrado del historial" : `${r.jobs} trabajos borrados del historial`, body: r.assets.length ? `También se eliminaron ${r.assets.length} imágenes.` : undefined });
              setClearing(null);
              reload();
            } catch (e) {
              toast({ tone: "error", title: "No se pudo borrar", body: errorText(e) });
            }
          }}
        />
      )}

      {viewer && (
        <Viewer
          assets={viewer.list}
          index={viewer.index}
          onIndex={(index) => setViewer({ ...viewer, index })}
          onClose={() => setViewer(null)}
          onReusePrompt={(a) => onReuse(a.metadata.prompt ?? "")}
          onReuseSeed={(a) => onReuse(a.metadata.prompt ?? "", a.metadata.seed ?? undefined)}
          onEdit={(a) => onOpenIn("edit", a)}
          onEnhance={(a) => onOpenIn("enhance", a)}
        />
      )}
    </div>
  );
}

function ClearHistoryDialog({ jobs, all, scope, imagesOf, onClose, onConfirm }: { jobs: Job[]; all: boolean; scope: string | null; imagesOf: (j: Job) => number; onClose: () => void; onConfirm: (withImages: boolean) => Promise<void> }) {
  const [withImages, setWithImages] = useState(false);
  const [busy, setBusy] = useState(false);
  const images = jobs.reduce((n, j) => n + imagesOf(j), 0);
  return (
    <Modal title={all ? (scope ? `Borrar historial de ${scope}` : "Borrar todo el historial") : "Borrar del historial"} onClose={onClose}>
      <div className="modal-body stack gap-s">
        <p>{all ? `Se quitarán ${jobs.length} ${jobs.length === 1 ? "trabajo" : "trabajos"} del historial.` : "Se quitará este trabajo del historial."} No se puede deshacer.</p>
        {images > 0 && (
          <label className="check-row">
            <input type="checkbox" checked={withImages} onChange={(e) => setWithImages(e.target.checked)} />
            <span>
              Eliminar también {images === 1 ? "su imagen" : `sus ${images} imágenes`}
              <span className="muted small block">{withImages ? "Se borran de la biblioteca y de tu disco." : "Si no, las imágenes se quedan en la biblioteca."}</span>
            </span>
          </label>
        )}
        {all && <p className="muted small">Los trabajos que están en curso no se borran.</p>}
      </div>
      <footer className="modal-foot">
        <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <span className="grow" />
        <button className="btn btn-danger" disabled={busy} autoFocus onClick={async () => { setBusy(true); await onConfirm(withImages); setBusy(false); }}>
          {busy ? <span className="spinner" /> : <Trash2 size={15} />} Borrar
        </button>
      </footer>
    </Modal>
  );
}
