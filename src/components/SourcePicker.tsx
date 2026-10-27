import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ImageUp } from "lucide-react";
import { api, type Asset } from "../lib/api";
import { errorText, useAssetsDeleted, useAssetsSaved } from "../lib/hooks";
import { Thumb } from "./ui";
import { useToast } from "./Toasts";
import { useAssetActions } from "./AssetActions";

const EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff"];

/** Importa archivos del disco al proyecto. Compartido por el selector y el arrastrar-y-soltar. */
export async function importFiles(projectId: string, paths: string[]): Promise<Asset[]> {
  const out: Asset[] = [];
  for (const path of paths) out.push(await api.importImage(projectId, path));
  return out;
}

/** Arrastrar archivos sobre la ventana (API nativa de Tauri; en el navegador no aplica). */
export function useFileDrop(onPaths: (paths: string[]) => void) {
  const [hovering, setHovering] = useState(false);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((e) => {
          if (e.payload.type === "enter" || e.payload.type === "over") setHovering(true);
          else if (e.payload.type === "leave") setHovering(false);
          else if (e.payload.type === "drop") {
            setHovering(false);
            const paths = e.payload.paths.filter((p) => EXTENSIONS.includes(p.split(".").pop()?.toLowerCase() ?? ""));
            if (paths.length) onPaths(paths);
          }
        }),
      )
      .then((fn) => (cancelled ? fn() : (unlisten = fn)))
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [onPaths]);
  return hovering;
}

interface Props {
  projectId: string;
  title: string;
  lead: string;
  onPick: (asset: Asset) => void;
  /** Versión reducida (Photo Studio): título y zona de soltar más pequeños. */
  compact?: boolean;
}

/** Estado vacío de Editar / Mejorar: soltar, importar o elegir una imagen del proyecto. */
export default function SourcePicker({ projectId, title, lead, onPick, compact }: Props) {
  const toast = useToast();
  const actions = useAssetActions();
  const [recent, setRecent] = useState<Asset[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.assets({ projectId, limit: 18 }).then(setRecent);
  }, [projectId]);
  useAssetsDeleted(useCallback((ids: string[]) => setRecent((list) => list.filter((a) => !ids.includes(a.id))), []));
  useAssetsSaved(useCallback(() => { api.assets({ projectId, limit: 18 }).then(setRecent); }, [projectId]));

  async function choose() {
    try {
      const selected = await open({ multiple: false, directory: false, filters: [{ name: "Imágenes", extensions: EXTENSIONS }] });
      if (!selected) return;
      setBusy(true);
      const [asset] = await importFiles(projectId, [selected as string]);
      onPick(asset);
    } catch (e) {
      toast({ tone: "error", title: "No se pudo importar", body: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`source-picker ${compact ? "source-picker-compact" : ""}`}>
      {!compact && <span className="eyebrow">Elige una imagen</span>}
      {compact ? <h2 className="display">{title}</h2> : <h1 className="display display-xl">{title}</h1>}
      <p className="muted hero-lead">{lead}</p>

      <button className="dropzone" onClick={choose} disabled={busy}>
        <ImageUp size={28} strokeWidth={1.5} />
        <strong>{busy ? "Importando…" : "Arrastra una imagen aquí o haz clic para elegirla"}</strong>
        <span className="muted small">PNG, JPG, WebP, BMP o TIFF · se copia al proyecto, el archivo original no se toca</span>
      </button>

      {recent.length > 0 && (
        <>
          <div className="section-head">
            {compact ? <span className="eyebrow">O elige una de la biblioteca</span> : <h2 className="display">O sigue con una del proyecto</h2>}
          </div>
          <div className="picker-grid">
            {recent.map((a) => <Thumb key={a.id} asset={a} onOpen={() => onPick(a)} onDelete={actions ? () => actions.remove([a]) : undefined} />)}
          </div>
        </>
      )}
    </section>
  );
}
