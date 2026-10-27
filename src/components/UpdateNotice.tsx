import { useEffect } from "react";
import { Download } from "lucide-react";
import { formatBytes } from "../lib/format";
import { checkForUpdates, installUpdate, useUpdates } from "../lib/updates";
import { Progress } from "./ui";

/** Aviso al pie de la barra lateral cuando hay una versión nueva. Busca al abrir y cada 6 h. */
export default function UpdateNotice() {
  const { phase, update, downloaded, total, etaSeconds, error } = useUpdates();

  useEffect(() => {
    const first = setTimeout(() => checkForUpdates(true), 4000);
    const every = setInterval(() => checkForUpdates(true), 6 * 3600 * 1000);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, []);

  if (!update || !["available", "downloading", "installing", "error"].includes(phase)) return null;

  return (
    <div className="update-notice">
      <strong>Versión {update.version} disponible</strong>
      {phase === "available" && (
        <>
          {error && <span className="small muted">{error}</span>}
          <button className="btn btn-s btn-primary" onClick={installUpdate}><Download size={13} /> Actualizar y reiniciar</button>
        </>
      )}
      {phase === "downloading" && (
        <>
          <Progress value={total ? downloaded / total : 0} />
          <span className="small muted row between">
            <span>{formatBytes(downloaded)}{total ? ` / ${formatBytes(total)}` : ""}</span>
            <span>{etaSeconds != null ? `${Math.ceil(etaSeconds)} s` : ""}</span>
          </span>
        </>
      )}
      {phase === "installing" && <span className="small muted">Instalando… la app se reiniciará sola.</span>}
      {phase === "error" && (
        <>
          <span className="small muted">{error}</span>
          <button className="btn btn-s" onClick={() => checkForUpdates()}>Reintentar</button>
        </>
      )}
    </div>
  );
}
