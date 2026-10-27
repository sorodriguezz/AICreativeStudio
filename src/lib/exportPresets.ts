import type { ExportTarget } from "./api";

export interface ExportPreset {
  id: string;
  label: string;
  detail: string;
  /** Si es true, respeta el tamaño original (sólo cambia formato/fondo). */
  original?: boolean;
  target: Omit<ExportTarget, "format" | "background" | "quality"> & { format?: ExportTarget["format"] };
}

export const EXPORT_GROUPS: { title: string; presets: ExportPreset[] }[] = [
  {
    title: "Original",
    presets: [
      { id: "orig", label: "Tamaño original", detail: "Mismo tamaño, formato a elección", original: true, target: { name: "original" } },
      { id: "svg", label: "Vector SVG", detail: "Escalable · ideal para logos", original: true, target: { name: "vector", format: "svg" } },
    ],
  },
  {
    title: "Redes sociales",
    presets: [
      { id: "ig-post", label: "Instagram post", detail: "1080 × 1350 · 4:5", target: { name: "instagram-post", width: 1080, height: 1350 } },
      { id: "ig-square", label: "Instagram cuadrado", detail: "1080 × 1080", target: { name: "instagram-cuadrado", width: 1080, height: 1080 } },
      { id: "story", label: "Historia / Reel", detail: "1080 × 1920 · 9:16", target: { name: "historia", width: 1080, height: 1920 } },
      { id: "link-post", label: "LinkedIn / Facebook", detail: "1200 × 627", target: { name: "post-linkedin", width: 1200, height: 627 } },
      { id: "x-post", label: "Post en X", detail: "1600 × 900", target: { name: "post-x", width: 1600, height: 900 } },
      { id: "yt", label: "Miniatura YouTube", detail: "1280 × 720", target: { name: "youtube", width: 1280, height: 720 } },
      { id: "li-cover", label: "Portada LinkedIn", detail: "1584 × 396", target: { name: "portada-linkedin", width: 1584, height: 396 } },
      { id: "x-header", label: "Cabecera X", detail: "1500 × 500", target: { name: "cabecera-x", width: 1500, height: 500 } },
    ],
  },
  {
    title: "Presentaciones",
    presets: [
      { id: "slide", label: "Diapositiva 16:9", detail: "1920 × 1080", target: { name: "diapositiva", width: 1920, height: 1080 } },
      { id: "slide-4k", label: "Diapositiva 4K", detail: "3840 × 2160", target: { name: "diapositiva-4k", width: 3840, height: 2160 } },
      { id: "slide-43", label: "Diapositiva 4:3", detail: "1440 × 1080", target: { name: "diapositiva-4x3", width: 1440, height: 1080 } },
    ],
  },
  {
    title: "Web y app",
    presets: [
      { id: "favicon", label: "Favicon .ico", detail: "16 · 32 · 48 px", target: { name: "favicon", format: "ico" } },
      { id: "app-1024", label: "Ícono de app", detail: "1024 × 1024", target: { name: "icono-app", width: 1024, height: 1024, fit: "contain", padding: 0.1 } },
      { id: "icon-512", label: "Ícono web 512", detail: "512 × 512", target: { name: "icono-512", width: 512, height: 512, fit: "contain", padding: 0.06 } },
      { id: "apple", label: "Apple touch", detail: "180 × 180", target: { name: "apple-touch-icon", width: 180, height: 180, fit: "contain", padding: 0.12 } },
      { id: "og", label: "Open Graph", detail: "1200 × 630 · vista previa de enlaces", target: { name: "open-graph", width: 1200, height: 630 } },
    ],
  },
];

export const ALL_PRESETS = EXPORT_GROUPS.flatMap((g) => g.presets);
