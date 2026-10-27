import { useCallback, useEffect, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { BookmarkCheck, BookmarkPlus, Camera, ChevronLeft, ChevronRight, Copy, Dices, Download, FolderOpen, History, Image as ImageIcon, Maximize2, PenLine, PenTool, Shapes, Sparkles, Trash2, Wand2, X } from "lucide-react";
import { isVector, useAssetActions } from "./AssetActions";
import { ValidationPanel } from "./photo/ValidationBadge";
import { fileUrl, type Asset } from "../lib/api";
import { relativeTime } from "../lib/format";

export interface ViewerActions {
  onReusePrompt?: (asset: Asset) => void;
  onReuseSeed?: (asset: Asset) => void;
  onVariations?: (asset: Asset) => void;
  onEdit?: (asset: Asset) => void;
  onEnhance?: (asset: Asset) => void;
  /** Biblioteca: elegir la imagen como portada del proyecto. */
  onSetCover?: (asset: Asset) => void;
  coverId?: string | null;
}

interface Props extends ViewerActions {
  assets: Asset[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}

export default function Viewer({ assets, index, onIndex, onClose, onReusePrompt, onReuseSeed, onVariations, onEdit, onEnhance, onSetCover, coverId }: Props) {
  const asset = assets[index];
  const actions = useAssetActions();
  const [copied, setCopied] = useState(false);
  const [reveal, setReveal] = useState(false);
  const go = useCallback((d: number) => onIndex((index + d + assets.length) % assets.length), [index, assets.length, onIndex]);

  // Si se elimina la imagen abierta, la lista se achica: seguimos con la siguiente o cerramos.
  useEffect(() => {
    if (!assets.length) onClose();
    else if (index >= assets.length) onIndex(assets.length - 1);
  }, [assets.length, index, onIndex, onClose]);

  const remove = useCallback(() => asset && actions?.remove([asset]), [asset, actions]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector(".modal-backdrop")) return; // un diálogo encima tiene el teclado
      if (e.key === "Escape") onClose();
      else if (e.key === "Delete" || (e.key === "Backspace" && (e.metaKey || e.ctrlKey))) remove();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose, remove]);

  useEffect(() => setReveal(false), [asset?.id]);

  if (!asset) return null;
  const sensitive = asset.rating === "sensitive" && !reveal;

  async function copyPrompt() {
    await navigator.clipboard.writeText(asset.metadata.prompt ?? "");
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const act = (fn?: (a: Asset) => void) => fn && (() => { fn(asset); onClose(); });

  return (
    <div className="viewer" onClick={onClose}>
      <div className="viewer-stage" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn viewer-close" onClick={onClose} aria-label="Cerrar (Esc)"><X size={18} /></button>
        {assets.length > 1 && (
          <>
            <button className="viewer-nav viewer-prev" onClick={() => go(-1)} aria-label="Anterior"><ChevronLeft size={22} /></button>
            <button className="viewer-nav viewer-next" onClick={() => go(1)} aria-label="Siguiente"><ChevronRight size={22} /></button>
          </>
        )}
        <img key={asset.id} src={fileUrl(asset.path)} alt={asset.metadata.prompt ?? ""} className={sensitive ? "blur" : ""} />
        {sensitive && <button className="btn viewer-reveal" onClick={() => setReveal(true)}>Mostrar contenido sensible</button>}
        {assets.length > 1 && <span className="viewer-count mono">{index + 1} / {assets.length}</span>}
      </div>

      <aside className="viewer-panel" onClick={(e) => e.stopPropagation()}>
        <span className="eyebrow">{asset.metadata.prompt ? "Prompt" : asset.kind === "original" ? "Imagen importada" : "Edición"}</span>
        <p className="viewer-prompt">{asset.metadata.prompt || asset.metadata.source_name || "Sin prompt"}</p>
        {asset.metadata.prompt && <button className="btn btn-ghost btn-s" onClick={copyPrompt}><Copy size={14} /> {copied ? "Copiado" : "Copiar prompt"}</button>}

        {actions && asset.kind !== "original" && (
          <button className={`btn viewer-save ${asset.saved ? "on" : ""}`} onClick={() => actions.toggleSave([asset], !asset.saved)}>
            {asset.saved ? <><BookmarkCheck size={15} /> En la biblioteca · quitar</> : <><BookmarkPlus size={15} /> Agregar a la biblioteca</>}
          </button>
        )}
        <div className="viewer-actions">
          {onVariations && asset.metadata.prompt && <button className="btn btn-primary" onClick={act(onVariations)}><Sparkles size={15} /> Variaciones</button>}
          {!isVector(asset) && (onEdit || actions) && <button className="btn" onClick={act(onEdit ?? ((a) => actions!.openIn("edit", a)))}><Wand2 size={15} /> Editar imagen</button>}
          {!isVector(asset) && (onEnhance || actions) && <button className="btn" onClick={act(onEnhance ?? ((a) => actions!.openIn("enhance", a)))}><Maximize2 size={15} /> Mejorar · ampliar, luz, ruido, rostros</button>}
          {actions && !isVector(asset) && <button className="btn" onClick={act((a) => actions.openIn("photo", a))}><Camera size={15} /> Retoque de retrato</button>}
          {actions && !isVector(asset) && <button className="btn" onClick={act((a) => actions.openIn("restore", a))}><History size={15} /> Restaurar foto antigua</button>}
          {actions && <button className="btn" onClick={act(actions.exportAsset)}><Download size={15} /> Exportar…</button>}
          {actions && !isVector(asset) && <button className="btn" onClick={() => actions.vectorize(asset)}><PenTool size={15} /> Vectorizar (SVG)</button>}
          {actions && !isVector(asset) && <button className="btn" onClick={act(actions.createKit)}><Shapes size={15} /> Crear kit de marca</button>}
          {onReusePrompt && asset.metadata.prompt && <button className="btn" onClick={act(onReusePrompt)}><PenLine size={15} /> Reusar prompt</button>}
          {onReuseSeed && asset.metadata.seed != null && <button className="btn" onClick={act(onReuseSeed)}><Dices size={15} /> Reusar seed</button>}
          {onSetCover && (
            <button className="btn" onClick={() => onSetCover(asset)} disabled={coverId === asset.id}>
              <ImageIcon size={15} /> {coverId === asset.id ? "Es la portada del proyecto" : "Usar como portada del proyecto"}
            </button>
          )}
          {!asset.path.startsWith("data:") && <button className="btn" onClick={() => revealItemInDir(asset.path)}><FolderOpen size={15} /> Mostrar en carpeta</button>}
          {actions && <button className="btn viewer-delete" onClick={remove} title="Eliminar (Supr)"><Trash2 size={15} /> Eliminar</button>}
        </div>

        {asset.metadata.validation && <ValidationPanel v={asset.metadata.validation} />}
        <dl className="meta">
          <dt>Tamaño</dt>
          <dd className="mono">{asset.width} × {asset.height}</dd>
          {asset.metadata.model_id && <><dt>Modelo</dt><dd className="mono">{asset.metadata.model_id}</dd></>}
          {asset.metadata.seed != null && <><dt>Seed</dt><dd className="mono">{asset.metadata.seed}</dd></>}
          <dt>Creada</dt>
          <dd>{relativeTime(asset.created_at)}</dd>
        </dl>
        <p className="muted small viewer-hint">← → para navegar · Supr para eliminar · Esc para cerrar</p>
      </aside>
    </div>
  );
}
