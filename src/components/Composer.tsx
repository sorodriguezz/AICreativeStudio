import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Ban, Layers, Palette, SlidersHorizontal, Square } from "lucide-react";
import type { Analysis, ModelInfo, Preset } from "../lib/api";
import { modKey } from "../lib/format";
import { ASPECTS, DOMAIN_LABEL, TASK_LABEL, label } from "../lib/labels";
import { AspectGlyph, Kbd, Popover, Segmented } from "./ui";

export interface Draft {
  prompt: string;
  negative: string;
  presetId: string;
  aspect: string; // "auto" o "16:9"…
  count: number;
  seed: string;
  steps: string;
  modelId: string;
  transparent: boolean;
}

export const emptyDraft = (presetId = "", transparent = false): Draft => ({ prompt: "", negative: "", presetId, aspect: "auto", count: 2, seed: "", steps: "", modelId: "", transparent });

interface Props {
  draft: Draft;
  onChange: (patch: Partial<Draft>) => void;
  presets: Preset[];
  models: ModelInfo[];
  analysis: Analysis | null;
  placeholder: string;
  disabledReason: string | null;
  submitting: boolean;
  onSubmit: () => void;
  /** Muestra el interruptor de fondo transparente (Brand Studio). */
  showTransparent?: boolean;
}

type Panel = "style" | "aspect" | "advanced" | null;

export default function Composer({ draft, onChange, presets, models, analysis, placeholder, disabledReason, submitting, onSubmit, showTransparent }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const toggle = (p: Panel) => setPanel((cur) => (cur === p ? null : p));
  const close = () => setPanel(null);

  // Autoajuste de altura del prompt.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
    el.style.overflowY = el.scrollHeight > 220 ? "auto" : "hidden";
  }, [draft.prompt]);

  // "/" enfoca el prompt desde cualquier parte de la pantalla.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (draft.prompt === "") return;
    ref.current?.focus();
  }, [draft.seed, draft.prompt === ""]); // al reusar un prompt o seed desde la galería

  const preset = presets.find((p) => p.id === draft.presetId);
  const effectiveAspect = draft.aspect !== "auto" ? draft.aspect : preset?.settings.aspect ?? analysis?.intent.aspect ?? null;
  const blocked = analysis && !analysis.policy.allowed;
  const canSubmit = !disabledReason && !blocked && draft.prompt.trim().length > 0 && !submitting;
  const advancedCount = [draft.negative, draft.seed, draft.steps, draft.modelId].filter(Boolean).length;

  return (
    <div className="composer-wrap">
      <div className={`composer ${blocked ? "composer-blocked" : ""}`}>
        {blocked ? (
          <div className="composer-block"><Ban size={13} /> {analysis!.policy.reason}</div>
        ) : (
          analysis && draft.prompt.trim().length >= 3 && <IntentLine analysis={analysis} />
        )}

        <textarea
          ref={ref}
          rows={1}
          value={draft.prompt}
          placeholder={placeholder}
          onChange={(e) => onChange({ prompt: e.target.value })}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              if (canSubmit) onSubmit();
            }
          }}
          aria-label="Prompt"
        />

        <div className="composer-bar">
          <div className="composer-tools">
            <div className="anchor">
              <button className={`tool ${panel === "style" ? "on" : ""}`} onClick={() => toggle("style")}>
                <Palette size={15} /> {preset?.name ?? "Estilo"}
              </button>
              <Popover open={panel === "style"} onClose={close} className="popover-up">
                <span className="eyebrow">Estilo</span>
                <div className="preset-grid">
                  {presets.map((p) => (
                    <button key={p.id} className={`preset ${p.id === draft.presetId ? "on" : ""}`} onClick={() => { onChange({ presetId: p.id }); close(); }}>
                      {p.name}
                      {p.settings.aspect && <span className="mono muted">{p.settings.aspect}</span>}
                    </button>
                  ))}
                </div>
              </Popover>
            </div>

            <div className="anchor">
              <button className={`tool ${panel === "aspect" ? "on" : ""}`} onClick={() => toggle("aspect")}>
                {effectiveAspect ? <AspectGlyph aspect={effectiveAspect} size={15} /> : <Square size={15} />}
                {draft.aspect === "auto" ? `Auto${effectiveAspect ? ` · ${effectiveAspect}` : ""}` : draft.aspect}
              </button>
              <Popover open={panel === "aspect"} onClose={close} className="popover-up">
                <span className="eyebrow">Formato</span>
                <div className="aspect-grid">
                  <button className={`aspect ${draft.aspect === "auto" ? "on" : ""}`} onClick={() => { onChange({ aspect: "auto" }); close(); }}>
                    <span className="aspect-auto">A</span>Auto
                  </button>
                  {ASPECTS.map((a) => (
                    <button key={a} className={`aspect ${draft.aspect === a ? "on" : ""}`} onClick={() => { onChange({ aspect: a }); close(); }}>
                      <AspectGlyph aspect={a} size={26} />
                      {a}
                    </button>
                  ))}
                </div>
              </Popover>
            </div>

            {showTransparent && (
              <button className={`tool ${draft.transparent ? "on tool-accent" : ""}`} onClick={() => onChange({ transparent: !draft.transparent })} title="Recorta el resultado y lo entrega en PNG transparente">
                <span className={`switch ${draft.transparent ? "on" : ""}`} /> Fondo transparente
              </button>
            )}

            <div className="tool tool-static" title="Variaciones por generación">
              <Layers size={15} />
              <Segmented size="s" value={draft.count} onChange={(count) => onChange({ count })} options={[1, 2, 3, 4].map((n) => ({ value: n, label: n }))} />
            </div>

            <div className="anchor">
              <button className={`tool ${panel === "advanced" ? "on" : ""}`} onClick={() => toggle("advanced")} title="Opciones avanzadas">
                <SlidersHorizontal size={15} />
                {advancedCount > 0 && <span className="tool-badge">{advancedCount}</span>}
              </button>
              <Popover open={panel === "advanced"} onClose={close} className="popover-up popover-wide">
                <span className="eyebrow">Opciones avanzadas</span>
                <label className="field">
                  <span>Evitar en la imagen (prompt negativo)</span>
                  <input value={draft.negative} onChange={(e) => onChange({ negative: e.target.value })} placeholder="texto, marca de agua, borroso" />
                </label>
                <label className="field">
                  <span>Modelo</span>
                  <select value={draft.modelId} onChange={(e) => onChange({ modelId: e.target.value })}>
                    <option value="">Automático según tu equipo</option>
                    {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </label>
                <div className="grid-2">
                  <label className="field">
                    <span>Seed</span>
                    <input className="mono" value={draft.seed} inputMode="numeric" placeholder="aleatoria" onChange={(e) => onChange({ seed: e.target.value.replace(/\D/g, "") })} />
                  </label>
                  <label className="field">
                    <span>Pasos</span>
                    <input className="mono" value={draft.steps} inputMode="numeric" placeholder="auto" onChange={(e) => onChange({ steps: e.target.value.replace(/\D/g, "") })} />
                  </label>
                </div>
                {advancedCount > 0 && (
                  <button className="link small" onClick={() => onChange({ negative: "", seed: "", steps: "", modelId: "" })}>Restablecer</button>
                )}
              </Popover>
            </div>
          </div>

          <button className="generate" disabled={!canSubmit} onClick={onSubmit} title={disabledReason ?? `Generar (${modKey}↵)`}>
            {submitting ? <span className="spinner" /> : <ArrowUp size={18} strokeWidth={2.4} />}
            <span>Generar</span>
            <Kbd>{modKey}↵</Kbd>
          </button>
        </div>
      </div>
    </div>
  );
}

function IntentLine({ analysis }: { analysis: Analysis }) {
  const { intent, policy, plan } = analysis;
  if (!policy.allowed) return null;
  return (
    <div className="intent-line" title="Lo que la app entendió de tu prompt">
      <span className="intent-domain">{label(DOMAIN_LABEL, intent.domain)}</span>
      {plan?.steps.map((s) => (
        <span key={s.op} className={s.available ? "" : "off"} title={s.note ?? ""}>
          {label(TASK_LABEL, s.op)}{!s.available && s.optional ? " · pronto" : ""}
        </span>
      ))}
      {intent.style_hints.slice(0, 2).map((h) => <span key={h}>{h}</span>)}
      {policy.rating === "sensitive" && <span className="warn">contenido sensible</span>}
    </div>
  );
}
