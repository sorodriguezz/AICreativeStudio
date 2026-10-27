import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { BookmarkCheck, BookmarkPlus, Check, Download, FolderOpen, Shapes, Trash2, X } from "lucide-react";
import { api, fileUrl, type Asset, type BrandKit, type ExportTarget, type Job } from "../lib/api";
import { ALL_PRESETS, EXPORT_GROUPS } from "../lib/exportPresets";
import { errorText, useJobUpdates } from "../lib/hooks";
import { Progress, Segmented } from "./ui";
import { useToast } from "./Toasts";

interface Actions {
  openIn: (page: "edit" | "enhance" | "photo" | "restore", asset: Asset) => void;
  exportAsset: (asset: Asset) => void;
  vectorize: (asset: Asset) => Promise<void>;
  createKit: (asset: Asset) => void;
  /** Pide confirmación y elimina; `onDone` recibe los ids que se borraron. */
  remove: (assets: Asset[], onDone?: (ids: string[]) => void) => void;
  /** Agrega a la biblioteca (o quita) y avisa al resto de la app. */
  toggleSave: (assets: Asset[], saved: boolean) => Promise<void>;
}

const Ctx = createContext<Actions | null>(null);
export const useAssetActions = () => useContext(Ctx);

export const isVector = (a: Asset) => a.path.toLowerCase().endsWith(".svg");

export function AssetActionsProvider({ children, openIn, onKitCreated }: { children: ReactNode; openIn: Actions["openIn"]; onKitCreated: (kit: BrandKit) => void }) {
  const toast = useToast();
  const [exporting, setExporting] = useState<Asset | null>(null);
  const [kitFor, setKitFor] = useState<Asset | null>(null);
  const [removing, setRemoving] = useState<{ assets: Asset[]; onDone?: (ids: string[]) => void } | null>(null);

  const vectorize = useCallback(async (asset: Asset) => {
    try {
      const svg = await api.vectorizeAsset(asset.id);
      toast({ tone: "success", title: "SVG listo", body: "Se guardó como versión nueva de la imagen.", image: fileUrl(svg.path), action: { label: "Mostrar", run: () => revealItemInDir(svg.path) } });
    } catch (e) {
      toast({ tone: "error", title: "No se pudo vectorizar", body: errorText(e) });
    }
  }, [toast]);

  const remove = useCallback((assets: Asset[], onDone?: (ids: string[]) => void) => {
    if (assets.length) setRemoving({ assets, onDone });
  }, []);
  const toggleSave = useCallback(async (assets: Asset[], saved: boolean) => {
    try {
      await api.setAssetsSaved(assets.map((a) => a.id), saved);
      const n = assets.length;
      toast(saved
        ? { tone: "success", title: n === 1 ? "Agregada a la biblioteca" : `${n} imágenes agregadas a la biblioteca`, image: n === 1 ? fileUrl(assets[0].path) : undefined }
        : { tone: "info", title: "Quitada de la biblioteca", body: "Sigue en su sesión; se borrará si borras la sesión." });
    } catch (e) {
      toast({ tone: "error", title: "No se pudo actualizar la biblioteca", body: errorText(e) });
    }
  }, [toast]);
  const value = useMemo<Actions>(() => ({ openIn, exportAsset: setExporting, vectorize, createKit: setKitFor, remove, toggleSave }), [openIn, vectorize, remove, toggleSave]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {exporting && <ExportDialog asset={exporting} onClose={() => setExporting(null)} />}
      {removing && <DeleteDialog assets={removing.assets} onClose={() => setRemoving(null)} onDeleted={(ids) => { setRemoving(null); removing.onDone?.(ids); }} />}
      {kitFor && <CreateKitDialog asset={kitFor} onClose={() => setKitFor(null)} onCreated={(k) => { setKitFor(null); onKitCreated(k); }} />}
    </Ctx.Provider>
  );
}

/** Botón para la imagen que se está viendo en un editor: agregarla a la biblioteca o mostrar que ya está. */
export function SaveToggle({ asset }: { asset: Asset }) {
  const actions = useAssetActions();
  const [saved, setSaved] = useState(asset.saved);
  useEffect(() => setSaved(asset.saved), [asset.id, asset.saved]);
  if (!actions || asset.kind === "original") return null;
  const toggle = async () => {
    await actions.toggleSave([asset], !saved);
    setSaved(!saved);
  };
  return saved ? (
    <button className="btn btn-ghost btn-s save-toggle on" onClick={toggle} title="Clic para quitarla de la biblioteca"><BookmarkCheck size={14} /> En la biblioteca</button>
  ) : (
    <button className="btn btn-s save-toggle" onClick={toggle}><BookmarkPlus size={14} /> Agregar a la biblioteca</button>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // En un portal: un ancestro con backdrop-filter (la barra superior) encerraría el position: fixed.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={`modal ${wide ? "modal-wide" : ""}`} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <header className="modal-head">
          <h2 className="display">{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Cerrar"><X size={18} /></button>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ---------- Exportar ----------

type Bg = "transparent" | "#FFFFFF" | "#000000" | "custom";

function ExportDialog({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const toast = useToast();
  const vector = isVector(asset);
  const [selected, setSelected] = useState<Set<string>>(new Set(["orig"]));
  const [format, setFormat] = useState<"png" | "jpg" | "webp">("png");
  const [fit, setFit] = useState<"cover" | "contain">("cover");
  const [bg, setBg] = useState<Bg>("transparent");
  const [custom, setCustom] = useState("#F4F0E8");
  const [quality, setQuality] = useState(90);
  const [dest, setDest] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ dir: string; files: string[] } | null>(null);

  const toggle = (id: string) => setSelected((s) => {
    const next = new Set(s);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const background = bg === "custom" ? custom : bg;
  const effectiveBg = format === "jpg" && background === "transparent" ? "#FFFFFF" : background;

  async function chooseDest() {
    const dir = await open({ directory: true, multiple: false, title: "Carpeta de destino" });
    if (dir) setDest(dir as string);
  }

  async function run() {
    const targets: ExportTarget[] = ALL_PRESETS.filter((p) => selected.has(p.id)).map((p) => ({
      ...p.target,
      format: p.target.format ?? format,
      fit: p.target.fit ?? fit,
      background: p.target.format === "ico" || p.target.format === "svg" ? "transparent" : p.target.fit === "contain" && background === "transparent" && format !== "jpg" ? "transparent" : effectiveBg,
      quality,
    }));
    setBusy(true);
    try {
      setDone(await api.exportAsset(asset.id, targets, dest ?? undefined));
    } catch (e) {
      toast({ tone: "error", title: "No se pudo exportar", body: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Modal title="Exportación lista" onClose={onClose}>
        <div className="modal-body stack gap-s">
          <p className="muted">{done.files.length} {done.files.length === 1 ? "archivo" : "archivos"} en</p>
          <p className="mono small selectable">{done.dir}</p>
          <ul className="export-files">
            {done.files.map((f) => <li key={f} className="mono small"><Check size={12} /> {f.split(/[\\/]/).pop()}</li>)}
          </ul>
        </div>
        <footer className="modal-foot">
          <button className="btn" onClick={() => revealItemInDir(done.files[0])}><FolderOpen size={15} /> Mostrar en carpeta</button>
          <button className="btn btn-primary" onClick={onClose}>Listo</button>
        </footer>
      </Modal>
    );
  }

  return (
    <Modal title="Exportar" onClose={onClose} wide>
      <div className="export">
        <div className="export-preview checker">
          <img src={fileUrl(asset.path)} alt="" />
          <span className="mono small">{asset.width}×{asset.height}</span>
        </div>
        <div className="export-options">
          {EXPORT_GROUPS.map((g) => (
            <section key={g.title}>
              <span className="eyebrow">{g.title}</span>
              <div className="export-presets">
                {g.presets.filter((p) => !(vector && p.id === "svg")).map((p) => (
                  <button key={p.id} className={`export-preset ${selected.has(p.id) ? "on" : ""}`} onClick={() => toggle(p.id)}>
                    <span className="export-check">{selected.has(p.id) && <Check size={12} strokeWidth={3} />}</span>
                    <span className="grow">
                      <strong>{p.label}</strong>
                      <span className="muted small">{p.detail}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))}

          <section className="export-settings">
            <label className="field">
              <span>Formato de imagen</span>
              <Segmented value={format} onChange={setFormat} options={[{ value: "png", label: "PNG" }, { value: "jpg", label: "JPG" }, { value: "webp", label: "WebP" }]} />
            </label>
            <label className="field">
              <span>Si la proporción no coincide</span>
              <Segmented value={fit} onChange={setFit} options={[{ value: "cover", label: "Recortar" }, { value: "contain", label: "Ajustar completa" }]} />
            </label>
            <label className="field">
              <span>Fondo</span>
              <div className="row gap-xs">
                <Segmented value={bg} onChange={setBg} options={[
                  { value: "transparent", label: "Transparente" }, { value: "#FFFFFF", label: "Blanco" }, { value: "#000000", label: "Negro" }, { value: "custom", label: "Color" },
                ]} />
                {bg === "custom" && <input type="color" value={custom} onChange={(e) => setCustom(e.target.value.toUpperCase())} className="color-input" />}
              </div>
              {format === "jpg" && background === "transparent" && <span className="muted small">JPG no admite transparencia: se usará blanco.</span>}
            </label>
            {format !== "png" && (
              <label className="field">
                <span>Calidad {quality}%</span>
                <input type="range" min={60} max={100} value={quality} onChange={(e) => setQuality(Number(e.target.value))} className="range" />
              </label>
            )}
          </section>
        </div>
      </div>
      <footer className="modal-foot">
        <button className="btn btn-ghost" onClick={chooseDest} title={dest ?? undefined}>
          <FolderOpen size={15} /> {dest ? `…/${dest.split(/[\\/]/).slice(-2).join("/")}` : "Carpeta del proyecto"}
        </button>
        <span className="grow" />
        <button className="btn btn-primary" disabled={!selected.size || busy} onClick={run}>
          {busy ? <span className="spinner" /> : <Download size={15} />} Exportar {selected.size} {selected.size === 1 ? "archivo" : "archivos"}
        </button>
      </footer>
    </Modal>
  );
}

// ---------- Eliminar ----------

function DeleteDialog({ assets, onClose, onDeleted }: { assets: Asset[]; onClose: () => void; onDeleted: (ids: string[]) => void }) {
  const toast = useToast();
  const [versions, setVersions] = useState(0);
  const [withVersions, setWithVersions] = useState(false);
  const [busy, setBusy] = useState(false);
  const one = assets.length === 1;

  useEffect(() => {
    api.deletionPreview(assets.map((a) => a.id)).then((p) => setVersions(p.versions)).catch(() => undefined);
  }, [assets]);

  async function run() {
    setBusy(true);
    try {
      const ids = await api.deleteAssets(assets.map((a) => a.id), withVersions);
      toast({ tone: "success", title: ids.length === 1 ? "Imagen eliminada" : `${ids.length} imágenes eliminadas` });
      onDeleted(ids);
    } catch (e) {
      toast({ tone: "error", title: "No se pudo eliminar", body: errorText(e) });
      setBusy(false);
    }
  }

  const total = assets.length + (withVersions ? versions : 0);
  return (
    <Modal title={one ? "Eliminar imagen" : `Eliminar ${assets.length} imágenes`} onClose={onClose}>
      <div className="modal-body stack gap-s">
        <div className="delete-preview">
          {assets.slice(0, 6).map((a) => <img key={a.id} src={fileUrl(a.path)} alt="" className={`checker ${a.rating === "sensitive" ? "blur" : ""}`} />)}
          {assets.length > 6 && <span className="delete-more mono">+{assets.length - 6}</span>}
        </div>
        <p>{one ? "Se borrará de la app y de tu disco." : "Se borrarán de la app y de tu disco."} No se puede deshacer.</p>
        {versions > 0 && (
          <label className="check-row">
            <input type="checkbox" checked={withVersions} onChange={(e) => setWithVersions(e.target.checked)} />
            <span>
              Eliminar también {versions === 1 ? "la edición hecha" : `las ${versions} ediciones hechas`} a partir de {one ? "ella" : "ellas"}
              <span className="muted small block">{withVersions ? "Se borra toda la rama de versiones." : "Si no, las ediciones se conservan como imágenes sueltas."}</span>
            </span>
          </label>
        )}
        <p className="muted small">Los archivos que exportaste a otras carpetas no se tocan.</p>
      </div>
      <footer className="modal-foot">
        <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <span className="grow" />
        <button className="btn btn-danger" disabled={busy} onClick={run} autoFocus>
          {busy ? <span className="spinner" /> : <Trash2 size={15} />} Eliminar{total > 1 ? ` ${total}` : ""}
        </button>
      </footer>
    </Modal>
  );
}

// ---------- Crear kit de marca ----------

function guessName(prompt?: string) {
  const m = prompt?.match(/(?:llamad[ao]|named|marca)\s+["“]?([A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ]+(?:\s[A-ZÁÉÍÓÚÑ][\wáéíóúñ]+)?)/);
  return m?.[1] ?? "";
}

function CreateKitDialog({ asset, onClose, onCreated }: { asset: Asset; onClose: () => void; onCreated: (kit: BrandKit) => void }) {
  const toast = useToast();
  const [name, setName] = useState(guessName(asset.metadata.prompt));
  const [stage, setStage] = useState<"idle" | "building" | "needs_bg" | "removing">("idle");
  const [progress, setProgress] = useState(0);
  const pendingJob = useRef<string | null>(null);

  const build = useCallback(async (assetId: string) => {
    setStage("building");
    try {
      onCreated(await api.createBrandKit(assetId, name || "Mi marca"));
    } catch (e) {
      if (errorText(e).includes("needs_transparency")) setStage("needs_bg");
      else {
        setStage("idle");
        toast({ tone: "error", title: "No se pudo crear el kit", body: errorText(e) });
      }
    }
  }, [name, onCreated, toast]);

  useJobUpdates(useCallback((job: Job) => {
    if (job.id !== pendingJob.current) return;
    setProgress(job.progress);
    if (job.status === "completed" && job.output_asset_id) {
      pendingJob.current = null;
      build(job.output_asset_id);
    } else if (["failed", "rejected", "cancelled"].includes(job.status)) {
      pendingJob.current = null;
      setStage("needs_bg");
      toast({ tone: "error", title: "No se pudo quitar el fondo", body: job.error ?? "" });
    }
  }, [build, toast]));

  async function removeBackground() {
    setStage("removing");
    try {
      const job = await api.createJob({ project_id: asset.project_id, mode: "brand", prompt: "", params: { operation: "background_removal" }, input_asset_id: asset.id });
      if (job.status === "failed" || job.status === "rejected") throw new Error(job.error ?? "No disponible");
      pendingJob.current = job.id;
    } catch (e) {
      setStage("needs_bg");
      toast({ tone: "error", title: "No se pudo quitar el fondo", body: errorText(e) });
    }
  }

  return (
    <Modal title="Crear kit de marca" onClose={onClose}>
      <div className="modal-body kit-create">
        <div className="kit-create-logo checker"><img src={fileUrl(asset.path)} alt="" /></div>
        <div className="stack gap-s grow">
          <label className="field">
            <span>Nombre de la marca</span>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Café Aurora" onKeyDown={(e) => e.key === "Enter" && stage === "idle" && build(asset.id)} />
          </label>
          <p className="muted small">Se generan: logo PNG y SVG, versiones sobre claro, oscuro y color de marca, monocromos, favicon .ico, íconos de app, avatares, portada, paleta (JSON y CSS) y una guía de marca en HTML.</p>
          {stage === "needs_bg" && (
            <div className="notice notice-block">Este logo tiene fondo. Para el kit necesitamos el logo recortado: lo quitamos automáticamente y seguimos.</div>
          )}
          {stage === "removing" && (
            <div className="stack gap-xs"><Progress value={progress} /><span className="muted small">Quitando el fondo…</span></div>
          )}
        </div>
      </div>
      <footer className="modal-foot">
        <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <span className="grow" />
        {stage === "needs_bg" ? (
          <button className="btn btn-primary" onClick={removeBackground}><Shapes size={15} /> Quitar fondo y crear kit</button>
        ) : (
          <button className="btn btn-primary" disabled={stage !== "idle"} onClick={() => build(asset.id)}>
            {stage === "building" || stage === "removing" ? <span className="spinner" /> : <Shapes size={15} />} Crear kit
          </button>
        )}
      </footer>
    </Modal>
  );
}
