import { useCallback, useEffect, useState } from "react";
import { Check, CheckSquare, ImagePlus, Pencil, Plus, Trash2 } from "lucide-react";
import { api, fileUrl, type Asset, type Project } from "../lib/api";
import { variationsOf } from "../lib/actions";
import { errorText, useAssetsDeleted, useAssetsSaved } from "../lib/hooks";
import { relativeTime } from "../lib/format";
import { Empty, PageHeader, Thumb } from "../components/ui";
import Viewer from "../components/Viewer";
import { useToast } from "../components/Toasts";
import { Modal, useAssetActions } from "../components/AssetActions";

interface Props {
  projects: Project[];
  projectId: string;
  onSelect: (id: string) => void;
  onProjectsChanged: () => void;
  onCreate: () => void;
  onReuse: (prompt: string, seed?: number, mode?: "create" | "brand") => void;
  onOpenIn: (page: "edit" | "enhance", asset: Asset) => void;
}

export default function Library({ projects, projectId, onSelect, onProjectsChanged, onCreate, onReuse, onOpenIn }: Props) {
  const toast = useToast();
  const actions = useAssetActions();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selection, setSelection] = useState<Set<string> | null>(null);
  const [viewer, setViewer] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const current = projects.find((p) => p.id === projectId);

  useEffect(() => {
    api.assets({ projectId, limit: 500 }).then(setAssets);
  }, [projectId, projects]);
  useEffect(() => setSelection(null), [projectId]);

  useAssetsDeleted(useCallback((ids: string[]) => {
    setAssets((list) => list.filter((a) => !ids.includes(a.id)));
    onProjectsChanged(); // contadores y portada
  }, [onProjectsChanged]));

  useAssetsSaved(useCallback(() => { api.assets({ projectId, limit: 500 }).then(setAssets); }, [projectId]));

  const toggle = (id: string) => setSelection((s) => {
    const next = new Set(s);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  async function setCover(a: Asset) {
    try {
      await api.setProjectCover(projectId, a.id);
      onProjectsChanged();
      toast({ tone: "success", title: "Portada actualizada", image: fileUrl(a.path) });
    } catch (e) {
      toast({ tone: "error", title: "No se pudo cambiar la portada", body: errorText(e) });
    }
  }

  const removeSelected = () => actions?.remove(assets.filter((a) => selection?.has(a.id)), () => setSelection(null));

  async function create() {
    try {
      const id = await api.createProject(newName);
      setNewName("");
      setCreating(false);
      onProjectsChanged();
      onSelect(id);
    } catch (e) {
      toast({ tone: "error", title: "No se pudo crear el proyecto", body: errorText(e) });
    }
  }

  async function rename() {
    if (!current || renaming === null) return;
    if (renaming.trim() && renaming.trim() !== current.name) {
      await api.renameProject(current.id, renaming);
      onProjectsChanged();
    }
    setRenaming(null);
  }

  async function variations(a: Asset) {
    try {
      const job = await variationsOf(a);
      toast({ tone: "info", title: "Generando variaciones", body: job.prompt });
    } catch (e) {
      toast({ tone: "error", title: "No se pudo generar", body: errorText(e) });
    }
  }

  const modeOf = (a: Asset): "create" | "brand" => (/logo|ícono|icono|marca|portada/i.test(a.metadata.prompt ?? "") ? "brand" : "create");

  return (
    <div className="page">
      <PageHeader eyebrow="Biblioteca" title="Tus proyectos" subtitle="Todo vive en este equipo. Nada se sube a la nube." />

      <div className="projects">
        {projects.map((p) => (
          <button key={p.id} className={`project ${p.id === projectId ? "on" : ""}`} onClick={() => onSelect(p.id)}>
            <div className="project-cover">{p.cover_path ? <img src={fileUrl(p.cover_path)} alt="" /> : <span className="display">{p.name.slice(0, 1)}</span>}</div>
            <div className="project-info">
              <strong>{p.name}</strong>
              <span className="muted small">{p.asset_count} {p.asset_count === 1 ? "imagen" : "imágenes"} · {relativeTime(p.updated_at)}</span>
            </div>
          </button>
        ))}
        {creating ? (
          <form className="project project-new" onSubmit={(e) => { e.preventDefault(); if (newName.trim()) create(); }}>
            <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Nombre del proyecto" onBlur={() => !newName && setCreating(false)} />
            <button className="btn btn-primary btn-s" disabled={!newName.trim()}>Crear</button>
          </form>
        ) : (
          <button className="project project-add" onClick={() => setCreating(true)}>
            <Plus size={20} />
            <span>Nuevo proyecto</span>
          </button>
        )}
      </div>

      <div className="section-head">
        {renaming !== null ? (
          <form className="row gap-s" onSubmit={(e) => { e.preventDefault(); rename(); }}>
            <input autoFocus className="display rename" value={renaming} onChange={(e) => setRenaming(e.target.value)} onBlur={rename} />
            <button className="icon-btn"><Check size={16} /></button>
          </form>
        ) : (
          <h2 className="display">
            {current?.name}
            {current && <button className="icon-btn" title="Renombrar" onClick={() => setRenaming(current.name)}><Pencil size={14} /></button>}
            {current && projects.length > 1 && <button className="icon-btn icon-btn-danger" title="Borrar proyecto" onClick={() => setDeleting(current)}><Trash2 size={14} /></button>}
          </h2>
        )}
        <div className="row gap-s">
          <span className="muted small">{selection ? `${selection.size} de ${assets.length} seleccionadas` : `${assets.length} imágenes`}</span>
          {assets.length > 0 && actions && (selection ? (
            <>
              <button className="btn btn-ghost btn-s" onClick={() => setSelection(selection.size === assets.length ? new Set() : new Set(assets.map((a) => a.id)))}>
                {selection.size === assets.length ? "Ninguna" : "Todas"}
              </button>
              <button className="btn btn-ghost btn-s" onClick={() => setSelection(null)}>Listo</button>
            </>
          ) : (
            <button className="btn btn-ghost btn-s" onClick={() => setSelection(new Set())}><CheckSquare size={14} /> Seleccionar</button>
          ))}
        </div>
      </div>

      {assets.length ? (
        <div className="masonry">
          {assets.map((a, i) => (
            <Thumb key={a.id} asset={a} badge={current?.cover_asset_id === a.id ? "Portada" : undefined}
              selected={selection ? selection.has(a.id) : undefined}
              onOpen={() => (selection ? toggle(a.id) : setViewer(i))}
              onDelete={actions ? () => actions.remove([a]) : undefined} />
          ))}
        </div>
      ) : (
        <Empty icon={<ImagePlus size={22} />} title="Este proyecto todavía está vacío">
          <button className="link" onClick={onCreate}>Crear la primera imagen</button>
        </Empty>
      )}

      {selection && selection.size > 0 && (
        <div className="selection-bar">
          <span className="small"><strong>{selection.size}</strong> {selection.size === 1 ? "imagen" : "imágenes"}</span>
          <button className="btn btn-danger btn-s" onClick={removeSelected}><Trash2 size={14} /> Eliminar</button>
        </div>
      )}

      {deleting && (
        <DeleteProjectDialog
          project={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            onSelect(projects.find((p) => p.id !== deleting.id)!.id);
            onProjectsChanged();
          }}
        />
      )}

      {viewer !== null && assets.length > 0 && (
        <Viewer
          assets={assets}
          index={viewer}
          onIndex={setViewer}
          onClose={() => setViewer(null)}
          onVariations={variations}
          onReusePrompt={(a) => onReuse(a.metadata.prompt ?? "", undefined, modeOf(a))}
          onReuseSeed={(a) => onReuse(a.metadata.prompt ?? "", a.metadata.seed ?? undefined, modeOf(a))}
          onEdit={(a) => onOpenIn("edit", a)}
          onEnhance={(a) => onOpenIn("enhance", a)}
          onSetCover={setCover}
          coverId={current?.cover_asset_id}
        />
      )}
    </div>
  );
}

function DeleteProjectDialog({ project, onClose, onDeleted }: { project: Project; onClose: () => void; onDeleted: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      await api.deleteProject(project.id);
      toast({ tone: "success", title: "Proyecto borrado", body: project.name });
      onDeleted();
    } catch (e) {
      toast({ tone: "error", title: "No se pudo borrar el proyecto", body: errorText(e) });
      setBusy(false);
    }
  }

  return (
    <Modal title="Borrar proyecto" onClose={onClose}>
      <div className="modal-body stack gap-s">
        <p><strong>{project.name}</strong></p>
        <p>
          {project.asset_count > 0
            ? `Se borrarán ${project.asset_count === 1 ? "su imagen" : `sus ${project.asset_count} imágenes`}, sus sesiones, su historial y sus kits de marca.`
            : "Se borrarán sus sesiones, su historial y sus kits de marca."}{" "}
          No se puede deshacer.
        </p>
        <p className="muted small">Exporta antes lo que quieras conservar.</p>
      </div>
      <footer className="modal-foot">
        <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <span className="grow" />
        <button className="btn btn-danger" disabled={busy} onClick={run} autoFocus>{busy ? <span className="spinner" /> : <Trash2 size={15} />} Borrar proyecto</button>
      </footer>
    </Modal>
  );
}
