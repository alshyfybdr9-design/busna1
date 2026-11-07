"use client";
import { supabaseBrowser } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/use-query";
import type { Bus, Institution, Staff } from "@/lib/types";

/** Buses, staff and institutions of the current tenant, for selects and labels. */
export function useLookups(schoolId: string) {
  const sb = supabaseBrowser();
  const q = useQuery(async () => {
    const [buses, staff, institutions] = await Promise.all([
      sb.from("buses").select("*").eq("school_id", schoolId).order("code"),
      sb.from("staff").select("*").eq("school_id", schoolId).order("full_name"),
      sb.from("institutions").select("*").eq("school_id", schoolId).order("created_at"),
    ]);
    const b = must(buses) as Bus[];
    const s = must(staff) as Staff[];
    const inst = must(institutions) as Institution[];
    return {
      buses: b,
      staff: s,
      drivers: s.filter((x) => x.role === "driver"),
      supervisors: s.filter((x) => x.role === "supervisor"),
      busById: new Map(b.map((x) => [x.id, x])),
      institutions: inst,
      institutionById: new Map(inst.map((x) => [x.id, x])),
      /** Show institution pickers/labels only when the tenant serves more than one. */
      multiInstitution: inst.length > 1,
      staffById: new Map(s.map((x) => [x.id, x])),
    };
  }, [schoolId]);
  return q;
}
