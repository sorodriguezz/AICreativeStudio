import { PageHeader } from "../components/ui";

export interface ModuleInfo {
  title: string;
  subtitle: string;
  phase: string;
  features: string[];
}

export default function ComingSoon({ module }: { module: ModuleInfo }) {
  return (
    <div className="page narrow">
      <PageHeader eyebrow={module.phase} title={module.title} subtitle={module.subtitle} />
      <section className="soon-card">
        <span className="eyebrow">En camino</span>
        <ol className="soon-list">
          {module.features.map((f, i) => (
            <li key={f} style={{ animationDelay: `${60 * i}ms` }}>
              <span className="mono muted">{String(i + 1).padStart(2, "0")}</span>
              {f}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
