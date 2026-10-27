import { useCallback, useEffect, useState } from "react";
import { Check, ChevronsUpDown, Pencil, Plus, Trash2 } from "lucide-react";
import { api, fileUrl, type Section, type Session } from "../lib/api";
import { errorText, useAssetsSaved, useJobUpdates } from "../lib/hooks";
import { relativeTime } from "../lib/format";
import { useSession } from "../lib/session";
import { Modal } from "./AssetActions";
import { useToast } from "./Toasts";
import { Popover } from "./ui";

/** Sesiones de trabajo de una sección: abrir otra, empezar una nueva, renombrar o borrar. */
export default function SessionSwitcher({ projectId, section }: { projectId: string; section: Section }) {
  const toast = useToast();
  const session = useSession(section);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Session[]>([]);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<Session | null>(null);

  const load = useCallback(() => api.sessions(projectId, section).then(setList).catch(() => setList([])), [projectId, section]);
  useEffect(() => { load(); }, [load, session.id]);
  useJobUpdates(useCallback(() => { load(); }, [load]));
  useAssetsSaved(useCallback(() => { load(); }, [load]));

  const current = list.find((s) => s.id === session.id);

  async function rename() {
    if (!renaming) return;
    try {
      await api.renameSession(renaming.id, renaming.name);
      setRenaming(null);
      load();
    } catch (e) {
      toast({ tone: "error", title: "No se pudo renombrar", body: errorText(e) });
    }
  }

  return (
    <div className="anchor">
      <button className="switcher session-switcher" onClick={() => setOpen((v) => !v)} title="Sesiones de trabajo">
        <span className="switcher-cover">{current?.cover_path ? <img src={fileUrl(current.cover_path)} alt="" /> : <Plus size={13} />}</span>
        <span className="switcher-name">{current?.name ?? "Nueva sesión"}</span>
        {current && current.unsaved > 0 && <span className="session-unsaved" title="Imágenes sin agregar a la biblioteca">{current.unsaved}</span>}
        <ChevronsUpDown size={14} className="muted" />
      </button>
      <Popover open={open} onClose={() => { setOpen(false); setRenaming(null); }} className="menu switcher-menu session-menu">
        <button className="session-new" onClick={() => { session.select(null); setOpen(false); }}>
          <Plus size={15} /> <span className="grow">Nueva sesión</span>
          {!session.id && <Check size={14} />}
        </button>
        {list.length > 0 && <span className="eyebrow">Sesiones</span>}
        <div className="session-list">
          {list.map((s) =>
            renaming?.id === s.id ? (
              <form key={s.id} className="session-rename" onSubmit={(e) => { e.preventDefault(); rename(); }}>
                <input autoFocus value={renaming.name} onChange={(e) => setRenaming({ id: s.id, name: e.target.value })} onKeyDown={(e) => e.key === "Escape" && setRenaming(null)} />
                <button className="icon-btn icon-btn-s" title="Guardar"><Check size={13} /></button>
              </form>
            ) : (
              <div key={s.id} className={`session-row ${s.id === session.id ? "on" : ""}`}>
                <button className="session-open" onClick={() => { session.select(s.id); setOpen(false); }}>
                  <span className="switcher-cover switcher-cover-s">{s.cover_path ? <img src={fileUrl(s.cover_path)} alt="" /> : null}</span>
                  <span className="stack grow">
                    <span className="session-name">{s.name}</span>
                    <span className="muted small">
                      {s.images} {s.images === 1 ? "imagen" : "imágenes"}{s.unsaved > 0 ? ` · ${s.unsaved} sin guardar` : ""} · {relativeTime(s.updated_at)}
                    </span>
                  </span>
                </button>
                <button className="icon-btn icon-btn-s" title="Renombrar" onClick={() => setRenaming({ id: s.id, name: s.name })}><Pencil size={12} /></button>
                <button className="icon-btn icon-btn-s icon-btn-danger" title="Borrar sesión" onClick={() => { setDeleting(s); setOpen(false); }}><Trash2 size={12} /></button>
              </div>
            ),
          )}
        </div>
      </Popover>
      {deleting && (
        <DeleteSessionDialog
          session={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            if (deleting.id === session.id) session.select(null);
            setDeleting(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function DeleteSessionDialog({ session, onClose, onDeleted }: { session: Session; onClose: () => void; onDeleted: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const kept = session.images - session.unsaved;

  async function run() {
    setBusy(true);
    try {
      await api.deleteSession(session.id);
      toast({ tone: "success", title: "Sesión borrada", body: kept > 0 ? `${kept} ${kept === 1 ? "imagen sigue" : "imágenes siguen"} en la biblioteca.` : undefined });
      onDeleted();
    } catch (e) {
      toast({ tone: "error", title: "No se pudo borrar la sesión", body: errorText(e) });
      setBusy(false);
    }
  }

  return (
    <Modal title="Borrar sesión" onClose={onClose}>
      <div className="modal-body stack gap-s">
        <p><strong>{session.name}</strong></p>
        {session.unsaved > 0 ? (
          <p>{session.unsaved === 1 ? "Se borrará la imagen que no agregaste" : `Se borrarán las ${session.unsaved} imágenes que no agregaste`} a la biblioteca. No se puede deshacer.</p>
        ) : (
          <p>No tiene imágenes sin guardar.</p>
        )}
        {kept > 0 && <p className="muted small">{kept === 1 ? "La imagen que agregaste a la biblioteca se queda allí." : `Las ${kept} imágenes que agregaste a la biblioteca se quedan allí.`}</p>}
      </div>
      <footer className="modal-foot">
        <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <span className="grow" />
        <button className="btn btn-danger" disabled={busy} onClick={run} autoFocus>{busy ? <span className="spinner" /> : <Trash2 size={15} />} Borrar sesión</button>
      </footer>
    </Modal>
  );
}
