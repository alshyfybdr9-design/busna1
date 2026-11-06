import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { AlertTriangle } from "lucide-react";
import { Button } from "./button";
import { cn } from "./cn";

export function EmptyState({ icon: Icon, title, body, action, className }: {
  icon: LucideIcon; title: string; body?: ReactNode; action?: ReactNode; className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-12 text-center", className)}>
      <div className="mb-3 grid size-12 place-items-center rounded-2xl bg-brand-50 text-brand-700">
        <Icon className="size-6" aria-hidden />
      </div>
      <p className="font-semibold">{title}</p>
      {body && <p className="mt-1 max-w-sm text-sm text-ink-muted">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center px-6 py-12 text-center">
      <div className="mb-3 grid size-12 place-items-center rounded-2xl bg-red-50 text-red-600">
        <AlertTriangle className="size-6" aria-hidden />
      </div>
      <p className="font-semibold">تعذّر تحميل البيانات</p>
      <p className="mt-1 max-w-sm text-sm text-ink-muted">{message}</p>
      {onRetry && <Button variant="secondary" className="mt-4" onClick={onRetry}>إعادة المحاولة</Button>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-lg bg-slate-200/70", className)} aria-hidden />;
}

export function PageLoading({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3 p-4" aria-busy="true" aria-label="جارٍ التحميل">
      <Skeleton className="h-8 w-48" />
      {Array.from({ length: rows }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
    </div>
  );
}
