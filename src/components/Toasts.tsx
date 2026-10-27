import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { AlertTriangle, Check, X } from "lucide-react";

type Tone = "success" | "error" | "info";
interface Toast {
  id: number;
  tone: Tone;
  title: string;
  body?: string;
  image?: string;
  action?: { label: string; run: () => void };
}

const Ctx = createContext<(t: Omit<Toast, "id">) => void>(() => undefined);

export const useToast = () => useContext(Ctx);

let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = ++seq;
      setToasts((list) => [...list.slice(-3), { ...t, id }]);
      setTimeout(() => dismiss(id), t.tone === "error" ? 8000 : 5000);
    },
    [dismiss],
  );

  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.image ? (
              <img src={t.image} alt="" className="toast-image" />
            ) : (
              <span className="toast-icon">{t.tone === "error" ? <AlertTriangle size={16} /> : <Check size={16} />}</span>
            )}
            <div className="toast-text">
              <strong>{t.title}</strong>
              {t.body && <span>{t.body}</span>}
              {t.action && (
                <button className="link" onClick={() => { t.action!.run(); dismiss(t.id); }}>
                  {t.action.label}
                </button>
              )}
            </div>
            <button className="icon-btn icon-btn-s" onClick={() => dismiss(t.id)} aria-label="Cerrar">
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
