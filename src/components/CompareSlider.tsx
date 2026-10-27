import { useRef, useState } from "react";
import { fileUrl, type Asset } from "../lib/api";

/** Antes / después con una cortina arrastrable. */
export default function CompareSlider({ before, after, size }: { before: Asset; after: Asset; size?: { width: number; height: number } }) {
  const [pos, setPos] = useState(0.5);
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const ratio = after.width && after.height ? after.width / after.height : 1;

  const move = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    setPos(Math.min(1, Math.max(0, (clientX - r.left) / r.width)));
  };

  return (
    <div
      ref={box}
      className="compare"
      style={size ? { width: size.width, height: size.height } : { aspectRatio: String(ratio) }}
      onPointerDown={(e) => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); move(e.clientX); }}
      onPointerMove={(e) => dragging.current && move(e.clientX)}
      onPointerUp={() => (dragging.current = false)}
    >
      <img src={fileUrl(after.path)} alt="Después" draggable={false} />
      <div className="compare-before" style={{ clipPath: `inset(0 ${100 - pos * 100}% 0 0)` }}>
        <img src={fileUrl(before.path)} alt="Antes" draggable={false} />
      </div>
      <div className="compare-handle" style={{ left: `${pos * 100}%` }}>
        <span />
      </div>
      <span className="compare-tag compare-tag-left">Antes · {before.width}×{before.height}</span>
      <span className="compare-tag compare-tag-right">Después · {after.width}×{after.height}</span>
    </div>
  );
}
