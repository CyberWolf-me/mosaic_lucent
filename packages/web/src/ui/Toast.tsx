import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

/**
 * Minimal ephemeral toast system. Gives immediate feedback for actions that do
 * not (yet) have a dedicated screen — Attach, Comment, Compare — so buttons feel
 * responsive instead of dead. Not a substitute for a real feature; it is honest
 * about what is a stub.
 */

export type ToastTone = "info" | "success" | "error";

export interface Toast {
  id: number;
  text: string;
  icon?: ReactNode;
  tone?: ToastTone;
}

interface ToastApi {
  notify: (text: string, icon?: ReactNode, tone?: ToastTone) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [leavingIds, setLeavingIds] = useState<Set<number>>(new Set());

  const notify = useCallback((text: string, icon?: ReactNode, tone?: ToastTone) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, icon, tone }]);
    // Trigger symmetric exit animation 220ms before unmount (skill §7)
    setTimeout(() => {
      setLeavingIds((prev) => new Set(prev).add(id));
    }, 2380);
    setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
      setLeavingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 2600);
  }, []);

  return (
    <Ctx.Provider value={{ notify }}>
      {children}
      <div className="toast-host">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast${leavingIds.has(t.id) ? " leaving" : ""}`}
            role={t.tone === "error" ? "alert" : "status"}
            aria-live={t.tone === "error" ? "assertive" : "polite"}
          >
            {t.icon}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(Ctx);
  // Fail soft: if used outside a provider, no-op instead of crashing the UI.
  return ctx ?? { notify: () => {} };
}
