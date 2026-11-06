"use client";
import { supabaseBrowser } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/use-query";
import type { Bus, Staff } from "@/lib/types";

/** Buses & staff of the current school, for selects and labels. */
export function useLookups(schoolId: string) {
  const sb = supabaseBrowser();
  const q = useQuery(async () => {
    const [buses, staff] = await Promise.all([
      sb.from("buses").select("*").eq("school_id", schoolId).order("code"),
      sb.from("staff").select("*").eq("school_id", schoolId).order("full_name"),
    ]);
    const b = must(buses) as Bus[];
    const s = must(staff) as Staff[];
    return {
      buses: b,
      staff: s,
      drivers: s.filter((x) => x.role === "driver"),
      supervisors: s.filter((x) => x.role === "supervisor"),
      busById: new Map(b.map((x) => [x.id, x])),
      staffById: new Map(s.map((x) => [x.id, x])),
    };
  }, [schoolId]);
  return q;
}
