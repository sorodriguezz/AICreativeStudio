import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { ArrowLeft, Copy, Download, FileCode2, FolderOpen, Shapes } from "lucide-react";
import { api, fileUrl, type BrandKit, type KitFile } from "../lib/api";
import { errorText } from "../lib/hooks";
import { relativeTime } from "../lib/format";
import { Empty } from "./ui";
import { useToast } from "./Toasts";

const sep = (dir: string) => (dir.includes("\\") ? "\\" : "/");
const kitPath = (kit: BrandKit, rel: string) => kit.dir + sep(kit.dir) + rel.split("/").join(sep(kit.dir));

export default function BrandKits({ projectId, focusKitId, onGenerate }: { projectId: string; focusKitId: string | null; onGenerate: () => void }) {
  const [kits, setKits] = useState<BrandKit[]>([]);
  const [current, setCurrent] = useState<string | null>(focusKitId);

  useEffect(() => {
    api.listBrandKits(projectId).then(setKits);
  }, [projectId, focusKitId]);
  useEffect(() => setCurrent(focusKitId), [focusKitId]);

  const kit = kits.find((k) => k.id === current);
  if (kit) return <KitDetail kit={kit} onBack={() => setCurrent(null)} />;

  if (kits.length === 0) {
    return (
      <div className="kits-empty">
        <Empty icon={<Shapes size={22} />} title="Todavía no hay kits de marca">
          Genera un logo, ábrelo y elige <strong>Crear kit de marca</strong>. <button className="link" onClick={onGenerate}>Ir a generar</button>
        </Empty>
      </div>
    );
  }

  return (
    <div className="kits">
      {kits.map((k) => (
        <button key={k.id} className="kit-card" onClick={() => setCurrent(k.id)}>
          <div className="kit-card-logo" style={{ background: k.colors.light }}>
            <img src={fileUrl(kitPath(k, "logo/logo.png"))} alt="" />
          </div>
          <div className="kit-card-palette">
            {k.palette.slice(0, 6).map((s) => <span key={s.hex} style={{ background: s.hex, flex: Math.max(0.4, s.share) }} />)}
          </div>
          <div className="kit-card-info">
            <strong>{k.name}</strong>
            <span className="muted small">{k.files.length} archivos · {relativeTime(k.created_at)}</span>
          </div>
        </button>
      ))}
    </div>
  );
}

function KitDetail({ kit, onBack }: { kit: BrandKit; onBack: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const groups = useMemo(() => {
    const map = new Map<string, KitFile[]>();
    for (const f of kit.files) map.set(f.group, [...(map.get(f.group) ?? []), f]);
    return [...map.entries()];
  }, [kit]);

  async function exportKit() {
    const dest = await open({ directory: true, multiple: false, title: "¿Dónde guardo el kit?" });
    if (!dest) return;
    setBusy(true);
    try {
      const dir = await api.exportBrandKit(kit.id, dest as string);
      toast({ tone: "success", title: "Kit exportado", body: dir, action: { label: "Mostrar", run: () => openPath(dir) } });
    } catch (e) {
      toast({ tone: "error", title: "No se pudo exportar el kit", body: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const copy = (hex: string) => {
    navigator.clipboard.writeText(hex);
    toast({ tone: "info", title: `${hex} copiado` });
  };

  return (
    <div className="kit">
      <header className="kit-head" style={{ background: kit.colors.light }}>
        <button className="btn btn-ghost btn-s" onClick={onBack}><ArrowLeft size={14} /> Todos los kits</button>
        <div className="kit-hero">
          <img src={fileUrl(kitPath(kit, "logo/logo.png"))} alt="" />
          <div>
            <span className="eyebrow">Kit de marca</span>
            <h1 className="display">{kit.name}</h1>
          </div>
        </div>
        <div className="row gap-xs">
          <button className="btn" onClick={() => openPath(kitPath(kit, "guia.html"))}><FileCode2 size={15} /> Ver guía</button>
          <button className="btn" onClick={() => revealItemInDir(kitPath(kit, "logo/logo.png"))}><FolderOpen size={15} /> Abrir carpeta</button>
          <button className="btn btn-primary" onClick={exportKit} disabled={busy}>{busy ? <span className="spinner" /> : <Download size={15} />} Exportar kit…</button>
        </div>
      </header>

      <section className="kit-section">
        <span className="eyebrow">Paleta</span>
        <div className="swatches">
          {kit.palette.map((s) => (
            <button key={s.hex} className="swatch" style={{ background: s.hex }} onClick={() => copy(s.hex)} title="Copiar">
              <span className="swatch-label" style={{ color: luminance(s.rgb) > 0.45 ? "#111" : "#fff" }}>
                <strong className="mono">{s.hex}</strong>
                <span>{Math.round(s.share * 100)}%{s.hex === kit.colors.primary ? " · principal" : ""}</span>
                <Copy size={12} />
              </span>
            </button>
          ))}
        </div>
      </section>

      {groups.filter(([g]) => g !== "Paleta y guía").map(([group, files]) => (
        <section key={group} className="kit-section">
          <span className="eyebrow">{group}</span>
          <div className="kit-files">
            {files.map((f) => (
              <figure key={f.rel} className="kit-file" onDoubleClick={() => revealItemInDir(kitPath(kit, f.rel))}>
                <div className={`kit-file-preview ${f.surface === "checker" ? "checker" : ""}`} style={f.surface !== "checker" ? { background: f.surface } : undefined}>
                  <img src={fileUrl(kitPath(kit, f.rel))} alt="" style={f.width <= 48 ? { width: f.width * 2, imageRendering: "pixelated" } : undefined} />
                </div>
                <figcaption>
                  <span>{f.label}</span>
                  <span className="mono muted small">{f.rel.split("/").pop()}</span>
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      ))}

      <section className="kit-section">
        <span className="eyebrow">Paleta y guía</span>
        <div className="row gap-xs wrap">
          {kit.files.filter((f) => f.group === "Paleta y guía").map((f) => (
            <button key={f.rel} className="chip chip-button" onClick={() => openPath(kitPath(kit, f.rel))}>{f.label}</button>
          ))}
        </div>
      </section>
    </div>
  );
}

function luminance([r, g, b]: [number, number, number]) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}
