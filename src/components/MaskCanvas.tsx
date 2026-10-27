import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";

export interface MaskHandle {
  clear: () => void;
  invert: () => void;
  undo: () => void;
  /** PNG blanco (zona a cambiar) sobre negro, al tamaño de la máscara. */
  exportPng: () => string;
}

interface Props {
  width: number; // tamaño natural de la imagen
  height: number;
  brush: number; // diámetro en píxeles de pantalla
  erase: boolean;
  enabled: boolean;
  onChange: (hasMask: boolean) => void;
  /** Máscara inicial (PNG blanco = zona) para revisarla y retocarla. */
  initial?: string | null;
}

const MAX_SIDE = 2048; // la máscara no necesita más resolución que esto
const COLOR = "rgb(255, 107, 61)";

/** Capa de pintura sobre la imagen. Se dibuja en color y se exporta en blanco y negro. */
const MaskCanvas = forwardRef<MaskHandle, Props>(function MaskCanvas({ width, height, brush, erase, enabled, onChange, initial }, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const history = useRef<ImageData[]>([]);
  const last = useRef<{ x: number; y: number } | null>(null);
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const cw = Math.max(1, Math.round(width * scale));
  const ch = Math.max(1, Math.round(height * scale));

  const ctx = () => canvas.current!.getContext("2d", { willReadFrequently: true })!;

  const painted = useCallback(() => {
    const data = ctx().getImageData(0, 0, cw, ch).data;
    for (let i = 3; i < data.length; i += 64) if (data[i] > 0) return true;
    return false;
  }, [cw, ch]);

  const snapshot = () => {
    history.current.push(ctx().getImageData(0, 0, cw, ch));
    if (history.current.length > 30) history.current.shift();
  };

  useEffect(() => {
    history.current = [];
    ctx().clearRect(0, 0, cw, ch);
    onChange(false);
    if (!initial) return;
    // Pintamos en color sólo donde la máscara inicial es blanca.
    const img = new Image();
    img.onload = () => {
      const tmp = document.createElement("canvas");
      tmp.width = cw;
      tmp.height = ch;
      const t = tmp.getContext("2d", { willReadFrequently: true })!;
      t.drawImage(img, 0, 0, cw, ch);
      const data = t.getImageData(0, 0, cw, ch);
      const d = data.data;
      for (let i = 0; i < d.length; i += 4) {
        const on = d[i] > 127;
        d[i] = 255; d[i + 1] = 107; d[i + 2] = 61; d[i + 3] = on ? 255 : 0;
      }
      ctx().putImageData(data, 0, 0);
      onChange(painted());
    };
    img.src = initial;
  }, [cw, ch, initial]); // nueva imagen o máscara inicial → máscara nueva

  useImperativeHandle(ref, () => ({
    clear() {
      snapshot();
      ctx().clearRect(0, 0, cw, ch);
      onChange(false);
    },
    invert() {
      snapshot();
      const c = ctx();
      const img = c.getImageData(0, 0, cw, ch);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const a = 255 - d[i + 3];
        d[i] = 255; d[i + 1] = 107; d[i + 2] = 61; d[i + 3] = a;
      }
      c.putImageData(img, 0, 0);
      onChange(painted());
    },
    undo() {
      const prev = history.current.pop();
      if (!prev) return;
      ctx().putImageData(prev, 0, 0);
      onChange(painted());
    },
    exportPng() {
      const out = document.createElement("canvas");
      out.width = cw;
      out.height = ch;
      const o = out.getContext("2d")!;
      o.drawImage(canvas.current!, 0, 0);
      o.globalCompositeOperation = "source-in";
      o.fillStyle = "#fff";
      o.fillRect(0, 0, cw, ch);
      o.globalCompositeOperation = "destination-over";
      o.fillStyle = "#000";
      o.fillRect(0, 0, cw, ch);
      return out.toDataURL("image/png");
    },
  }), [cw, ch, onChange, painted]);

  function toCanvas(e: React.PointerEvent) {
    const r = canvas.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * cw, y: ((e.clientY - r.top) / r.height) * ch, k: cw / r.width };
  }

  function stroke(from: { x: number; y: number }, to: { x: number; y: number }, k: number) {
    const c = ctx();
    c.globalCompositeOperation = erase ? "destination-out" : "source-over";
    c.strokeStyle = COLOR;
    c.fillStyle = COLOR;
    c.lineCap = "round";
    c.lineJoin = "round";
    c.lineWidth = brush * k;
    c.beginPath();
    c.moveTo(from.x, from.y);
    c.lineTo(to.x, to.y);
    c.stroke();
  }

  return (
    <canvas
      ref={canvas}
      width={cw}
      height={ch}
      className={`mask-canvas ${enabled ? "painting" : ""}`}
      style={{ ["--brush" as string]: `${brush}px` }}
      onPointerDown={(e) => {
        if (!enabled) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        snapshot();
        const p = toCanvas(e);
        last.current = p;
        stroke(p, { x: p.x + 0.01, y: p.y }, p.k);
      }}
      onPointerMove={(e) => {
        if (!enabled || !last.current) return;
        const p = toCanvas(e);
        stroke(last.current, p, p.k);
        last.current = p;
      }}
      onPointerUp={() => {
        if (!last.current) return;
        last.current = null;
        onChange(painted());
      }}
    />
  );
});

export default MaskCanvas;
