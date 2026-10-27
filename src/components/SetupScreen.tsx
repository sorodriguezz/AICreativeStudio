import { Cpu, RefreshCw } from "lucide-react";
import { api, type EngineStatus } from "../lib/api";
import { Progress } from "./ui";

const VARIANT: Record<string, string> = { pypi: "Metal (Apple Silicon)", cpu: "CPU" };

/** Primer arranque de una instalación: se prepara el motor (Python + PyTorch) para este equipo. */
export default function SetupScreen({ engine }: { engine: EngineStatus }) {
  const s = engine.setup;
  const failed = engine.state === "error" && engine.setup_failed;
  const pct = s ? Math.min(0.98, (Math.max(0, s.step - 1) + (s.detail ? 0.5 : 0.1)) / s.total) : 0.02;
  const variant = s?.variant ? VARIANT[s.variant] ?? s.variant.toUpperCase().replace("CU", "CUDA ").replace(/(\d)(\d)$/, "$1.$2") : null;

  return (
    <div className="setup">
      <div className="setup-card">
        <span className="wordmark-mark setup-mark" aria-hidden />
        <span className="eyebrow">Primer arranque</span>
        <h1 className="display">{failed ? "No se pudo preparar el motor" : "Preparando el motor de IA"}</h1>
        <p className="muted">
          {failed
            ? "Revisa tu conexión a internet y vuelve a intentarlo. Lo que ya se descargó no se pierde."
            : "Se instala una sola vez y luego todo funciona sin conexión. Elegimos la versión más rápida para tu equipo; puede tardar unos minutos."}
        </p>
        {!failed && (
          <>
            <Progress value={pct} />
            <div className="setup-steps">
              {["Python", "Motor base", "PyTorch", "Difusión"].map((label, i) => (
                <span key={label} className={`setup-step ${s && s.step > i + 1 ? "done" : s && s.step === i + 1 ? "on" : ""}`}>{label}</span>
              ))}
            </div>
            <strong className="setup-title">{s?.title ?? "Iniciando…"}</strong>
            {variant && <span className="chip chip-accent setup-variant"><Cpu size={12} /> {variant}</span>}
            <code className="setup-log">{s?.detail || " "}</code>
          </>
        )}
        {failed && (
          <>
            <code className="setup-log setup-error">{engine.message}</code>
            <button className="btn btn-primary" onClick={() => api.restartEngine()}><RefreshCw size={15} /> Reintentar</button>
          </>
        )}
      </div>
    </div>
  );
}
