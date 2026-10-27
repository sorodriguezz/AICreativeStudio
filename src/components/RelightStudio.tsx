import { useEffect, useRef, useState } from "react";
import { api, type Asset } from "../lib/api";
import { errorText } from "../lib/hooks";
import { DEFAULT_LIGHT, LIGHT_PRESETS, kelvinToRgb, shade, type LightParams } from "../lib/relight";

interface Prepared {
  base: ImageData;
  normals: ImageData;
  width: number;
  height: number;
}

async function toImageData(url: string, w: number, h: number): Promise<ImageData> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/** Vista previa en vivo: el motor entrega imagen + normales una vez; la luz se calcula aquí. */
export function RelightPreview({ source, light, size, onError }: { source: Asset; light: LightParams; size: { width: number; height: number }; onError: (msg: string | null) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [prep, setPrep] = useState<Prepared | null>(null);
  const out = useRef<ImageData | null>(null);
  const frame = useRef(0);

  useEffect(() => {
    let alive = true;
    setPrep(null);
    onError(null);
    api.relightPrepare(source.id)
      .then(async (r) => {
        const [base, normals] = await Promise.all([toImageData(r.image, r.width, r.height), toImageData(r.normals, r.width, r.height)]);
        if (alive) setPrep({ base, normals, width: r.width, height: r.height });
      })
      .catch((e) => alive && onError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [source.id]);

  useEffect(() => {
    if (!prep || !canvas.current) return;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      if (!out.current || out.current.width !== prep.width) out.current = new ImageData(prep.width, prep.height);
      shade(prep.base, prep.normals, light, out.current);
      canvas.current!.getContext("2d")!.putImageData(out.current, 0, 0);
    });
  }, [prep, light]);

  return (
    <div className="relight-preview" style={{ width: size.width, height: size.height }}>
      {prep ? (
        <canvas ref={canvas} width={prep.width} height={prep.height} />
      ) : (
        <div className="developing on" style={{ width: "100%", height: "100%" }}>
          <div className="developing-wash" style={{ opacity: 0.6 }} />
          <div className="developing-label"><span>Estimando el volumen de la escena…</span></div>
        </div>
      )}
    </div>
  );
}

/** Disco para elegir de dónde viene la luz: el ángulo es el azimut, la distancia al centro baja la elevación. */
export function LightPad({ light, onChange }: { light: LightParams; onChange: (p: Partial<LightParams>) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const r = (90 - light.elevation) / 90; // 0 = centro (frontal), 1 = borde (rasante)
  const az = (light.azimuth * Math.PI) / 180;
  const [cr, cg, cb] = kelvinToRgb(light.kelvin);
  const glow = `rgb(${Math.round(cr * 255)}, ${Math.round(cg * 255)}, ${Math.round(cb * 255)})`;

  const move = (clientX: number, clientY: number) => {
    const b = ref.current!.getBoundingClientRect();
    const dx = (clientX - (b.left + b.width / 2)) / (b.width / 2);
    const dy = -(clientY - (b.top + b.height / 2)) / (b.height / 2);
    const dist = Math.min(1, Math.hypot(dx, dy));
    onChange({ azimuth: Math.round(((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360), elevation: Math.round(90 - dist * 85) });
  };

  return (
    <div
      ref={ref}
      className="lightpad"
      onPointerDown={(e) => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); move(e.clientX, e.clientY); }}
      onPointerMove={(e) => dragging.current && move(e.clientX, e.clientY)}
      onPointerUp={() => (dragging.current = false)}
      style={{ ["--glow" as string]: glow }}
    >
      <span className="lightpad-ring" />
      <span className="lightpad-ring lightpad-ring-2" />
      <span className="lightpad-sphere" style={{ background: `radial-gradient(circle at ${50 + Math.cos(az) * r * 35}% ${50 - Math.sin(az) * r * 35}%, ${glow}, #3a3631 70%, #141210)` }} />
      <span className="lightpad-dot" style={{ left: `${50 + Math.cos(az) * r * 46}%`, top: `${50 - Math.sin(az) * r * 46}%` }} />
    </div>
  );
}

export function RelightControls({ light, onChange }: { light: LightParams; onChange: (p: Partial<LightParams>) => void }) {
  return (
    <div className="stack gap-s">
      <LightPad light={light} onChange={onChange} />
      <div className="relight-presets">
        {LIGHT_PRESETS.map((p) => (
          <button key={p.id} className="chip chip-button" onClick={() => onChange({ ...DEFAULT_LIGHT, ...p.light })}>{p.label}</button>
        ))}
      </div>
      <Slider label="Temperatura" value={light.kelvin} min={2500} max={9500} step={100} format={(v) => `${v} K`} onChange={(kelvin) => onChange({ kelvin })} className="slider-kelvin" />
      <Slider label="Intensidad de la luz nueva" value={light.strength} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(strength) => onChange({ strength })} />
      <Slider label="Luz ambiente" value={light.ambient} min={0} max={0.9} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(ambient) => onChange({ ambient })} />
      <Slider label="Volumen" value={light.relief} min={0.3} max={2.5} step={0.1} format={(v) => `${v.toFixed(1)}×`} onChange={(relief) => onChange({ relief })} />
    </div>
  );
}

function Slider({ label, value, min, max, step, format, onChange, className = "" }: { label: string; value: number; min: number; max: number; step: number; format: (v: number) => string; onChange: (v: number) => void; className?: string }) {
  return (
    <label className={`slider ${className}`}>
      <span className="row between small"><span className="muted">{label}</span><span className="mono">{format(value)}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}
