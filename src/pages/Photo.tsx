import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUp, Camera, ImagePlus, MoreHorizontal, Paintbrush, PersonStanding, ShieldCheck, SunMedium, Trash2, UserRound, Users, Wand2 } from "lucide-react";
import { api, fileUrl, isTerminal, type Asset, type Job, type JobParams, type Person, type PoseData } from "../lib/api";
import { errorText, useAssetsDeleted, useJobs, useJobUpdates } from "../lib/hooks";
import { modKey } from "../lib/format";
import { ASPECTS } from "../lib/labels";
import { POSES, poseData } from "../lib/poses";
import CompareSlider from "../components/CompareSlider";
import RunCard from "../components/RunCard";
import SourcePicker, { importFiles, useFileDrop } from "../components/SourcePicker";
import Viewer from "../components/Viewer";
import PoseEditor, { Skeleton } from "../components/photo/PoseEditor";
import PersonPicker from "../components/photo/PersonPicker";
import People from "../components/photo/People";
import { ValidationPanel } from "../components/photo/ValidationBadge";
import { SaveToggle, useAssetActions } from "../components/AssetActions";
import { useSession } from "../lib/session";
import { useFitSize } from "../components/useFitSize";
import { Kbd, Popover, Progress, Segmented, Thumb } from "../components/ui";
import { useToast } from "../components/Toasts";
import type { IncomingAsset } from "./Edit";

type Tab = "retouch" | "session" | "pose" | "people";

interface Props {
  projectId: string;
  engineReady: boolean;
  engineMessage: string;
  incoming: IncomingAsset | null;
}

const TOOLS = [
  { id: "retouch" as const, icon: Paintbrush, label: "Retocar", hint: "Piel y color de una foto" },
  { id: "session" as const, icon: Camera, label: "Fotos nuevas", hint: "De una persona registrada" },
  { id: "pose" as const, icon: PersonStanding, label: "Cambiar pose", hint: "Misma persona, otra postura" },
];

export default function Photo({ projectId, engineReady, engineMessage, incoming }: Props) {
  const [tab, setTab] = useState<Tab>(incoming ? "retouch" : "retouch");
  const [people, setPeople] = useState<Person[]>([]);
  const loadPeople = useCallback(() => api.persons().then(setPeople).catch(() => setPeople([])), []);
  useEffect(() => { loadPeople(); }, [loadPeople, tab]); // al volver de Personas, con referencias al día
  useEffect(() => { if (incoming) setTab("retouch"); }, [incoming]);

  return (
    <div className="photo">
      <header className="photo-bar">
        <nav className="photo-tools" aria-label="Herramientas de Photo Studio">
          {TOOLS.map((t) => (
            <button key={t.id} className={`photo-tool ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)}>
              <t.icon size={17} />
              <span className="stack">
                <strong>{t.label}</strong>
                <span className="small muted">{t.hint}</span>
              </span>
            </button>
          ))}
        </nav>
        <button className={`photo-people ${tab === "people" ? "on" : ""}`} onClick={() => setTab("people")} title="Personas registradas y sus fotos de referencia">
          <span className="avatar-stack">
            {people.slice(0, 3).map((p) => <span key={p.id} className="person-avatar person-avatar-s">{p.cover_path ? <img src={fileUrl(p.cover_path)} alt="" /> : <UserRound size={13} />}</span>)}
            {people.length === 0 && <span className="person-avatar person-avatar-s"><Users size={13} /></span>}
          </span>
          <span>Personas</span>
          {people.length > 0 && <span className="muted small mono">{people.length}</span>}
        </button>
      </header>
      {tab === "retouch" && <Retouch projectId={projectId} engineReady={engineReady} engineMessage={engineMessage} incoming={incoming} />}
      {tab === "session" && <IdentityStudio key="session" kind="session" people={people} projectId={projectId} engineReady={engineReady} engineMessage={engineMessage} onManage={() => setTab("people")} />}
      {tab === "pose" && <IdentityStudio key="pose" kind="pose" people={people} projectId={projectId} engineReady={engineReady} engineMessage={engineMessage} onManage={() => setTab("people")} />}
      {tab === "people" && <People focus={null} onChanged={loadPeople} />}
    </div>
  );
}

// ---------- Retoque ----------

const LOOKS = [
  { id: "natural", label: "Natural", swatch: "linear-gradient(135deg,#e9c9b0,#b98a6c)" },
  { id: "editorial", label: "Editorial", swatch: "linear-gradient(135deg,#d9cfc7,#5d5a63)" },
  { id: "moda_calida", label: "Moda cálida", swatch: "linear-gradient(135deg,#f6c38f,#b4593a)" },
  { id: "moda_fria", label: "Moda fría", swatch: "linear-gradient(135deg,#cfe0f0,#4d6a8a)" },
  { id: "bn_editorial", label: "B/N editorial", swatch: "linear-gradient(135deg,#eee,#222)" },
  { id: "cine", label: "Cine", swatch: "linear-gradient(135deg,#f0b27a,#1f4e5a)" },
];

function Retouch({ projectId, engineReady, engineMessage, incoming }: { projectId: string; engineReady: boolean; engineMessage: string; incoming: IncomingAsset | null }) {
  const toast = useToast();
  const actions = useAssetActions();
  const session = useSession("photo");
  const [source, setSource] = useState<Asset | null>(null);
  const [results, setResults] = useState<Asset[]>([]);
  const [selected, setSelected] = useState<Asset | null>(null);
  const [look, setLook] = useState("editorial");
  const [skin, setSkin] = useState(0.5);
  const [intensity, setIntensity] = useState(1);
  const [vignette, setVignette] = useState(0.15);
  const [grain, setGrain] = useState(0.1);
  const [submitting, setSubmitting] = useState(false);
  const [more, setMore] = useState(false);
  const { jobs } = useJobs(projectId, 40);

  useEffect(() => { if (incoming) api.getAsset(incoming.assetId).then((a) => a && setSource(a)); }, [incoming]);
  const load = useCallback(async (newest = false) => {
    if (!source) return;
    const list = (await api.assetChildren(source.id)).filter((a) => a.metadata.operation === "portrait_retouch");
    setResults(list);
    setSelected((cur) => (newest ? list[0] : cur && list.find((a) => a.id === cur.id)) ?? list[0] ?? null);
  }, [source?.id]);
  useEffect(() => { setSelected(null); load(); }, [load]);
  useAssetsDeleted(useCallback((ids: string[]) => {
    if (source && ids.includes(source.id)) setSource(null);
    else load();
  }, [source?.id, load]));
  useJobUpdates(useCallback((job: Job) => {
    if (job.input_asset_id !== source?.id) return;
    if (job.status === "completed") load(true);
    if (job.status === "failed" || job.status === "rejected") toast({ tone: "error", title: "No se pudo retocar", body: job.error ?? "" });
  }, [source?.id, load, toast]));
  const dropping = useFileDrop(useCallback(async (paths: string[]) => {
    try { setSource((await importFiles(projectId, paths.slice(0, 1)))[0]); } catch (e) { toast({ tone: "error", title: "No se pudo importar", body: errorText(e) }); }
  }, [projectId, toast]));

  const ratio = (selected ?? source)?.width && (selected ?? source)?.height ? (selected ?? source)!.width! / (selected ?? source)!.height! : 1;
  const { ref, size } = useFitSize(ratio, 28, `${source?.id}-${selected?.id}`);
  const active = jobs.find((j) => j.input_asset_id === source?.id && !isTerminal(j.status));

  async function run() {
    if (!source) return;
    setSubmitting(true);
    try {
      session.adopt(await api.createJob({ project_id: projectId, mode: "photo", prompt: "", input_asset_id: source.id, params: { operation: "portrait_retouch", look, skin, intensity, vignette, grain }, session_id: session.forJob }));
    } catch (e) {
      toast({ tone: "error", title: "No se pudo retocar", body: errorText(e) });
    } finally {
      setSubmitting(false);
    }
  }

  if (!source) {
    return (
      <div className={`photo-start ${dropping ? "is-dropping" : ""}`}>
        <SourcePicker compact projectId={projectId} title="Elige el retrato" lead="Suaviza la piel conservando la textura y aplica un color de revista. No se inventa nada: sólo se ajusta." onPick={setSource} />
      </div>
    );
  }

  const shownAsset = selected ?? source;
  return (
    <div className={`enhance photo-retouch ${dropping ? "is-dropping" : ""}`}>
      <div className="enhance-main">
        <div className="editor-toolbar">
          <button className="btn btn-ghost btn-s" onClick={() => setSource(null)}><ImagePlus size={14} /> Otra foto</button>
          <div className="row gap-xs">
            {selected && <SaveToggle asset={selected} />}
            {actions && (
              <div className="anchor">
                <button className="icon-btn" title="Más acciones" onClick={() => setMore((v) => !v)}><MoreHorizontal size={16} /></button>
                <Popover open={more} onClose={() => setMore(false)} align="right" className="menu">
                  <button onClick={() => { setMore(false); actions.openIn("enhance", shownAsset); }}><SunMedium size={14} /> Cambiar la luz</button>
                  <button onClick={() => { setMore(false); actions.openIn("edit", shownAsset); }}><Wand2 size={14} /> Cambiar el fondo</button>
                  <button className="danger" onClick={() => { setMore(false); actions.remove([shownAsset]); }}><Trash2 size={14} /> {selected ? "Eliminar este retoque" : "Eliminar la foto"}</button>
                </Popover>
              </div>
            )}
          </div>
        </div>
        <div className="enhance-stage" ref={ref}>
          {size.width > 0 && (selected ? <CompareSlider before={source} after={selected} size={size} /> : <img className="enhance-preview" src={fileUrl(source.path)} alt="" style={{ width: size.width, height: size.height }} />)}
        </div>
        {results.length > 0 && (
          <div className="filmstrip" aria-label="Versiones">
            <button className={`film ${!selected ? "on" : ""}`} onClick={() => setSelected(null)}>
              <img src={fileUrl(source.path)} alt="" /><span>Original</span>
            </button>
            {[...results].reverse().map((r, i) => (
              <button key={r.id} className={`film ${selected?.id === r.id ? "on" : ""}`} onClick={() => setSelected(r)}>
                <img src={fileUrl(r.path)} alt="" /><span>{r.saved ? "✓ " : ""}Retoque {i + 1}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <aside className="enhance-panel photo-panel">
        <div className="step"><span className="step-n">1</span><span>Estilo</span></div>
        <div className="looks">
          {LOOKS.map((l) => (
            <button key={l.id} className={`look ${look === l.id ? "on" : ""}`} onClick={() => setLook(l.id)}>
              <span className="look-swatch" style={{ background: l.swatch }} />{l.label}
            </button>
          ))}
        </div>
        <div className="step"><span className="step-n">2</span><span>Piel</span></div>
        <Range label="Suavizado" value={skin} onChange={setSkin} hint="Conserva poros y textura" />
        <details className="fine">
          <summary>Ajustes finos</summary>
          <Range label="Intensidad del estilo" value={intensity} onChange={setIntensity} />
          <Range label="Viñeta" value={vignette} onChange={setVignette} max={0.6} />
          <Range label="Grano de película" value={grain} onChange={setGrain} max={0.6} />
        </details>
        {selected?.metadata.validation && <ValidationPanel v={selected.metadata.validation} />}
        <div className="panel-foot">
          {active ? (
            <div className="stack gap-xs"><Progress value={active.progress} /><span className="muted small mono">{active.message}</span></div>
          ) : (
            <button className="generate" disabled={!engineReady || submitting} onClick={run} title={engineReady ? undefined : engineMessage}>
              {submitting ? <span className="spinner" /> : <ArrowUp size={18} strokeWidth={2.4} />}<span>{results.length ? "Aplicar otro retoque" : "Aplicar retoque"}</span>
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}

function Range({ label, value, onChange, max = 1, hint }: { label: string; value: number; onChange: (v: number) => void; max?: number; hint?: string }) {
  return (
    <label className="slider" title={hint}>
      <span className="row between small"><span className="muted">{label}</span><span className="mono">{Math.round(value * 100)}%</span></span>
      <input type="range" min={0} max={max} step={0.05} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

// ---------- Sesión con identidad / Cambio de pose ----------

const SCENES = [
  { label: "Retrato de estudio", prompt: "professional studio portrait, soft key light, neutral grey backdrop, 85mm, sharp focus" },
  { label: "Corporativo", prompt: "corporate headshot, business attire, bright modern office background softly blurred, natural light" },
  { label: "Editorial exterior", prompt: "editorial fashion photo outdoors, golden hour, city street, shallow depth of field" },
  { label: "Moda pasarela", prompt: "fashion runway photo, designer outfit, dramatic spotlights, audience in background" },
  { label: "Blanco y negro", prompt: "black and white portrait, high contrast, dramatic side light, film grain" },
  { label: "Lifestyle café", prompt: "lifestyle photo in a cozy cafe, warm window light, candid, natural colors" },
];

function IdentityStudio({ kind, people, projectId, engineReady, engineMessage, onManage }: { kind: "session" | "pose"; people: Person[]; projectId: string; engineReady: boolean; engineMessage: string; onManage: () => void }) {
  const session = useSession("photo");
  const toast = useToast();
  const operation = kind === "session" ? "identity_generate" : "pose_change";
  const [personId, setPersonId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(kind === "pose" ? "misma ropa y peinado, fondo de estudio neutro, luz suave" : SCENES[0].prompt);
  const [usePose, setUsePose] = useState(kind === "pose");
  const [pose, setPose] = useState<PoseData>(poseData(POSES[kind === "pose" ? 1 : 0].points));
  const [aspect, setAspect] = useState("3:4");
  const [count, setCount] = useState(4);
  const [identity, setIdentity] = useState(0.7);
  const [poseStrength, setPoseStrength] = useState(0.8);
  const [strict, setStrict] = useState(true);
  const [source, setSource] = useState<Asset | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [viewer, setViewer] = useState<number | null>(null);
  const { jobs } = useJobs(projectId, 60);

  const loadAssets = useCallback(() => api.assets({ projectId, limit: 600, all: true }).then(setAssets), [projectId]);
  useEffect(() => { loadAssets(); }, [loadAssets]);
  useAssetsDeleted(useCallback(() => { loadAssets(); }, [loadAssets]));
  useJobUpdates(useCallback((j: Job) => {
    if (j.status === "completed" && j.project_id === projectId) loadAssets();
    if ((j.status === "failed" || j.status === "rejected") && j.params.operation === operation) toast({ tone: "error", title: j.status === "rejected" ? "Rechazado" : "No se pudo generar", body: j.error ?? "" });
  }, [projectId, loadAssets, toast, operation]));

  const usable = (p: Person) => p.is_adult && p.reference_count > 0;
  useEffect(() => { if (!personId) setPersonId(people.find(usable)?.id ?? null); }, [people]);

  const runs = session.id ? jobs.filter((j) => j.params.operation === operation && j.session_id === session.id) : [];
  const byJob = useMemo(() => {
    const m = new Map<string, Asset[]>();
    for (const a of assets) if (a.job_id) m.set(a.job_id, [...(m.get(a.job_id) ?? []), a]);
    // dentro de cada tirada, la mejor identidad primero
    for (const list of m.values()) list.sort((x, y) => (y.metadata.validation?.identity ?? 0) - (x.metadata.validation?.identity ?? 0));
    return m;
  }, [assets]);
  const viewerAssets = runs.flatMap((j) => byJob.get(j.id) ?? []);
  const photos = assets.filter((a) => !a.path.endsWith(".svg"));
  const person = people.find((p) => p.id === personId);
  const poseName = useMemo(() => {
    const key = JSON.stringify(pose.body);
    return POSES.find((p) => JSON.stringify(poseData(p.points).body) === key)?.label ?? "A medida";
  }, [pose]);

  // Solo un selector abierto a la vez; empieza en lo primero que falte.
  type Slot = "person" | "source" | "pose";
  const [slot, setSlot] = useState<Slot | null>(null);
  const [touched, setTouched] = useState(false);
  const missing = (skip?: Slot): Slot | null =>
    skip !== "person" && !personId ? "person" : kind === "pose" && skip !== "source" && !source ? "source" : null;
  useEffect(() => { if (!touched) setSlot(missing() ?? (kind === "pose" ? "pose" : null)); }, [personId, source, touched]);
  const toggle = (s: Slot) => { setTouched(true); setSlot((cur) => (cur === s ? null : s)); };
  const next = (done: Slot) => { setTouched(true); setSlot(missing(done) ?? (done !== "pose" && kind === "pose" ? "pose" : null)); };

  const disabled = !engineReady ? engineMessage : !person ? "Elige una persona." : kind === "pose" && !source ? "Elige la foto de la persona." : !prompt.trim() ? "Describe la escena." : null;

  async function run() {
    if (disabled || !personId) return;
    setSubmitting(true);
    try {
      const params: JobParams = { operation, count, identity_strength: identity };
      if (usePose) { params.pose = pose; params.pose_strength = poseStrength; } else params.aspect = aspect;
      if (strict) params.min_identity = 0.363;
      const job = await api.createJob({ project_id: projectId, mode: "photo", prompt, params, person_id: personId, input_asset_id: kind === "pose" ? source!.id : undefined, session_id: session.forJob });
      session.adopt(job);
      if (job.status === "failed" || job.status === "rejected") toast({ tone: "error", title: "No se pudo iniciar", body: job.error ?? "" });
    } catch (e) {
      toast({ tone: "error", title: "No se pudo iniciar", body: errorText(e) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="identity-studio">
      <aside className="identity-panel">
        <div className="identity-steps">
          <div className="recipe">
            <button className={`recipe-tile ${slot === "person" ? "on" : ""}`} onClick={() => toggle("person")}>
              <span className="recipe-art recipe-art-round">{person?.cover_path ? <img src={fileUrl(person.cover_path)} alt="" /> : <UserRound size={18} />}</span>
              <span className="recipe-label">Persona</span>
              <span className={`recipe-value ${person ? "" : "todo"}`}>{person?.name ?? "Elegir"}</span>
            </button>
            {kind === "pose" && (
              <button className={`recipe-tile ${slot === "source" ? "on" : ""}`} onClick={() => toggle("source")}>
                <span className="recipe-art">{source ? <img src={fileUrl(source.path)} alt="" /> : <ImagePlus size={18} />}</span>
                <span className="recipe-label">Foto</span>
                <span className={`recipe-value ${source ? "" : "todo"}`}>{source ? "Lista" : "Elegir"}</span>
              </button>
            )}
            <button className={`recipe-tile ${slot === "pose" ? "on" : ""}`} onClick={() => toggle("pose")}>
              <span className="recipe-art">{usePose ? <Skeleton pose={pose} size={40} /> : <PersonStanding size={18} />}</span>
              <span className="recipe-label">Pose</span>
              <span className="recipe-value">{usePose ? poseName : "Libre"}</span>
            </button>
          </div>

          {slot === "person" && (
            <div className="recipe-editor">
              <PersonPicker people={people} value={personId} onChange={(id) => { setPersonId(id); next("person"); }} onManage={onManage} />
            </div>
          )}
          {slot === "source" && (
            <div className="recipe-editor">
              <span className="muted small">La ropa y la apariencia salen de esta foto.</span>
              {photos.length ? (
                <div className="picker-grid picker-grid-s">
                  {photos.slice(0, 12).map((a) => (
                    <div key={a.id} className={source?.id === a.id ? "picked" : undefined}><Thumb asset={a} onOpen={() => { setSource(a); next("source"); }} /></div>
                  ))}
                </div>
              ) : (
                <p className="muted small">Agrega fotos a la biblioteca para elegir una.</p>
              )}
            </div>
          )}
          {slot === "pose" && (
            <div className="recipe-editor">
              {kind === "session" && (
                <Segmented size="s" value={usePose ? "pick" : "free"} onChange={(v) => setUsePose(v === "pick")}
                  options={[{ value: "free", label: "Libre" }, { value: "pick", label: "Elegir pose" }]} />
              )}
              {usePose && <PoseEditor pose={pose} onChange={setPose} projectAssets={photos} />}
              {usePose && (
                <button className="btn btn-s btn-ghost recipe-done" onClick={() => setSlot(null)}>Listo</button>
              )}
            </div>
          )}

          <span className="recipe-heading">{kind === "pose" ? "Ropa y fondo" : "Escena"}</span>
          {kind === "session" && (
            <div className="row gap-xs wrap">
              {SCENES.map((sc) => <button key={sc.label} className={`chip chip-button ${prompt === sc.prompt ? "active" : ""}`} onClick={() => setPrompt(sc.prompt)}>{sc.label}</button>)}
            </div>
          )}
          <textarea rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe el lugar, la luz y la ropa" onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && run()} />

          <details className="fine">
            <summary>Más opciones</summary>
            {!usePose && (
              <label className="field"><span>Formato</span>
                <select value={aspect} onChange={(e) => setAspect(e.target.value)}>{ASPECTS.map((a) => <option key={a}>{a}</option>)}</select>
              </label>
            )}
            <Range label="Parecido con la persona" value={identity} onChange={setIdentity} hint="Más alto = más parecido, menos libertad creativa" />
            {usePose && <Range label="Fidelidad a la pose" value={poseStrength} onChange={setPoseStrength} />}
            <div className="row between">
              <span className="small muted">Fotos por tirada</span>
              <Segmented size="s" value={count} onChange={setCount} options={[1, 2, 3, 4].map((n) => ({ value: n, label: n }))} />
            </div>
            <label className="row gap-xs small check"><input type="checkbox" checked={strict} onChange={(e) => setStrict(e.target.checked)} /> Descartar las que no se parezcan</label>
          </details>
        </div>

        <div className="panel-foot">
          <button className="generate" disabled={!!disabled || submitting} onClick={run} title={disabled ?? `Generar (${modKey}↵)`}>
            {submitting ? <span className="spinner" /> : <ArrowUp size={18} strokeWidth={2.4} />}<span>Generar {count} {count === 1 ? "foto" : "fotos"}</span><Kbd>{modKey}↵</Kbd>
          </button>
          {disabled && engineReady && <p className="composer-note">{disabled}</p>}
          <p className="small muted policy-note"><ShieldCheck size={12} /> Nunca desnudos ni imágenes sugerentes de personas reales.</p>
        </div>
      </aside>

      <div className="identity-feed">
        {runs.length === 0 && (
          <div className="photo-empty">
            {kind === "session" ? <Camera size={26} strokeWidth={1.5} /> : <PersonStanding size={26} strokeWidth={1.5} />}
            <strong>{kind === "session" ? "Las fotos aparecerán aquí" : "La persona en su nueva pose aparecerá aquí"}</strong>
            <span className="muted small">Cada foto muestra cuánto se parece a la persona. Necesita los modelos del paquete Photo Studio (en Modelos).</span>
          </div>
        )}
        {runs.map((job) => (
          <RunCard key={job.id} job={job} assets={byJob.get(job.id) ?? []} onOpen={(a) => setViewer(viewerAssets.findIndex((x) => x.id === a.id))}
            onReusePrompt={(j) => setPrompt(j.prompt)} onVariations={() => run()} />
        ))}
      </div>
      {viewer !== null && viewerAssets.length > 0 && <Viewer assets={viewerAssets} index={viewer} onIndex={setViewer} onClose={() => setViewer(null)} />}
    </div>
  );
}
