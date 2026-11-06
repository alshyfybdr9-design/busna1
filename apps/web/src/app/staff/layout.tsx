import type { Metadata } from "next";

export const metadata: Metadata = { title: "تطبيق السائق والمشرف" };

export default function StaffLayout({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto min-h-dvh max-w-lg bg-surface">{children}</div>;
}
