import { useState } from "react";
import { Check, ChevronsUpDown, FolderPlus } from "lucide-react";
import { api, fileUrl, type Project } from "../lib/api";
import { errorText } from "../lib/hooks";
import { Popover } from "./ui";

export default function ProjectSwitcher({ projects, projectId, onSelect, onCreated }: { projects: Project[]; projectId: string; onSelect: (id: string) => void; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const current = projects.find((p) => p.id === projectId);

  async function create() {
    try {
      const id = await api.createProject(name);
      setName("");
      setError(null);
      onCreated();
      onSelect(id);
      setOpen(false);
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="anchor">
      <button className="switcher" onClick={() => setOpen((v) => !v)}>
        <span className="switcher-cover">{current?.cover_path ? <img src={fileUrl(current.cover_path)} alt="" /> : current?.name.slice(0, 1)}</span>
        <span className="switcher-name">{current?.name ?? "Proyecto"}</span>
        <ChevronsUpDown size={14} className="muted" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} className="menu switcher-menu">
        <span className="eyebrow">Proyectos</span>
        {projects.map((p) => (
          <button key={p.id} onClick={() => { onSelect(p.id); setOpen(false); }}>
            <span className="switcher-cover switcher-cover-s">{p.cover_path ? <img src={fileUrl(p.cover_path)} alt="" /> : p.name.slice(0, 1)}</span>
            <span className="grow">{p.name}</span>
            <span className="muted small mono">{p.asset_count}</span>
            {p.id === projectId && <Check size={14} />}
          </button>
        ))}
        <form className="switcher-new" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create(); }}>
          <FolderPlus size={15} className="muted" />
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nuevo proyecto…" />
        </form>
        {error && <p className="notice notice-error small">{error}</p>}
      </Popover>
    </div>
  );
}
