import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

/**
 * Minimal ephemeral toast system. Gives immediate feedback for actions that do
 * not (yet) have a dedicated screen — Attach, Comment, Compare — so buttons feel
 * responsive instead of dead. Not a substitute for a real feature; it is honest
 * about what is a stub.
 */

export interface Toast {
  id: number;
  text: string;
  icon?: ReactNode;
}

interface ToastApi {
  notify: (text: string, icon?: ReactNode) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const notify = useCallback((text: string, icon?: ReactNode) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, icon }]);
    setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 2600);
  }, []);

  return (
    <Ctx.Provider value={{ notify }}>
      {children}
      <div className="toast-host">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
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
