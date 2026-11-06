"use client";
import { useEffect, useState } from "react";
import { Lock, Navigation } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { toAppError } from "@/lib/errors";
import { fmtAgo } from "@/lib/format";
import type { ParentTracking } from "@/lib/types";
import { BusMap } from "@/components/map/bus-map";
import { lockedReason } from "./status";

/**
 * Live bus map for ONE child. The server decides eligibility
 * (parent_tracking + RLS on bus_live_positions); this component only renders
 * what it is given and never shows a position when trackable=false.
 */
export function ParentLiveMap({ studentId, childName, onLockChange }: {
  studentId: string; childName: string; onLockChange?: (locked: boolean) => void;
}) {
  const sb = supabaseBrowser();
  const [data, setData] = useState<ParentTracking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    let alive = true;
    async function load() {
      const { data, error } = await sb.rpc("parent_tracking", { p_student: studentId });
      if (!alive) return;
      if (error) { setError(toAppError(error).message); return; }
      setError(null);
      setData(data as ParentTracking);
      onLockChange?.(!(data as ParentTracking).trackable);
    }
    void load();
    const poll = setInterval(load, 15_000);
    const clock = setInterval(() => tick((x) => x + 1), 5_000);
    // Realtime pushes (RLS only delivers rows this parent may see).
    const ch = sb.channel(`parent-live-${studentId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "bus_live_positions" }, () => void load())
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "trip_students" }, () => void load())
      .subscribe();
    return () => { alive = false; clearInterval(poll); clearInterval(clock); void sb.removeChannel(ch); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentId]);

  if (error) return <div className="rounded-2xl border border-line bg-white p-5 text-sm text-ink-muted">{error}</div>;
  if (!data) return <div className="h-72 animate-pulse rounded-2xl bg-slate-200/70" aria-label="جارٍ تحميل الخريطة" />;

  if (!data.trackable) {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-dashed border-line bg-white p-5">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-slate-100 text-ink-soft"><Lock className="size-5" /></span>
        <div>
          <p className="font-semibold">تتبع الباص</p>
          <p className="text-sm text-ink-muted">{lockedReason[data.reason ?? ""] ?? "التتبع غير متاح الآن."}</p>
        </div>
      </div>
    );
  }

  const pos = data.position;
  const stale = pos ? Date.now() - new Date(pos.recorded_at).getTime() > 2 * 60_000 : true;
  const dest = data.destination;
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-white shadow-card">
      <BusMap className="h-72" fitKey={`${data.trip_id}-${Boolean(pos)}`}
        buses={pos ? [{ id: data.trip_id!, lat: pos.lat, lng: pos.lng, heading: pos.heading, label: `باص ${childName}`, tone: stale ? "gray" : "brand", stale }] : []}
        points={dest?.lat != null && dest?.lng != null ? [{ id: "dest", lat: dest.lat, lng: dest.lng, label: dest.label, kind: data.period === "morning" ? "school" : "home" }] : []}
        path={data.path} />
      <div className="grid grid-cols-3 divide-x divide-x-reverse divide-line border-t border-line text-center">
        <div className="p-3">
          <p className="text-xs text-ink-muted">الوصول المتوقع</p>
          <p className="font-semibold">{data.eta_minutes != null ? `~${data.eta_minutes} د` : "—"}</p>
        </div>
        <div className="p-3">
          <p className="text-xs text-ink-muted">المسافة</p>
          <p className="font-semibold">{data.distance_m != null ? (data.distance_m >= 1000 ? `${(data.distance_m / 1000).toFixed(1)} كم` : `${data.distance_m} م`) : "—"}</p>
        </div>
        <div className="p-3">
          <p className="text-xs text-ink-muted">آخر تحديث</p>
          <p className={stale ? "font-semibold text-amber-600" : "font-semibold"}>{pos ? fmtAgo(pos.recorded_at) : "—"}</p>
        </div>
      </div>
      <p className="flex items-center gap-1.5 border-t border-line px-4 py-2 text-xs text-ink-soft">
        <Navigation className="size-3.5" />
        {stale ? "انقطع تحديث الموقع مؤقتًا، يُعرض آخر موقع معروف." : `متجه إلى ${dest?.label ?? ""}. الوقت تقديري حسب المسافة والسرعة.`}
      </p>
    </div>
  );
}
