import { useEffect, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { CheckCircle2, CircleAlert, Download, FolderOpen, Monitor, Moon, RefreshCw, Sun } from "lucide-react";
import { api, type EngineStatus, type HardwareInfo, type ProviderStatus } from "../lib/api";
import { setProvider, useProviderSetting, type ImageProvider, type PromptProvider } from "../lib/providers";
import { checkForUpdates, installUpdate, useUpdates } from "../lib/updates";
import { formatBytes } from "../lib/format";
import { modKey } from "../lib/format";
import { PROFILE_LABEL, label } from "../lib/labels";
import { applyTheme, readTheme, type ThemePref } from "../lib/theme";
import { Kbd, PageHeader, Segmented } from "../components/ui";

const SHORTCUTS: [string, string][] = [
  [`${modKey} ↵`, "Generar"],
  ["/", "Ir al prompt"],
  [`${modKey} 1 … 9`, "Cambiar de sección"],
  ["← →", "Navegar imágenes en el visor"],
  ["Esc", "Cerrar visor o menú"],
];

export default function Settings({ engine }: { engine: EngineStatus | null }) {
  const [hw, setHw] = useState<HardwareInfo | null>(null);
  const [info, setInfo] = useState<{ data_dir: string; version: string } | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [theme, setTheme] = useState<ThemePref>(readTheme);

  useEffect(() => {
    api.appInfo().then(setInfo);
  }, []);
  useEffect(() => {
    if (engine?.state === "ready") api.hardware().then(setHw).catch(() => undefined);
  }, [engine?.state]);

  async function restart() {
    setRestarting(true);
    try {
      await api.restartEngine();
    } finally {
      setRestarting(false);
    }
  }

  return (
    <div className="page">
      <PageHeader eyebrow="Configuración" title="Preferencias" />
      <div className="settings-grid">

      <section className="card">
        <div className="card-head">
          <h3>Apariencia</h3>
          <Segmented
            value={theme}
            onChange={(t) => { setTheme(t); applyTheme(t); }}
            options={[
              { value: "system", label: <><Monitor size={14} /> Sistema</> },
              { value: "light", label: <><Sun size={14} /> Claro</> },
              { value: "dark", label: <><Moon size={14} /> Oscuro</> },
            ]}
          />
        </div>
        <p className="muted small">Por defecto sigue el tema de tu sistema operativo.</p>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Motor de IA</h3>
          <button className="btn btn-s" onClick={restart} disabled={restarting}><RefreshCw size={14} className={restarting ? "spin" : ""} /> {restarting ? "Reiniciando…" : "Reiniciar"}</button>
        </div>
        <dl className="meta">
          <dt>Estado</dt>
          <dd><span className={`pill pill-engine-${engine?.state}`}><span className="pill-dot" />{engine?.message ?? "—"}</span></dd>
          <dt>Intérprete</dt>
          <dd className="mono small">{engine?.python ?? "—"}</dd>
          <dt>Puerto local</dt>
          <dd className="mono">{engine?.port ?? "—"}</dd>
          {engine?.runtime && (
            <>
              <dt>PyTorch</dt>
              <dd>{engine.runtime.torch ? ({ pypi: "Metal (Apple Silicon)", cpu: "CPU" } as Record<string, string>)[engine.runtime.variant] ?? engine.runtime.variant.toUpperCase() : "No instalado · modo compatible (ONNX)"}</dd>
              {engine.runtime.gpu && <><dt>GPU</dt><dd>{engine.runtime.gpu}</dd></>}
            </>
          )}
        </dl>
        <p className="muted small">Tras 5 minutos sin usarse, el motor se apaga para liberar memoria y no dejar procesos corriendo. Vuelve a arrancar solo cuando lo necesitas (tarda unos segundos).</p>
      </section>

      <ProvidersCard engineReady={engine?.state === "ready" || engine?.state === "idle"} />

      <UpdatesCard version={info?.version} />

      <section className="card">
        <h3>Hardware</h3>
        {hw ? (
          <dl className="meta">
            <dt>Plataforma</dt>
            <dd>{hw.platform} · {hw.arch}</dd>
            <dt>Acelerador</dt>
            <dd>{hw.device.toUpperCase()} · {hw.device_name}</dd>
            <dt>Memoria</dt>
            <dd>{hw.total_memory_gb} GB{hw.accelerator_memory_gb && hw.device === "cuda" ? ` · ${hw.accelerator_memory_gb} GB VRAM` : ""}</dd>
            <dt>Perfil</dt>
            <dd><strong>{label(PROFILE_LABEL, hw.profile)}</strong> · hasta {hw.defaults.max_side}px · {hw.defaults.max_batch} imágenes por trabajo</dd>
          </dl>
        ) : (
          <p className="muted">Disponible cuando el motor esté listo.</p>
        )}
      </section>

      <section className="card">
        <h3>Atajos de teclado</h3>
        <dl className="meta shortcuts">
          {SHORTCUTS.map(([k, v]) => (
            <div key={v} className="contents">
              <dt><Kbd>{k}</Kbd></dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="card">
        <h3>Privacidad</h3>
        <ul className="plain">
          <li>Con el motor local, todo se procesa en este equipo y no se sube nada a la nube.</li>
          <li>Si eliges ChatGPT, Gemini o Claude en Proveedores, el prompt y las imágenes de ese trabajo se envían a ese servicio con tu cuenta.</li>
          <li>Internet sólo se usa para descargar modelos cuando tú lo pides.</li>
          <li>Los temporales se borran al iniciar la app.</li>
          <li>Nunca se generan desnudos ni contenido sexual de personas reales o de menores.</li>
        </ul>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Datos</h3>
          {info && <button className="btn btn-s" onClick={() => openPath(info.data_dir)}><FolderOpen size={14} /> Abrir carpeta</button>}
        </div>
        <dl className="meta">
          <dt>Carpeta</dt>
          <dd className="mono small">{info?.data_dir}</dd>
          <dt>Versión</dt>
          <dd className="mono">{info?.version}</dd>
        </dl>
      </section>
      </div>
    </div>
  );
}

const IMAGE_OPTIONS: { value: ImageProvider; label: string }[] = [
  { value: "local", label: "Este equipo" },
  { value: "codex", label: "ChatGPT" },
  { value: "gemini", label: "Gemini" },
];
const PROMPT_OPTIONS: { value: PromptProvider; label: string }[] = [
  { value: "none", label: "No" },
  { value: "claude", label: "Claude" },
  { value: "codex", label: "ChatGPT" },
  { value: "gemini", label: "Gemini" },
];
const CLI_NAME: Record<string, string> = { codex: "Codex CLI", gemini: "Antigravity CLI (agy)", claude: "Claude Code" };

/** Suscripciones por CLI (nunca API keys) que pueden reemplazar al motor local. */
function ProvidersCard({ engineReady }: { engineReady: boolean }) {
  const current = useProviderSetting();
  const [list, setList] = useState<ProviderStatus[] | null>(null);
  const [checking, setChecking] = useState(false);

  async function load(refresh = false) {
    setChecking(true);
    try {
      setList(await api.providers(refresh));
    } catch {
      setList(null);
    } finally {
      setChecking(false);
    }
  }
  useEffect(() => { if (engineReady && !list) load(); }, [engineReady]);

  const ready = (id: string) => id === "local" || id === "none" || !!list?.find((p) => p.id === id)?.ready;
  const why = (id: string) => (ready(id) ? undefined : list?.find((p) => p.id === id)?.message ?? "Comprobando…");

  return (
    <section className="card">
      <div className="card-head">
        <h3>Proveedores de IA</h3>
        <button className="btn btn-s" onClick={() => load(true)} disabled={checking || !engineReady}><RefreshCw size={14} className={checking ? "spin" : ""} /> Comprobar</button>
      </div>
      <p className="muted small">Usa tu suscripción de ChatGPT, Gemini o Claude a través de su CLI oficial, con la sesión que ya iniciaste en este equipo. Nunca se usa una API key.</p>

      <div className="provider-pick">
        <span className="small"><strong>Generar y editar imágenes</strong> — en toda la app</span>
        <Segmented value={current.images} onChange={(v) => setProvider("images", v)}
          options={IMAGE_OPTIONS.map((o) => ({ ...o, disabled: !ready(o.value) && o.value !== current.images, title: why(o.value) }))} />
      </div>
      <div className="provider-pick">
        <span className="small"><strong>Mejorar los prompts antes de generar</strong></span>
        <Segmented value={current.prompts} onChange={(v) => setProvider("prompts", v)}
          options={PROMPT_OPTIONS.map((o) => ({ ...o, disabled: !ready(o.value) && o.value !== current.prompts, title: why(o.value) }))} />
        <span className="muted small">Claude no genera imágenes desde su CLI: escribe un prompt más detallado y la imagen la hace el proveedor de arriba.</span>
      </div>

      <div className="provider-list">
        {!list && <p className="muted small">{engineReady ? "Comprobando las CLIs instaladas…" : "Disponible cuando el motor esté listo."}</p>}
        {list?.map((p) => (
          <div key={p.id} className="provider-row">
            <span><strong>{p.label}</strong> <span className="muted small">· {CLI_NAME[p.id]}{p.version ? ` ${p.version}` : ""}{p.experimental ? " · experimental" : ""}</span></span>
            {p.ready
              ? <span className="provider-state ok"><CheckCircle2 size={14} /> {p.account ?? "Lista"}</span>
              : <span className="provider-state warn"><CircleAlert size={14} /> {p.installed ? "Sin sesión" : "No instalada"}</span>}
            <span className="muted small">{p.ready ? (p.images ? "Imágenes y prompts." : "Sólo prompts (texto).") + " " + p.message : p.message}</span>
          </div>
        ))}
      </div>
      <p className="muted small">Las mismas reglas de contenido se aplican antes de enviar nada: nunca desnudos ni contenido sugerente de personas reales, nunca menores.</p>
    </section>
  );
}

function UpdatesCard({ version }: { version?: string }) {
  const { phase, update, downloaded, total, error, checkedAt } = useUpdates();
  return (
    <section className="card update-card">
      <div className="card-head">
        <h3>Actualizaciones</h3>
        <button className="btn btn-s" onClick={() => checkForUpdates()} disabled={["checking", "downloading", "installing"].includes(phase)}>
          <RefreshCw size={14} className={phase === "checking" ? "spin" : ""} /> {phase === "checking" ? "Buscando…" : "Buscar"}
        </button>
      </div>
      <dl className="meta">
        <dt>Versión instalada</dt>
        <dd className="mono">{version ?? "—"}</dd>
        <dt>Estado</dt>
        <dd>
          {phase === "available" && update ? `Hay una versión nueva: ${update.version}`
            : phase === "none" ? "Tienes la última versión."
            : phase === "downloading" ? `Descargando… ${formatBytes(downloaded)}${total ? ` de ${formatBytes(total)}` : ""}`
            : phase === "installing" ? "Instalando… la app se reiniciará."
            : phase === "error" ? error
            : "Se busca sola al abrir la app y cada 6 horas."}
        </dd>
      </dl>
      {phase === "available" && update && (
        <div className="row gap-s">
          <button className="btn btn-primary" onClick={installUpdate}><Download size={15} /> Actualizar a {update.version}</button>
          {error && <span className="small muted">{error}</span>}
        </div>
      )}
      {update?.body && phase === "available" && <p className="muted small">{update.body}</p>}
      {checkedAt && <p className="muted small">Última comprobación: {new Date(checkedAt).toLocaleTimeString()}</p>}
    </section>
  );
}
