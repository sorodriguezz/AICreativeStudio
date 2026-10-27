import { Download, HardDrive } from "lucide-react";
import { useState } from "react";
import { api, type HardwareInfo, type ModelInfo } from "../lib/api";
import { formatBytes } from "../lib/format";
import { errorText } from "../lib/hooks";
import { Progress } from "./ui";

/** Se muestra en Crear cuando todavía no hay ningún motor de generación instalado. */
export default function ModelOnboarding({ models, hardware, onChanged }: { models: ModelInfo[]; hardware: HardwareInfo | null; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const candidates = models.filter((m) => m.tasks.includes("text_to_image") && m.backend !== "planned" && !m.dev);
  const recommended = candidates.find((m) => hardware && m.profiles.includes(hardware.profile)) ?? candidates[0];
  if (!recommended) return null;
  const others = candidates.filter((m) => m.id !== recommended.id);

  async function download(id: string) {
    try {
      setError(null);
      await api.downloadModel(id);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  }

  const downloading = recommended.status === "downloading";
  const pct = recommended.total_bytes ? recommended.downloaded_bytes / recommended.total_bytes : 0;

  return (
    <section className="onboarding">
      <span className="eyebrow">Primer paso</span>
      <h2 className="display">Descarga tu motor de generación</h2>
      <p className="muted">
        Se descarga una sola vez y después todo funciona sin conexión, en este equipo.
        {hardware && <> Para tu {hardware.device_name} ({hardware.total_memory_gb} GB) te recomendamos:</>}
      </p>

      <div className="onboarding-card">
        <div className="onboarding-icon"><HardDrive size={22} /></div>
        <div className="grow">
          <strong>{recommended.name}</strong>
          <p className="muted small">{recommended.notes}</p>
          <p className="muted small">{recommended.license}</p>
          {downloading && (
            <div className="stack gap-xs onboarding-progress">
              <Progress value={pct} />
              <span className="mono small muted">{formatBytes(recommended.downloaded_bytes)} de {formatBytes(recommended.total_bytes)}</span>
            </div>
          )}
          {recommended.error && <p className="notice notice-error">{recommended.error}</p>}
        </div>
        {!downloading && (
          <button className="btn btn-primary" onClick={() => download(recommended.id)}>
            <Download size={15} /> Descargar · {recommended.size_gb} GB
          </button>
        )}
      </div>

      {others.length > 0 && !downloading && (
        <p className="muted small">
          ¿Poco espacio o un equipo más modesto?{" "}
          {others.map((m) => (
            <button key={m.id} className="link" onClick={() => download(m.id)}>Descargar {m.name} ({m.size_gb} GB)</button>
          ))}
        </p>
      )}
      {error && <p className="notice notice-error">{error}</p>}
    </section>
  );
}
