import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";

/** Lightweight, accessible table that scrolls horizontally on phones. */
export function Table({ head, children, className }: { head: ReactNode[]; children: ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-x-auto rounded-2xl border border-line bg-white shadow-card", className)}>
      <table className="w-full min-w-[640px] text-sm">
        <thead className="border-b border-line bg-surface text-xs text-ink-muted">
          <tr>{head.map((h, i) => <th key={i} scope="col" className="px-4 py-3 text-start font-medium">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cn("px-4 py-3 align-middle", className)}>{children}</td>;
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="mb-3 flex flex-wrap items-center gap-2">{children}</div>;
}
