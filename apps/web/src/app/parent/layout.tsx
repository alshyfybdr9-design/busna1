import type { Metadata } from "next";

export const metadata: Metadata = { title: "ولي الأمر" };

export default function ParentLayout({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto min-h-dvh max-w-lg bg-surface">{children}</div>;
}
