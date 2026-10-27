import { useEffect, useRef, type ReactNode } from "react";
import { BookmarkCheck, BookmarkPlus, Check, Trash2 } from "lucide-react";
import { fileUrl, type Asset } from "../lib/api";
import ValidationBadge from "./photo/ValidationBadge";
import { STATUS_LABEL, label } from "../lib/labels";

export function PageHeader({ eyebrow, title, subtitle, actions }: { eyebrow?: string; title: ReactNode; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="page-header-text">
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1 className="display">{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="row gap-s">{actions}</div>}
    </header>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <strong>{title}</strong>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}

export function Progress({ value, tone = "accent" }: { value: number; tone?: "accent" | "muted" }) {
  return (
    <div className={`progress progress-${tone}`} role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${Math.max(1.5, Math.min(100, value * 100))}%` }} />
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={`pill pill-${status}`}>
      <span className="pill-dot" />
      {label(STATUS_LABEL, status)}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** Miniatura que respeta la proporción real y difumina contenido sensible. */
/** `onToggleSave`: muestra si la imagen está en la biblioteca y permite agregarla o quitarla. */
export function Thumb({ asset, onOpen, height, onDelete, selected, badge, onToggleSave }: { asset: Asset; onOpen: () => void; height?: number; onDelete?: () => void; selected?: boolean; badge?: string; onToggleSave?: () => void }) {
  const ratio = asset.width && asset.height ? asset.width / asset.height : 1;
  const selecting = selected !== undefined;
  const thumb = (
    <button
      className={`thumb ${selecting ? "selectable" : ""} ${selected ? "selected" : ""}`}
      onClick={onOpen}
      style={height ? { height, width: height * ratio } : { aspectRatio: String(ratio) }}
      title={asset.metadata.prompt}
      aria-pressed={selecting ? selected : undefined}
    >
      <img src={fileUrl(asset.path)} alt={asset.metadata.prompt ?? ""} loading="lazy" className={asset.rating === "sensitive" ? "blur" : ""} draggable={false} />
      {asset.rating === "sensitive" ? <span className="thumb-badge">Sensible</span> : badge && <span className="thumb-badge">{badge}</span>}
      {asset.metadata.validation && <span className="thumb-vbadge"><ValidationBadge v={asset.metadata.validation} compact /></span>}
      {selecting && <span className="thumb-check">{selected && <Check size={13} strokeWidth={3} />}</span>}
    </button>
  );
  if ((!onDelete && !onToggleSave) || selecting) return thumb;
  return (
    <div className="thumb-shell" style={height ? { height, width: height * ratio } : undefined}>
      {thumb}
      {onDelete && <button className="thumb-del" title="Eliminar" aria-label="Eliminar imagen" onClick={onDelete}><Trash2 size={14} /></button>}
      {onToggleSave && (
        <button className={`thumb-save ${asset.saved ? "on" : ""}`} onClick={onToggleSave} title={asset.saved ? "Está en la biblioteca · clic para quitarla" : "Agregar a la biblioteca"}>
          {asset.saved ? <><BookmarkCheck size={13} /> En biblioteca</> : <><BookmarkPlus size={13} /> Agregar a biblioteca</>}
        </button>
      )}
    </div>
  );
}

/** Panel flotante anclado; se cierra con clic afuera o Escape. */
export function Popover({ open, onClose, children, align = "left", className = "" }: { open: boolean; onClose: () => void; children: ReactNode; align?: "left" | "right"; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={ref} className={`popover popover-${align} ${className}`} role="dialog">
      {children}
    </div>
  );
}

export function Segmented<T extends string | number>({ value, options, onChange, size = "m" }: { value: T; options: { value: T; label: ReactNode; title?: string; disabled?: boolean }[]; onChange: (v: T) => void; size?: "s" | "m" }) {
  return (
    <div className={`segmented segmented-${size}`} role="radiogroup">
      {options.map((o) => (
        <button key={String(o.value)} role="radio" aria-checked={o.value === value} className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)} title={o.title} disabled={o.disabled}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Rectángulo que dibuja una proporción (para el selector de formato). */
export function AspectGlyph({ aspect, size = 18 }: { aspect: string; size?: number }) {
  const [w, h] = aspect.split(":").map(Number);
  const scale = size / Math.max(w, h);
  return (
    <span className="aspect-glyph" style={{ width: size, height: size }}>
      <span style={{ width: Math.max(4, w * scale), height: Math.max(4, h * scale) }} />
    </span>
  );
}
