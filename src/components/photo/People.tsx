import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, ImagePlus, Plus, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { api, fileUrl, type Person, type PersonDetail } from "../../lib/api";
import { errorText } from "../../lib/hooks";
import { relativeTime } from "../../lib/format";
import { AUDIT_LABEL, label } from "../../lib/labels";
import { Empty, Thumb } from "../ui";
import { useToast } from "../Toasts";

function AgePill({ person }: { person: Person }) {
  return person.is_adult ? null : <span className="pill pill-failed">Falta confirmar edad</span>;
}

export default function People({ focus, onChanged }: { focus: string | null; onChanged: () => void }) {
  const toast = useToast();
  const [people, setPeople] = useState<Person[]>([]);
  const [current, setCurrent] = useState<string | null>(focus);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [adult, setAdult] = useState(false);

  const load = useCallback(() => api.persons().then(setPeople), []);
  useEffect(() => { load(); }, [load]);

  async function create() {
    try {
      const id = await api.createPerson(name, null, adult);
      setCreating(false);
      setName("");
      setAdult(false);
      await load();
      onChanged();
      setCurrent(id);
    } catch (e) {
      toast({ tone: "error", title: "No se pudo registrar", body: errorText(e) });
    }
  }

  if (current) return <PersonView id={current} onBack={() => { setCurrent(null); load(); onChanged(); }} />;

  return (
    <div className="people">
      <div className="people-intro">
        <ShieldCheck size={20} />
        <p>
          Registra a la persona y agrega sus fotos de referencia para usar su identidad. Sólo personas mayores de 18 años.
          Nunca se generan desnudos ni imágenes sugerentes de personas reales.
        </p>
      </div>
      <div className="people-grid">
        {people.map((p) => (
          <button key={p.id} className="person-card" onClick={() => setCurrent(p.id)}>
            <div className="person-avatar">{p.cover_path ? <img src={fileUrl(p.cover_path)} alt="" /> : <UserRound size={28} />}</div>
            <strong>{p.name}</strong>
            <span className="muted small">{p.reference_count} referencias · {p.generated_count} imágenes</span>
            <AgePill person={p} />
          </button>
        ))}
        {creating ? (
          <form className="person-card person-new" onSubmit={(e) => { e.preventDefault(); if (name.trim() && adult) create(); }}>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre o alias" />
            <label className="row gap-xs small check"><input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} /> Es mayor de 18 años</label>
            <div className="row gap-xs">
              <button type="button" className="btn btn-ghost btn-s" onClick={() => setCreating(false)}>Cancelar</button>
              <button className="btn btn-primary btn-s" disabled={!name.trim() || !adult}>Registrar</button>
            </div>
          </form>
        ) : (
          <button className="person-card person-add" onClick={() => setCreating(true)}><Plus size={22} /> Registrar persona</button>
        )}
      </div>
      {people.length === 0 && !creating && <Empty icon={<UserRound size={22} />} title="Todavía no hay personas registradas" />}
    </div>
  );
}

function PersonView({ id, onBack }: { id: string; onBack: () => void }) {
  const toast = useToast();
  const [d, setD] = useState<PersonDetail | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => api.personDetail(id).then(setD).catch((e) => toast({ tone: "error", title: "Error", body: errorText(e) })), [id, toast]);
  useEffect(() => { load(); }, [load]);

  async function addRefs() {
    const picked = await open({ multiple: true, filters: [{ name: "Fotos", extensions: ["png", "jpg", "jpeg", "webp"] }] });
    if (!picked) return;
    setAdding(true);
    const paths = Array.isArray(picked) ? picked : [picked];
    let ok = 0;
    for (const p of paths) {
      try {
        await api.addPersonReference(id, p as string);
        ok++;
      } catch (e) {
        toast({ tone: "error", title: `No se agregó ${(p as string).split(/[\\/]/).pop()}`, body: errorText(e) });
      }
    }
    setAdding(false);
    if (ok) toast({ tone: "success", title: `${ok} referencia(s) agregada(s)` });
    load();
  }

  async function remove() {
    if (!d || !confirm(`¿Eliminar a ${d.person.name} y sus fotos de referencia? Las imágenes ya generadas se conservan.`)) return;
    await api.deletePerson(id);
    onBack();
  }

  async function confirmAdult() {
    if (!d) return;
    await api.updatePerson(id, d.person.name, d.person.notes, true);
    load();
  }

  if (!d) return <div className="page"><span className="spinner" /></div>;

  return (
    <div className="person-view">
      <header className="person-head">
        <button className="btn btn-ghost btn-s" onClick={onBack}><ArrowLeft size={14} /> Personas</button>
        <div className="row gap-m">
          <div className="person-avatar person-avatar-l">{d.references[0] ? <img src={fileUrl(d.references[0].path)} alt="" /> : <UserRound size={34} />}</div>
          <div className="stack gap-xs">
            <h1 className="display">{d.person.name}</h1>
            <span className="muted small">{d.references.length} referencias · {d.generated.length} imágenes generadas</span>
          </div>
          <span className="grow" />
          <button className="btn btn-ghost btn-s danger" onClick={remove}><Trash2 size={14} /> Eliminar</button>
        </div>
      </header>

      {!d.person.is_adult && (
        <div className="notice notice-block row between gap-s">
          <span>Para usar su identidad, confirma que {d.person.name} es mayor de 18 años.</span>
          <button className="btn btn-s" onClick={confirmAdult}><ShieldCheck size={14} /> Es mayor de 18 años</button>
        </div>
      )}

      <section className="kit-section">
        <div className="row between">
          <span className="eyebrow">Fotos de referencia · {d.references.length}</span>
          <button className="btn btn-s" onClick={addRefs} disabled={adding}>{adding ? <span className="spinner" /> : <ImagePlus size={14} />} Agregar fotos</button>
        </div>
        <p className="muted small">Entre 3 y 6 fotos nítidas, con buena luz y la cara visible desde distintos ángulos. Cada foto debe tener un solo rostro y parecerse a las demás.</p>
        <div className="refs">
          {d.references.map((r) => (
            <figure key={r.id} className="ref">
              <img src={fileUrl(r.path)} alt="" />
              <button className="icon-btn icon-btn-s" title="Quitar" onClick={async () => { await api.removePersonReference(r.id); load(); }}><Trash2 size={13} /></button>
            </figure>
          ))}
        </div>
      </section>

      {d.generated.length > 0 && (
        <section className="kit-section">
          <span className="eyebrow">Imágenes generadas con su identidad · {d.generated.length}</span>
          <div className="picker-grid">{d.generated.map((a) => <Thumb key={a.id} asset={a} onOpen={() => undefined} />)}</div>
        </section>
      )}

      <section className="kit-section">
        <span className="eyebrow">Trazabilidad</span>
        <ul className="audit">
          {d.audit.map((a, i) => (
            <li key={i}><span className="muted small">{relativeTime(a.created_at)}</span> {label(AUDIT_LABEL, a.action)}{typeof a.detail.prompt === "string" && a.detail.prompt ? <span className="muted"> · “{a.detail.prompt}”</span> : null}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
