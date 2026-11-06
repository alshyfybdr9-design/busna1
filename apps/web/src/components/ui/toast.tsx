"use client";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { CheckCircle2, AlertTriangle, Info, XCircle } from "lucide-react";
import { cn } from "./cn";

type Kind = "success" | "error" | "info" | "warning";
interface Toast { id: number; kind: Kind; title: string; body?: string }

const Ctx = createContext<(kind: Kind, title: string, body?: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Kind, title: string, body?: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, title, body }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 4000);
  }, []);

  const icon = { success: CheckCircle2, error: XCircle, info: Info, warning: AlertTriangle };
  const color = { success: "text-brand-600", error: "text-red-600", info: "text-sky-600", warning: "text-amber-500" };

  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[100] flex flex-col items-center gap-2 px-4" aria-live="polite">
        {toasts.map((t) => {
          const Icon = icon[t.kind];
          return (
            <div key={t.id} role={t.kind === "error" ? "alert" : "status"}
              className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border border-line bg-white px-4 py-3 shadow-pop animate-[toast-in_.2s_ease-out]">
              <Icon className={cn("mt-0.5 size-5 shrink-0", color[t.kind])} aria-hidden />
              <div className="min-w-0">
                <p className="text-sm font-semibold">{t.title}</p>
                {t.body && <p className="mt-0.5 text-sm text-ink-muted">{t.body}</p>}
              </div>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const push = useContext(Ctx);
  return {
    success: (title: string, body?: string) => push("success", title, body),
    error: (title: string, body?: string) => push("error", title, body),
    info: (title: string, body?: string) => push("info", title, body),
    warning: (title: string, body?: string) => push("warning", title, body),
  };
}
