import { useCallback, useEffect, useRef, useState } from "react";
import {
  Boxes, Camera, Eraser, History as HistoryIcon, Layers, LayoutGrid, Settings as SettingsIcon, Shapes, Sparkles, Wand2, WandSparkles,
  type LucideIcon,
} from "lucide-react";
import { api, fileUrl, onBatchUpdate, type Asset, type BrandKit, type Job, type Project, type Section } from "./lib/api";
import { useAssetsDeleted, useAssetsSaved, useEngineStatus, useJobUpdates } from "./lib/hooks";
import { modKey } from "./lib/format";
import { ToastProvider, useToast } from "./components/Toasts";
import { AssetActionsProvider } from "./components/AssetActions";
import SessionSwitcher from "./components/SessionSwitcher";
import UpdateNotice from "./components/UpdateNotice";
import { PROVIDER_SHORT, useProviderSetting } from "./lib/providers";
import { SessionProvider } from "./lib/session";
import SetupScreen from "./components/SetupScreen";
import ProjectSwitcher from "./components/ProjectSwitcher";
import Studio, { type IncomingDraft } from "./pages/Studio";
import Library from "./pages/Library";
import History from "./pages/History";
import Models from "./pages/Models";
import Settings from "./pages/Settings";
import ComingSoon, { type ModuleInfo } from "./pages/ComingSoon";
import Edit, { type IncomingAsset } from "./pages/Edit";
import Enhance from "./pages/Enhance";
import Photo from "./pages/Photo";
import Restore from "./pages/Restore";
import Production from "./pages/Production";

type Page = "library" | "create" | "edit" | "enhance" | "restore" | "brand" | "photo" | "history" | "production" | "models" | "settings";

const UPCOMING: Partial<Record<Page, ModuleInfo>> = {
};

const NAV: { group: string; items: { id: Page; label: string; icon: LucideIcon; soon?: boolean }[] }[] = [
  {
    group: "Estudio",
    items: [
      { id: "create", label: "Crear", icon: Sparkles },
      { id: "brand", label: "Brand Studio", icon: Shapes },
      { id: "edit", label: "Editar", icon: Wand2 },
      { id: "enhance", label: "Mejorar", icon: WandSparkles },
      { id: "restore", label: "Restaurar", icon: Eraser },
      { id: "photo", label: "Photo Studio", icon: Camera },
    ],
  },
  {
    group: "Archivo",
    items: [
      { id: "library", label: "Biblioteca", icon: LayoutGrid },
      { id: "history", label: "Historial", icon: HistoryIcon },
      { id: "production", label: "Producción", icon: Layers },
    ],
  },
  {
    group: "Sistema",
    items: [
      { id: "models", label: "Modelos", icon: Boxes },
      { id: "settings", label: "Configuración", icon: SettingsIcon },
    ],
  },
];

const PAGE_ORDER: Page[] = NAV.flatMap((g) => g.items.map((i) => i.id));
const TITLES: Record<Page, string> = Object.fromEntries(NAV.flatMap((g) => g.items.map((i) => [i.id, i.label]))) as Record<Page, string>;
const PROJECT_PAGES: Page[] = ["create", "brand", "edit", "enhance", "restore", "photo", "library", "production"];
const SESSION_PAGES: Page[] = ["create", "brand", "edit", "enhance", "restore", "photo"];

const readPref = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const writePref = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* sin almacenamiento */
  }
};

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

function Shell() {
  const engine = useEngineStatus();
  const toast = useToast();
  const [page, setPage] = useState<Page>(() => {
    const p = readPref("aics.page", "create") as Page;
    return PAGE_ORDER.includes(p) ? p : "create";
  });
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState(() => readPref("aics.project", "general"));
  const [incoming, setIncoming] = useState<IncomingDraft | null>(null);
  const [incomingAsset, setIncomingAsset] = useState<IncomingAsset | null>(null);
  const [focusKit, setFocusKit] = useState<{ kitId: string; nonce: number } | null>(null);
  const pageRef = useRef(page);
  pageRef.current = page;

  const loadProjects = useCallback(() => {
    api.projects().then((list) => {
      setProjects(list);
      setProjectId((cur) => (list.length && !list.some((p) => p.id === cur) ? list[0].id : cur));
    });
  }, []);
  useEffect(loadProjects, [loadProjects]);
  const provider = useProviderSetting();
  useEffect(() => writePref("aics.page", page), [page]);
  useEffect(() => writePref("aics.project", projectId), [projectId]);

  // Borrar desde cualquier sección cambia portadas y contadores de los proyectos.
  useAssetsDeleted(loadProjects);
  useAssetsSaved(loadProjects);

  // Avisos globales cuando termina un trabajo, y refresco de portadas/contadores.
  const notified = useRef(new Set<string>());
  useJobUpdates(
    useCallback(
      async (job: Job) => {
        if (!["completed", "failed", "rejected"].includes(job.status) || notified.current.has(job.id)) return;
        notified.current.add(job.id);
        loadProjects();
        const visible = pageRef.current === job.mode;
        if (job.status === "completed") {
          if (visible) return;
          const [first] = await api.assets({ jobId: job.id, limit: 1 });
          toast({
            tone: "success",
            title: "Imágenes listas",
            body: job.prompt,
            image: first ? fileUrl(first.path) : undefined,
            action: { label: "Ver", run: () => { setProjectId(job.project_id); setPage(PAGE_ORDER.includes(job.mode as Page) ? (job.mode as Page) : "create"); } },
          });
        } else if (!visible) {
          toast({ tone: "error", title: job.status === "rejected" ? "Solicitud rechazada" : "La generación falló", body: job.error ?? job.prompt });
        }
      },
      [loadProjects, toast],
    ),
  );

  // Aviso cuando termina un lote.
  useEffect(() => {
    const off = onBatchUpdate((b) => {
      if (b.status === "running") return;
      toast({
        tone: b.status === "completed" ? "success" : b.status === "cancelled" ? "info" : "error",
        title: b.status === "completed" ? `Lote listo: ${b.name}` : b.status === "cancelled" ? `Lote detenido: ${b.name}` : `Lote con errores: ${b.name}`,
        body: `${b.done} de ${b.total} imágenes${b.failed ? ` · ${b.failed} con error` : ""}`,
        action: pageRef.current === "production" ? undefined : { label: "Ver", run: () => setPage("production") },
      });
    });
    return () => void off.then((f) => f());
  }, [toast]);

  // Atajos: ⌘1…⌘9 para cambiar de sección.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= PAGE_ORDER.length) {
        e.preventDefault();
        setPage(PAGE_ORDER[n - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // En reposo cuenta como disponible: la primera petición lo despierta sola.
  const engineReady = engine?.state === "ready" || engine?.state === "idle";
  const engineMessage = engine?.state === "error" ? "El motor de IA tuvo un problema. Revísalo en Configuración." : "El motor de IA se está iniciando…";
  const reuse = (prompt: string, seed?: number, mode: "create" | "brand" = "create") => {
    setIncoming({ prompt, seed, nonce: Date.now() });
    setPage(mode);
  };
  const openIn = useCallback((target: "edit" | "enhance" | "photo" | "restore", asset: Asset) => {
    setIncomingAsset({ assetId: asset.id, nonce: Date.now() });
    setProjectId(asset.project_id);
    setPage(target);
  }, []);
  const onKitCreated = useCallback((kit: BrandKit) => {
    setProjectId(kit.project_id);
    setFocusKit({ kitId: kit.id, nonce: Date.now() });
    setPage("brand");
    toast({ tone: "success", title: `Kit "${kit.name}" listo`, body: `${kit.files.length} archivos generados` });
  }, [toast]);

  function renderPage() {
    switch (page) {
      case "create":
      case "brand":
        return <Studio key={`${page}-${projectId}`} mode={page} projectId={projectId} engineReady={engineReady} engineMessage={engineMessage} incoming={incoming} onOpenIn={openIn} focusKit={page === "brand" ? focusKit : null} />;
      case "edit":
        return <Edit key={`edit-${projectId}`} projectId={projectId} engineReady={engineReady} engineMessage={engineMessage} incoming={incomingAsset} />;
      case "restore":
        return <Restore key={`restore-${projectId}`} projectId={projectId} engineReady={engineReady} engineMessage={engineMessage} incoming={incomingAsset} />;
      case "production":
        return <Production key={`production-${projectId}`} projectId={projectId} />;
      case "photo":
        return <Photo key={`photo-${projectId}`} projectId={projectId} engineReady={engineReady} engineMessage={engineMessage} incoming={incomingAsset} />;
      case "enhance":
        return <Enhance key={`enhance-${projectId}`} projectId={projectId} engineReady={engineReady} engineMessage={engineMessage} incoming={incomingAsset} />;
      case "library":
        return <Library projects={projects} projectId={projectId} onSelect={setProjectId} onProjectsChanged={loadProjects} onCreate={() => setPage("create")} onReuse={reuse} onOpenIn={openIn} />;
      case "history":
        return <History projects={projects} onReuse={reuse} onOpenIn={openIn} />;
      case "models":
        return <Models engineReady={engineReady} />;
      case "settings":
        return <Settings engine={engine} />;
      default:
        return UPCOMING[page] ? <ComingSoon module={UPCOMING[page]!} /> : null;
    }
  }

  return (
    <AssetActionsProvider openIn={openIn} onKitCreated={onKitCreated}>
    <SessionProvider projectId={projectId}>
    <div className="app">
      <nav className="sidebar">
        <div className="sidebar-top" data-tauri-drag-region />
        <div className="wordmark">
          <span className="wordmark-mark" aria-hidden />
          <span><b>AI</b>CreativeStudio</span>
        </div>
        {NAV.map((g) => (
          <div key={g.group} className="nav-group">
            <span className="nav-label">{g.group}</span>
            {g.items.map((item) => {
              const Icon = item.icon;
              const n = PAGE_ORDER.indexOf(item.id) + 1;
              return (
                <button key={item.id} className={`nav-item ${page === item.id ? "active" : ""} ${item.soon ? "soon" : ""}`} onClick={() => setPage(item.id)} title={`${item.label} (${modKey}${n})`}>
                  <Icon size={16} strokeWidth={1.8} />
                  <span className="grow">{item.label}</span>
                  {item.soon && <span className="nav-soon">pronto</span>}
                </button>
              );
            })}
          </div>
        ))}
        <UpdateNotice />
        <button className={`engine engine-${engine?.state ?? "stopped"}`} onClick={() => setPage("settings")} title={engine?.message}>
          <span className="engine-dot" />
          <span className="grow">{engine?.state === "ready" ? "Motor listo" : engine?.state === "idle" ? "Motor en reposo" : engine?.state === "preparing" ? "Preparando motor…" : engine?.state === "starting" ? "Iniciando motor…" : engine?.state === "error" ? "Error del motor" : "Motor detenido"}</span>
          <span className="mono small muted" title="Quién genera las imágenes (Configuración → Proveedores)">{PROVIDER_SHORT[provider.images] ?? "local"}</span>
        </button>
      </nav>

      <div className="workspace">
        <header className="topbar" data-tauri-drag-region>
          <span className="topbar-title" data-tauri-drag-region>{TITLES[page]}</span>
          {PROJECT_PAGES.includes(page) && <ProjectSwitcher projects={projects} projectId={projectId} onSelect={setProjectId} onCreated={loadProjects} />}
          {SESSION_PAGES.includes(page) && <><span className="topbar-sep">/</span><SessionSwitcher key={`${projectId}-${page}`} projectId={projectId} section={page as Section} /></>}
        </header>
        <main className="main">
          {engine && (engine.state === "preparing" || (engine.state === "error" && engine.setup_failed)) ? <SetupScreen engine={engine} /> : renderPage()}
        </main>
      </div>
    </div>
    </SessionProvider>
    </AssetActionsProvider>
  );
}
