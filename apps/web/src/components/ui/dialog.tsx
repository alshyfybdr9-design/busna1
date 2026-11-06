"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "./button";
import { cn } from "./cn";

export function Dialog({ open, onClose, title, description, children, footer, size = "md" }: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      className={cn(
        "backdrop:bg-slate-900/40 backdrop:backdrop-blur-[2px] rounded-2xl p-0 shadow-pop w-[calc(100%-2rem)] text-ink",
        size === "sm" ? "max-w-sm" : size === "lg" ? "max-w-2xl" : "max-w-lg",
      )}
      aria-labelledby="dialog-title"
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div>
              <h2 id="dialog-title" className="text-base font-semibold">{title}</h2>
              {description && <div className="mt-1 text-sm text-ink-muted">{description}</div>}
            </div>
            <button onClick={onClose} className="rounded-lg p-1 text-ink-soft hover:bg-slate-100" aria-label="إغلاق">
              <X className="size-5" />
            </button>
          </div>
          {children && <div className="overflow-y-auto px-5 py-4">{children}</div>}
          {footer && <div className="flex flex-wrap justify-start gap-2 border-t border-line bg-surface px-5 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, description, confirmLabel = "تأكيد", tone = "primary", loading, children }: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  tone?: "primary" | "danger" | "warning";
  loading?: boolean;
  children?: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant={tone} onClick={onConfirm} loading={loading}>{confirmLabel}</Button>
          <Button variant="secondary" onClick={onClose} disabled={loading}>إلغاء</Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
