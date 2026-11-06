import type { ReactNode } from "react";
import type { Tone } from "@/lib/format";
import { cn } from "./cn";

const tones: Record<Tone, string> = {
  neutral: "bg-slate-100 text-slate-700",
  brand: "bg-brand-50 text-brand-800 ring-1 ring-inset ring-brand-200",
  blue: "bg-sky-50 text-sky-800 ring-1 ring-inset ring-sky-200",
  amber: "bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200",
  red: "bg-red-50 text-red-700 ring-1 ring-inset ring-red-200",
  gray: "bg-slate-100 text-slate-500",
};

export function Badge({ tone = "neutral", children, className, dot }: {
  tone?: Tone; children: ReactNode; className?: string; dot?: boolean;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap", tones[tone], className)}>
      {dot && <span className={cn("size-1.5 rounded-full", tone === "brand" ? "bg-brand-500 animate-pulse" : "bg-current opacity-60")} />}
      {children}
    </span>
  );
}
