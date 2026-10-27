import { useRef, useState } from "react";
import { FlipHorizontal2, ImageUp, RotateCcw } from "lucide-react";
import { api, type Asset, type PoseData } from "../../lib/api";
import { errorText } from "../../lib/hooks";
import { COLORS, JOINT_NAMES, LIMBS, POSES, mirror, poseData } from "../../lib/poses";
import { Popover, Thumb } from "../ui";
import { useToast } from "../Toasts";

const VW = 768;
const VH = 1024;

/** Esqueleto en SVG (miniatura o editor). */
export function Skeleton({ pose, size, onDown, active }: { pose: PoseData; size: number; onDown?: (joint: number, e: React.PointerEvent) => void; active?: number | null }) {
  const sx = (x: number) => x * VW;
  const sy = (y: number) => y * VH;
  const b = pose.body;
  const r = size > 120 ? 14 : 22;
  return (
    <svg viewBox={`0 0 ${VW} ${VH}`} width={size} height={(size * VH) / VW} className="skeleton">
      <rect width={VW} height={VH} fill="#0d0c0b" />
      {LIMBS.map(([a, c], i) => b[a][2] > 0 && b[c][2] > 0 && (
        <line key={i} x1={sx(b[a][0])} y1={sy(b[a][1])} x2={sx(b[c][0])} y2={sy(b[c][1])} stroke={COLORS[i]} strokeOpacity={0.75} strokeWidth={size > 120 ? 14 : 26} strokeLinecap="round" />
      ))}
      {(pose.hands ?? []).map((hand, h) => hand.map(([x, y, c], j) => c > 0 && <circle key={`h${h}-${j}`} cx={sx(x)} cy={sy(y)} r={4} fill="#4a7dff" />))}
      {b.map(([x, y, c], i) => c > 0 && (
        <circle
          key={i}
          cx={sx(x)}
          cy={sy(y)}
          r={active === i ? r * 1.5 : r}
          fill={COLORS[i]}
          stroke={onDown ? "#fff" : "none"}
          strokeWidth={onDown ? 4 : 0}
          style={onDown ? { cursor: "grab" } : undefined}
          onPointerDown={onDown ? (e) => onDown(i, e) : undefined}
        >
          {onDown && <title>{JOINT_NAMES[i]}</title>}
        </circle>
      ))}
    </svg>
  );
}

export default function PoseEditor({ pose, onChange, projectAssets }: { pose: PoseData; onChange: (p: PoseData) => void; projectAssets: Asset[] }) {
  const toast = useToast();
  const svgBox = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);

  const move = (e: React.PointerEvent) => {
    if (drag === null) return;
    const r = svgBox.current!.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    onChange({ ...pose, width: VW, height: VH, body: pose.body.map((p, i) => (i === drag ? [x, y, 1] : p)) as PoseData["body"], hands: undefined });
  };

  async function fromPhoto(asset: Asset) {
    setPicking(false);
    setBusy(true);
    try {
      onChange(await api.poseEstimate(asset.id));
      toast({ tone: "success", title: "Pose copiada de la foto", body: "Puedes ajustar cada articulación arrastrándola." });
    } catch (e) {
      toast({ tone: "error", title: "No se pudo leer la pose", body: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pose-editor">
      <div className="pose-canvas" ref={svgBox} onPointerMove={move} onPointerUp={() => setDrag(null)} onPointerLeave={() => setDrag(null)}>
        <Skeleton pose={pose} size={240} active={drag} onDown={(i, e) => { e.currentTarget.setPointerCapture?.(e.pointerId); setDrag(i); }} />
        {busy && <div className="pose-busy"><span className="spinner" /> Leyendo la pose…</div>}
      </div>
      <div className="pose-side">
        <span className="eyebrow">Biblioteca</span>
        <div className="pose-library">
          {POSES.map((p) => (
            <button key={p.id} className="pose-thumb" onClick={() => onChange(poseData(p.points))} title={p.label}>
              <Skeleton pose={poseData(p.points)} size={54} />
              <span>{p.label}</span>
            </button>
          ))}
        </div>
        <div className="row gap-xs wrap">
          <div className="anchor">
            <button className="btn btn-s" onClick={() => setPicking((v) => !v)} disabled={busy}><ImageUp size={14} /> Copiar de una foto</button>
            <Popover open={picking} onClose={() => setPicking(false)} className="popover-wide pose-picker">
              <span className="eyebrow">Elige una foto del proyecto</span>
              <div className="picker-grid">
                {projectAssets.slice(0, 18).map((a) => <Thumb key={a.id} asset={a} onOpen={() => fromPhoto(a)} />)}
              </div>
              {projectAssets.length === 0 && <p className="muted small">Importa una foto en Editar o Mejorar primero.</p>}
            </Popover>
          </div>
          <button className="btn btn-s btn-ghost" onClick={() => onChange(mirror(pose))}><FlipHorizontal2 size={14} /> Espejo</button>
          <button className="btn btn-s btn-ghost" onClick={() => onChange(poseData(POSES[0].points))}><RotateCcw size={14} /> Reiniciar</button>
        </div>
        <p className="muted small">Arrastra los puntos para ajustar brazos, piernas y cabeza.</p>
      </div>
    </div>
  );
}
