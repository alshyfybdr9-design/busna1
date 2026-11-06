import { cn } from "./ui/cn";

export function BusnaLogo({ className, withText = true }: { className?: string; withText?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <svg viewBox="0 0 64 64" className="size-8 shrink-0" aria-hidden>
        <rect width="64" height="64" rx="14" className="fill-brand-600" />
        <rect x="14" y="14" width="36" height="30" rx="7" fill="#fff" />
        <rect x="18" y="19" width="28" height="11" rx="3" className="fill-brand-600" opacity=".25" />
        <circle cx="22" cy="47" r="4" fill="#fff" />
        <circle cx="42" cy="47" r="4" fill="#fff" />
      </svg>
      {withText && <span className="text-lg font-bold tracking-tight">باصنا</span>}
    </span>
  );
}

/** Hex "#RRGGBB" → "R G B" for the --brand-rgb CSS variable. */
export function brandVars(hex: string | null | undefined): React.CSSProperties | undefined {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return undefined;
  const n = parseInt(hex.slice(1), 16);
  return { ["--brand-rgb" as string]: `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}` } as React.CSSProperties;
}
