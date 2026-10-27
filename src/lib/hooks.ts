import { useCallback, useEffect, useState } from "react";
import { api, onAssetsDeleted, onAssetsSaved, onEngineStatus, onJobUpdate, type EngineStatus, type Job } from "./api";

export function useEngineStatus() {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  useEffect(() => {
    api.engineStatus().then(setStatus);
    const off = onEngineStatus(setStatus);
    return () => void off.then((f) => f());
  }, []);
  return status;
}

/** Ejecuta `cb` cada vez que el núcleo emite una actualización de job. */
export function useJobUpdates(cb: (job: Job) => void) {
  useEffect(() => {
    const off = onJobUpdate(cb);
    return () => void off.then((f) => f());
  }, [cb]);
}

/** Ejecuta `cb` con los ids de las imágenes que se acaban de eliminar. */
export function useAssetsDeleted(cb: (ids: string[]) => void) {
  useEffect(() => onAssetsDeleted(cb), [cb]);
}

/** Ejecuta `cb` cuando imágenes entran o salen de la biblioteca. */
export function useAssetsSaved(cb: (ids: string[]) => void) {
  useEffect(() => onAssetsSaved(cb), [cb]);
}

/** Lista de jobs de un proyecto que se mantiene viva con los eventos del núcleo. */
export function useJobs(projectId?: string, limit = 50) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const reload = useCallback(() => {
    api.jobs(projectId, limit).then(setJobs).catch(() => setJobs([]));
  }, [projectId, limit]);

  useEffect(reload, [reload]);
  useJobUpdates(
    useCallback(
      (job: Job) => {
        if (projectId && job.project_id !== projectId) return;
        setJobs((prev) => {
          const i = prev.findIndex((j) => j.id === job.id);
          if (i === -1) return [job, ...prev].slice(0, limit);
          const next = prev.slice();
          next[i] = job;
          return next;
        });
      },
      [projectId, limit],
    ),
  );
  return { jobs, reload };
}

export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}
