import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type Asset, type Job, type Section } from "./api";

/** Sesión abierta en cada sección de cada proyecto. `null` = sesión nueva (se crea al lanzar el primer trabajo). */
type Current = Record<string, string | null>;

interface Ctx {
  projectId: string;
  current: Current;
  set: (section: Section, id: string | null) => void;
}

const SessionCtx = createContext<Ctx | null>(null);
const KEY = "aics.sessions";

function read(): Current {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Current;
  } catch {
    return {};
  }
}

export function SessionProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
  const [current, setCurrent] = useState<Current>(read);
  const set = useCallback((section: Section, id: string | null) => {
    setCurrent((c) => {
      const next = { ...c, [`${projectId}:${section}`]: id };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* sin almacenamiento: sólo en memoria */ }
      return next;
    });
  }, [projectId]);
  const value = useMemo(() => ({ projectId, current, set }), [projectId, current, set]);
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

/**
 * Sesión actual de una sección. La primera vez abre la más reciente del proyecto.
 * `forJob` es lo que se manda al crear un trabajo; `adopt` fija la sesión que devolvió el núcleo.
 */
export function useSession(section: Section) {
  const ctx = useContext(SessionCtx)!;
  const key = `${ctx.projectId}:${section}`;
  const known = key in ctx.current;
  const id = ctx.current[key] ?? null;
  const { set } = ctx;

  useEffect(() => {
    if (known) return;
    api.sessions(ctx.projectId, section).then((list) => set(section, list[0]?.id ?? null)).catch(() => set(section, null));
  }, [known, ctx.projectId, section, set]);

  const select = useCallback((next: string | null) => set(section, next), [set, section]);
  const adopt = useCallback((job: Job) => { if (job.session_id && job.session_id !== id) set(section, job.session_id); }, [set, section, id]);
  return { id, ready: known, select, adopt, forJob: id ?? "new" };
}

/**
 * Editores con imagen de origen: al cambiar de sesión se retoma la última imagen trabajada en ella,
 * y "Nueva sesión" vuelve al selector de imagen.
 */
export function useSessionSource(sessionId: string | null, source: Asset | null, setSource: (a: Asset | null) => void) {
  const ctx = useContext(SessionCtx)!;
  const previous = useRef(sessionId);
  useEffect(() => {
    const before = previous.current;
    previous.current = sessionId;
    if (before === sessionId) return;
    if (!sessionId) {
      if (before) setSource(null);
      return;
    }
    api.jobs(ctx.projectId, 300).then(async (jobs) => {
      const last = jobs.find((j) => j.session_id === sessionId && j.input_asset_id);
      if (!last?.input_asset_id || last.input_asset_id === source?.id) return;
      const asset = await api.getAsset(last.input_asset_id);
      if (asset) setSource(asset);
    }).catch(() => undefined);
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps
}
