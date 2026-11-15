import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-muted ${className}`} />;
}

function useEsc(open: boolean, onClose: () => void) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && ref.current();
    window.addEventListener("keydown", h);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", h); document.body.style.overflow = prev; };
  }, [open]);
}

export function Modal({ open, onClose, title, description, children }: { open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode }) {
  useEsc(open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="fade-in absolute inset-0 bg-background/75 backdrop-blur-sm" onClick={onClose} />
      <div className="rise relative max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-lg border border-popover-border bg-popover p-5 shadow-2xl">
        <button type="button" onClick={onClose} aria-label="Close" data-testid="button-close-modal" className="absolute right-3 top-3 text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

export function Drawer({ open, onClose, label, children }: { open: boolean; onClose: () => void; label: string; children: ReactNode }) {
  useEsc(open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={label}>
      <div className="fade-in absolute inset-0 bg-background/70 backdrop-blur-sm" onClick={onClose} />
      <aside className="slide-in absolute inset-y-0 right-0 w-full overflow-y-auto border-l border-popover-border bg-popover p-5 sm:max-w-md">
        <button type="button" onClick={onClose} aria-label="Close" data-testid="button-close-drawer" className="absolute right-3 top-3 text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
        {children}
      </aside>
    </div>
  );
}

interface Toast { id: number; title: string; description?: string; variant?: "destructive" }
const ToastCtx = createContext<(t: Omit<Toast, "id">) => void>(() => {});
export const useToast = () => ({ toast: useContext(ToastCtx) });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);
  const toast = useCallback((t: Omit<Toast, "id">) => {
    const id = ++seq.current;
    setItems((p) => [...p.slice(-2), { ...t, id }]);
    window.setTimeout(() => setItems((p) => p.filter((x) => x.id !== id)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} data-testid={`toast-${t.id}`} className={`rise pointer-events-auto rounded-md border bg-popover px-3.5 py-2.5 shadow-xl ${t.variant === "destructive" ? "border-destructive/60" : "border-primary/35"}`}>
            <div className="text-sm font-semibold">{t.title}</div>
            {t.description && <div className="mt-0.5 text-xs text-muted-foreground">{t.description}</div>}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
