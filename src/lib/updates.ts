import { useSyncExternalStore } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { api } from "./api";

export type UpdatePhase = "idle" | "checking" | "available" | "none" | "downloading" | "installing" | "error";

export interface UpdateState {
  current: string;
  phase: UpdatePhase;
  update: Update | null;
  downloaded: number;
  total: number;
  bytesPerSec: number;
  etaSeconds: number | null;
  error: string | null;
  checkedAt: number | null;
}

let state: UpdateState = { current: "", phase: "idle", update: null, downloaded: 0, total: 0, bytesPerSec: 0, etaSeconds: null, error: null, checkedAt: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<UpdateState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

export function useUpdates(): UpdateState {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => state);
}

/** Busca una versión nueva en GitHub Releases (latest.json firmado). `silent`: sin mostrar errores. */
export async function checkForUpdates(silent = false): Promise<void> {
  if (["checking", "downloading", "installing"].includes(state.phase)) return;
  set({ phase: "checking", error: null, current: state.current || (await getVersion().catch(() => "")) });
  try {
    const update = await check();
    set({ update, phase: update ? "available" : "none", checkedAt: Date.now() });
  } catch (e) {
    // Sin releases todavía o sin conexión: el chequeo automático no molesta.
    console.warn("update check failed", e);
    set({ phase: silent ? "idle" : "error", error: updateError(e), checkedAt: Date.now() });
  }
}

/** Descarga, verifica la firma, detiene el motor, instala y reinicia la app. */
export async function installUpdate(): Promise<void> {
  const { update } = state;
  if (!update) return;
  if (await api.jobsRunning().catch(() => false)) {
    set({ error: "Hay trabajos en curso. Instala cuando terminen para no perderlos." });
    return;
  }
  set({ phase: "downloading", downloaded: 0, total: 0, etaSeconds: null, error: null });
  let windowStart = performance.now();
  let windowBytes = 0;
  let ema = 0;
  try {
    await update.download((ev) => {
      if (ev.event === "Started") {
        set({ total: ev.data.contentLength ?? 0 });
      } else if (ev.event === "Progress") {
        windowBytes += ev.data.chunkLength;
        const downloaded = state.downloaded + ev.data.chunkLength;
        const dt = (performance.now() - windowStart) / 1000;
        if (dt >= 1) {
          const inst = windowBytes / dt;
          ema = ema ? 0.8 * ema + 0.2 * inst : inst;
          windowStart = performance.now();
          windowBytes = 0;
        }
        set({ downloaded, bytesPerSec: ema, etaSeconds: ema && state.total ? (state.total - downloaded) / ema : null });
      }
    });
    set({ phase: "installing" });
    // El motor (Python) no debe tener abiertos archivos que el instalador reemplaza.
    await api.stopEngine();
    await update.install();
    await relaunch();
  } catch (e) {
    console.warn("update install failed", e);
    set({ phase: "error", error: updateError(e) });
  }
}

/** Traduce los errores del plugin a algo accionable. */
function updateError(e: unknown): string {
  const msg = String(e).toLowerCase();
  // Cada sistema se publica cuando termina su compilación: unos minutos latest.json puede no incluir el tuyo.
  if (msg.includes("platform") || msg.includes("404")) return "La versión nueva todavía no está lista para tu sistema. Prueba en unos minutos.";
  if (msg.includes("signature")) return "La firma de la actualización no es válida; no se instaló nada.";
  if (/network|dns|connect|timed? ?out|sending request|offline/.test(msg)) return "Sin conexión con GitHub. Revisa tu internet.";
  return "No se pudo buscar o instalar la actualización.";
}
