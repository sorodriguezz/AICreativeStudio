import { UserRound } from "lucide-react";
import { fileUrl, type Person } from "../../lib/api";

/** Selector de persona que explica por qué una persona todavía no se puede usar. */
export default function PersonPicker({ people, value, onChange, onManage }: { people: Person[]; value: string | null; onChange: (id: string) => void; onManage: () => void }) {
  const reason = (p: Person) => (!p.is_adult ? "Falta confirmar que es mayor de edad" : p.reference_count === 0 ? "Sin fotos de referencia" : null);

  if (people.length === 0) {
    return (
      <div className="notice">
        Registra primero a la persona con sus fotos de referencia. <button className="link" onClick={onManage}>Ir a Personas</button>
      </div>
    );
  }
  return (
    <div className="person-picker">
      {people.map((p) => {
        const why = reason(p);
        return (
          <button key={p.id} className={`person-chip ${value === p.id ? "on" : ""}`} disabled={!!why} onClick={() => onChange(p.id)} title={why ?? undefined}>
            <span className="person-avatar person-avatar-s">{p.cover_path ? <img src={fileUrl(p.cover_path)} alt="" /> : <UserRound size={14} />}</span>
            <span className="stack">
              <strong>{p.name}</strong>
              <span className="small muted">{why ?? `${p.reference_count} referencias`}</span>
            </span>
          </button>
        );
      })}
      <button className="link small" onClick={onManage}>Gestionar personas</button>
    </div>
  );
}
