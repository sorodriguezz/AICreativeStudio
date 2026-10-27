import { useEffect, useRef, useState } from "react";

/** Tamaño máximo que conserva la proporción `ratio` dentro del contenedor observado. */
export function useFitSize(ratio: number, padding = 0, key?: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width - padding * 2;
      const h = entry.contentRect.height - padding * 2;
      if (w <= 0 || h <= 0) return;
      setSize(w / h > ratio ? { width: h * ratio, height: h } : { width: w, height: w / ratio });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ratio, padding, key]);
  return { ref, size };
}
