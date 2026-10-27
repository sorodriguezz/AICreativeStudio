import { AlertTriangle, ScanFace } from "lucide-react";
import type { Validation } from "../../lib/api";

/** Insignia compacta de la capa de validación (identidad + advertencias). */
export default function ValidationBadge({ v, compact }: { v: Validation; compact?: boolean }) {
  const tone = v.identity_label === "alta" ? "ok" : v.identity_label === "media" ? "warn" : v.identity_label === "baja" ? "bad" : "neutral";
  const title = [
    v.identity !== null ? `Similitud facial con las referencias: ${v.identity.toFixed(2)} (${v.identity_label}). Umbral de misma persona: 0.36.` : `${v.faces} rostro(s) detectado(s).`,
    `Nitidez: ${Math.round(v.sharpness * 100)}%.`,
    ...v.warnings,
  ].join("\n");
  return (
    <span className={`vbadge vbadge-${tone} ${compact ? "vbadge-compact" : ""}`} title={title}>
      <ScanFace size={12} />
      {v.identity !== null ? `${compact ? "" : "Identidad "}${v.identity.toFixed(2)}` : `${v.faces} rostro${v.faces === 1 ? "" : "s"}`}
      {v.warnings.length > 0 && <AlertTriangle size={11} />}
    </span>
  );
}

export function ValidationPanel({ v }: { v: Validation }) {
  return (
    <div className="vpanel">
      <span className="eyebrow">Validación</span>
      <dl className="meta">
        <dt>Rostros</dt>
        <dd className="mono">{v.faces}</dd>
        {v.identity !== null && (
          <>
            <dt>Identidad</dt>
            <dd><span className="mono">{v.identity.toFixed(2)}</span> · {v.identity_label}</dd>
          </>
        )}
        <dt>Nitidez</dt>
        <dd className="mono">{Math.round(v.sharpness * 100)}%</dd>
        <dt>Exposición</dt>
        <dd className="mono">{(v.clipped_highlights * 100).toFixed(1)}% quemado · {(v.clipped_shadows * 100).toFixed(1)}% empastado</dd>
      </dl>
      {v.warnings.map((w) => <p key={w} className="vwarn"><AlertTriangle size={12} /> {w}</p>)}
      <p className="muted small">La similitud facial es una medida automática (SFace). Una revisión humana sigue siendo necesaria antes de publicar.</p>
    </div>
  );
}
