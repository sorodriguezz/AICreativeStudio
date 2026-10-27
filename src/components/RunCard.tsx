import { BookmarkPlus, CircleSlash, Copy, MoreHorizontal, PenLine, RotateCcw, Sparkles } from "lucide-react";
import { useState } from "react";
import { api, isTerminal, type Asset, type Job } from "../lib/api";
import { aspectRatio, relativeTime } from "../lib/format";
import { Popover, StatusPill, Thumb } from "./ui";
import { useAssetActions } from "./AssetActions";

interface Props {
  job: Job;
  assets: Asset[];
  presetName?: string;
  onOpen: (asset: Asset) => void;
  onReusePrompt: (job: Job) => void;
  onVariations: (job: Job) => void;
}

const ROW_HEIGHT = 248;

/** Una "tirada": el prompt, sus ajustes y las imágenes que produjo (o las que se están revelando). */
export default function RunCard({ job, assets, presetName, onOpen, onReusePrompt, onVariations }: Props) {
  const [menu, setMenu] = useState(false);
  const actions = useAssetActions();
  const unsaved = assets.filter((a) => !a.saved);
  const active = !isTerminal(job.status);
  const pose = job.params.pose as { width: number; height: number } | undefined;
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const aspect = pose ? `${pose.width / gcd(pose.width, pose.height)}:${pose.height / gcd(pose.width, pose.height)}` : (job.params.aspect as string | undefined) ?? job.intent?.aspect ?? "1:1";
  const count = Number(job.params.count ?? 1);
  const ratio = aspectRatio(aspect);

  return (
    <article className={`run ${active ? "run-active" : ""}`}>
      <header className="run-head">
        <p className="run-prompt">{job.prompt}</p>
        <div className="run-meta">
          {presetName && presetName !== "Libre" && <span>{presetName}</span>}
          <span className="mono">{aspect}</span>
          {job.params.seed !== undefined && <span className="mono">seed {String(job.params.seed)}</span>}
          <span>{relativeTime(job.created_at)}</span>
          {job.status !== "completed" && <StatusPill status={job.status} />}
        </div>
        <div className="run-actions">
          {active ? (
            <button className="btn btn-ghost btn-s" onClick={() => api.cancelJob(job.id)}><CircleSlash size={14} /> Cancelar</button>
          ) : (
            <>
              {actions && unsaved.length > 1 && (
                <button className="btn btn-ghost btn-s" onClick={() => actions.toggleSave(unsaved, true)} title="Agregar todas las de esta tirada a la biblioteca"><BookmarkPlus size={14} /> Guardar todas</button>
              )}
              <button className="icon-btn" title="Variaciones" onClick={() => onVariations(job)}><Sparkles size={16} /></button>
              <button className="icon-btn" title="Editar prompt" onClick={() => onReusePrompt(job)}><PenLine size={16} /></button>
              <div className="anchor">
                <button className="icon-btn" title="Más" onClick={() => setMenu((v) => !v)}><MoreHorizontal size={16} /></button>
                <Popover open={menu} onClose={() => setMenu(false)} align="right" className="menu">
                  <button onClick={() => { navigator.clipboard.writeText(job.prompt); setMenu(false); }}><Copy size={14} /> Copiar prompt</button>
                  <button onClick={() => { onVariations({ ...job, params: { ...job.params } }); setMenu(false); }}><RotateCcw size={14} /> Repetir</button>
                </Popover>
              </div>
            </>
          )}
        </div>
      </header>

      {job.error ? (
        <p className={job.status === "rejected" ? "notice notice-block" : "notice notice-error"}>{job.error}</p>
      ) : (
        <div className="run-images">
          {assets.map((a) => <Thumb key={a.id} asset={a} height={ROW_HEIGHT} onOpen={() => onOpen(a)} onToggleSave={actions ? () => actions.toggleSave([a], !a.saved) : undefined} />)}
          {active &&
            Array.from({ length: Math.max(0, count - assets.length) }, (_, i) => {
              const perImage = 1 / count;
              const local = Math.max(0, Math.min(1, (job.progress - i * perImage) / perImage));
              return (
                <div key={i} className={`developing ${local > 0 ? "on" : ""}`} style={{ height: ROW_HEIGHT, width: ROW_HEIGHT * ratio }}>
                  <div className="developing-wash" style={{ opacity: 0.25 + local * 0.6 }} />
                  <div className="developing-label">
                    <span className="mono">{Math.round(local * 100)}%</span>
                    <span>{local === 0 ? (job.status === "queued" ? "En cola" : "Preparando…") : "Revelando"}</span>
                  </div>
                </div>
              );
            })}
        </div>
      )}
      {active && job.message && <p className="run-status muted small">{job.message}</p>}
    </article>
  );
}
