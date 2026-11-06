"use client";
import { createContext, useContext } from "react";
import type { MemberRole, School } from "@/lib/types";

interface Ctx { school: School; role: MemberRole; canEdit: boolean }
const SchoolCtx = createContext<Ctx | null>(null);

export function SchoolProvider({ school, role, children }: { school: School; role: MemberRole; children: React.ReactNode }) {
  return <SchoolCtx.Provider value={{ school, role, canEdit: role !== "viewer" }}>{children}</SchoolCtx.Provider>;
}

export function useSchool(): Ctx {
  const v = useContext(SchoolCtx);
  if (!v) throw new Error("useSchool outside SchoolProvider");
  return v;
}
