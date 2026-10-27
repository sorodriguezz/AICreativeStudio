import { useCallback, useEffect, useState } from "react";
import { Check, Clock, Cpu, Download, HardDrive, Loader2, Trash2 } from "lucide-react";
import { api, type HardwareInfo, type ModelInfo, type PacksInfo } from "../lib/api";
import { errorText } from "../lib/hooks";
import { formatBytes } from "../lib/format";
import { PROFILE_LABEL, TASK_LABEL, label } from "../lib/labels";
import { Empty, PageHeader, Progress } from "../components/ui";

const PROFILE_TEXT: Record<string, string> = {
  full: "Tu equipo puede con todo: resoluciones altas y lotes grandes.",
  balanced: "Funciones principales con buena calidad; resolución y lotes moderados.",
  compatible: "Prioriza tareas livianas; modelos pequeños y resoluciones bajas.",
};

export default function Models({ engineReady }: { engineReady: boolean }) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [hw, setHw] = useState<HardwareInfo | null>(null);
  const [packs, setPacks] = useState<PacksInfo | null>(null);
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!engineReady) return;
    api.models().then(setModels).catch((e) => setError(errorText(e)));
    api.hardware().then(setHw).catch(() => undefined);
    api.modelPacks().then((p) => {
      setPacks(p);
      // Por defecto, los paquetes recomendados que aún falten.
      setChosen((cur) => cur ?? new Set(p.packs.filter((x) => x.recommended && !x.installed && x.available).map((x) => x.id)));
    }).catch(() => undefined);
  }, [engineReady]);
  useEffect(load, [load]);

  async function downloadPacks() {
    if (!packs || !chosen) return;
    const ids = [...new Set(packs.packs.filter((p) => chosen.has(p.id)).flatMap((p) => p.missing))];
    try {
      setError(null);
      await api.queueModels(ids);
      setChosen(new Set());
      load();
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function remove(m: ModelInfo) {
    if (!confirm(`¿Eliminar ${m.name} (${m.size_gb} GB)? Podrás volver a descargarlo cuando quieras.`)) return;
    try {
      await api.deleteModel(m.id);
      load();
    } catch (e) {
      setError(errorText(e));
    }
  }

  const downloading = models.some((m) => m.status === "downloading" || m.status === "queued");
  useEffect(() => {
    if (!downloading) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [downloading, load]);

  async function download(id: string) {
    try {
      setError(null);
      await api.downloadModel(id);
      load();
    } catch (e) {
      setError(errorText(e));
    }
  }

  if (!engineReady)
    return (
      <div className="page">
        <PageHeader eyebrow="Modelos" title="Motores de IA" />
        <Empty icon={<Loader2 size={22} className="spin" />} title="Esperando al motor de IA…" />
      </div>
    );

  const runnable = models.filter((m) => m.backend !== "planned");
  const planned = models.filter((m) => m.backend === "planned");

  return (
    <div className="page">
      <PageHeader eyebrow="Modelos" title="Motores de IA" subtitle="Se descargan una vez desde Hugging Face y se ejecutan siempre en este equipo." />

      {hw && (
        <section className="hw-card">
          <div className="hw-icon"><Cpu size={22} /></div>
          <div className="grow">
            <span className="eyebrow">Perfil {label(PROFILE_LABEL, hw.profile)}</span>
            <strong>{hw.device_name} · {hw.total_memory_gb} GB</strong>
            <p className="muted small">{PROFILE_TEXT[hw.profile]}</p>
          </div>
          <dl className="hw-stats">
            <dt>Resolución máx.</dt><dd className="mono">{hw.defaults.max_side}px</dd>
            <dt>Por trabajo</dt><dd className="mono">{hw.defaults.max_batch} img</dd>
            <dt>Acelerador</dt><dd className="mono">{hw.device.toUpperCase()}</dd>
          </dl>
        </section>
      )}
      {error && <div className="notice notice-error">{error}</div>}

      {packs && <PackPicker packs={packs} chosen={chosen ?? new Set()} onToggle={(id) => setChosen((c) => { const n = new Set(c ?? []); n.has(id) ? n.delete(id) : n.add(id); return n; })} onDownload={downloadPacks} />}

      <div className="section-head">
        <h2 className="display">Todos los motores</h2>
        <span className="muted small">Instala o elimina modelos uno a uno</span>
      </div>
      <div className="models">
        {runnable.map((m) => {
          const recommended = hw ? m.profiles.includes(hw.profile) && !m.dev : false;
          const pct = m.total_bytes ? m.downloaded_bytes / m.total_bytes : 0;
          return (
            <article key={m.id} className={`model ${m.status === "installed" ? "model-installed" : ""} ${m.supported ? "" : "model-unsupported"}`}>
              <div className="row between gap-s">
                <div className="stack gap-xs">
                  <div className="row gap-xs wrap">
                    {recommended && <span className="chip chip-accent">Recomendado</span>}
                    {m.dev && <span className="chip chip-ghost">Solo pruebas</span>}
                  </div>
                  <h3>{m.name}</h3>
                  <span className="mono small muted">{m.repo_id}</span>
                </div>
                {m.status === "installed" ? (
                  <span className="row gap-xs">
                    <span className="pill pill-completed"><Check size={12} /> Instalado</span>
                    <button className="icon-btn icon-btn-s" title="Eliminar para liberar espacio" onClick={() => remove(m)}><Trash2 size={13} /></button>
                  </span>
                ) : !m.supported ? (
                  <span className="pill">No disponible</span>
                ) : m.status === "queued" ? (
                  <span className="pill pill-queued"><Clock size={12} /> En cola</span>
                ) : m.status === "downloading" ? (
                  <span className="pill pill-running"><span className="pill-dot" /> {Math.round(pct * 100)}%</span>
                ) : (
                  <button className="btn" onClick={() => download(m.id)}><Download size={14} /> {m.size_gb} GB</button>
                )}
              </div>
              <p className="small">{m.notes}</p>
              {!m.supported && m.unsupported_reason && <p className="notice small">{m.unsupported_reason}</p>}
              {m.status === "downloading" && (
                <div className="stack gap-xs">
                  <Progress value={pct} />
                  <span className="mono small muted">{formatBytes(m.downloaded_bytes)} de {formatBytes(m.total_bytes)}</span>
                </div>
              )}
              <div className="row gap-xs wrap">
                {m.tasks.map((t) => <span key={t} className="chip chip-ghost">{label(TASK_LABEL, t)}</span>)}
                {m.min_memory_gb > 0 && <span className="chip chip-ghost">≥ {m.min_memory_gb} GB RAM</span>}
              </div>
              <p className="muted small">{m.license}</p>
              {m.error && <p className="notice notice-error">{m.error}</p>}
            </article>
          );
        })}
      </div>

      <div className="section-head">
        <h2 className="display">Próximos motores</h2>
        <span className="muted small">Ya declarados en el registro; llegan con cada fase</span>
      </div>
      <div className="planned">
        {planned.map((m) => (
          <div key={m.id} className="planned-row">
            <span className="mono small muted">{m.notes}</span>
            <strong>{m.name}</strong>
            <span className="muted small">{m.tasks.map((t) => label(TASK_LABEL, t)).join(" · ")}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PackPicker({ packs, chosen, onToggle, onDownload }: { packs: PacksInfo; chosen: Set<string>; onToggle: (id: string) => void; onDownload: () => void }) {
  const selected = packs.packs.filter((p) => chosen.has(p.id));
  const ids = new Set(selected.flatMap((p) => p.missing));
  // El tamaño real descuenta modelos compartidos entre paquetes (p. ej. SDXL o YuNet).
  const bytes = selected.reduce((acc, p) => acc + p.missing_bytes, 0);
  const shared = selected.flatMap((p) => p.missing).length - ids.size;
  const free = packs.free_disk_bytes;
  const fits = bytes + 2e9 <= free;
  return (
    <section className="stack gap-s">
      <div className="packs-head">
        <h2 className="display">Recomendado para tu equipo</h2>
        <span className="muted small">{!packs.torch ? "Modo compatible: sin PyTorch, sólo modelos ONNX" : `Perfil ${packs.profile}`}</span>
      </div>
      <div className="packs">
        {packs.packs.map((p) => {
          const disabled = !p.available || p.installed;
          return (
            <label key={p.id} className={`pack ${chosen.has(p.id) ? "on" : ""} ${disabled ? "disabled" : ""}`} title={p.reason ?? undefined}>
              <input type="checkbox" disabled={disabled} checked={chosen.has(p.id)} onChange={() => onToggle(p.id)} />
              <span className="grow">
                <span className="row gap-xs wrap">
                  <strong>{p.name}</strong>
                  {p.installed ? <span className="chip chip-ghost"><Check size={11} /> instalado</span> : p.recommended ? <span className="chip chip-accent">recomendado</span> : null}
                </span>
                <span className="small muted">{p.description}</span>
                {!p.installed && p.available && <span className="mono small">{formatBytes(p.missing_bytes)}</span>}
                {p.reason && <span className="small muted">{p.reason}</span>}
              </span>
            </label>
          );
        })}
      </div>
      <div className="packs-foot">
        <div className="disk-bar">
          <span className="small"><HardDrive size={12} /> {formatBytes(bytes)} a descargar{shared > 0 ? " (los modelos compartidos se bajan una vez)" : ""} · {formatBytes(free)} libres</span>
          {!fits && bytes > 0 && <span className="small danger-text">No alcanza el espacio (se reservan 2 GB de margen).</span>}
        </div>
        <button className="btn btn-primary" disabled={!selected.length || !fits} onClick={onDownload}><Download size={15} /> Descargar selección</button>
      </div>
    </section>
  );
}
