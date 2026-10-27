import { api, type Asset, type JobParams } from "./api";

/** Lanza una nueva tirada con el mismo prompt y ajustes que generaron `asset`, pero con seed nueva. */
export async function variationsOf(asset: Asset) {
  if (!asset.job_id) throw new Error("Esta imagen no tiene un trabajo asociado");
  const job = await api.getJob(asset.job_id);
  if (!job) throw new Error("No se encontró el trabajo original");
  const { seed: _seed, ...params } = job.params as JobParams;
  return api.createJob({ project_id: job.project_id, mode: job.mode, prompt: job.prompt, negative_prompt: job.negative_prompt, params, session_id: job.session_id ?? "new" });
}
