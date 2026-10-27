/**
 * Sombreado para la vista previa en vivo de Reiluminar.
 * Es la misma fórmula que `engine/src/aics_engine/pipelines/relight.py`: si cambias una, cambia la otra.
 */

export interface LightParams {
  azimuth: number; // grados: 0 = desde la derecha, 90 = desde arriba
  elevation: number; // grados: 0 = rasante, 90 = frontal
  kelvin: number;
  strength: number; // 0..1
  ambient: number; // 0..1
  relief: number; // escala del volumen
}

export const DEFAULT_LIGHT: LightParams = { azimuth: 135, elevation: 35, kelvin: 5200, strength: 0.7, ambient: 0.35, relief: 1 };

export const LIGHT_PRESETS: { id: string; label: string; light: Partial<LightParams> }[] = [
  { id: "soft-left", label: "Suave lateral", light: { azimuth: 160, elevation: 40, kelvin: 5200, strength: 0.6, ambient: 0.45 } },
  { id: "drama-right", label: "Dramática", light: { azimuth: 10, elevation: 15, kelvin: 4800, strength: 0.9, ambient: 0.15 } },
  { id: "top", label: "Cenital", light: { azimuth: 90, elevation: 60, kelvin: 6000, strength: 0.65, ambient: 0.35 } },
  { id: "golden", label: "Hora dorada", light: { azimuth: 170, elevation: 12, kelvin: 3000, strength: 0.75, ambient: 0.3 } },
  { id: "studio-cool", label: "Estudio frío", light: { azimuth: 45, elevation: 45, kelvin: 7500, strength: 0.6, ambient: 0.4 } },
  { id: "under", label: "Desde abajo", light: { azimuth: 270, elevation: 20, kelvin: 4200, strength: 0.8, ambient: 0.2 } },
];

const GAIN = 1.25;

/** Aproximación de Tanner Helland, normalizada a máx. 1. */
export function kelvinToRgb(kelvin: number): [number, number, number] {
  const t = kelvin / 100;
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = [r, g, b].map((v) => Math.min(255, Math.max(0, v)));
  const m = Math.max(...c);
  return [c[0] / m, c[1] / m, c[2] / m];
}

export function shade(base: ImageData, normals: ImageData, light: LightParams, out: ImageData) {
  const az = (light.azimuth * Math.PI) / 180;
  const el = (light.elevation * Math.PI) / 180;
  const lx = Math.cos(el) * Math.cos(az);
  const ly = Math.cos(el) * Math.sin(az);
  const lz = Math.sin(el);
  const [cr, cg, cb] = kelvinToRgb(light.kelvin);
  const { strength: s, ambient: a, relief } = light;
  const src = base.data;
  const n = normals.data;
  const dst = out.data;
  for (let i = 0; i < src.length; i += 4) {
    let nx = (n[i] / 255) * 2 - 1;
    let ny = (n[i + 1] / 255) * 2 - 1;
    let nz = (n[i + 2] / 255) * 2 - 1;
    nx *= relief;
    ny *= relief;
    const len = Math.hypot(nx, ny, nz) || 1;
    const lambert = Math.max(0, Math.min(1, (nx * lx + ny * ly + nz * lz) / len));
    const shading = a + (1 - a) * lambert;
    dst[i] = Math.min(255, src[i] * (1 - s + s * shading * cr * GAIN));
    dst[i + 1] = Math.min(255, src[i + 1] * (1 - s + s * shading * cg * GAIN));
    dst[i + 2] = Math.min(255, src[i + 2] * (1 - s + s * shading * cb * GAIN));
    dst[i + 3] = src[i + 3];
  }
}
