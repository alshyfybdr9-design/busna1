"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  AlertOctagon, AlertTriangle, Bus, CheckCircle2, Clock, Gauge, MapPinOff, MessageCircle, RefreshCw, Users, X,
} from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/use-query";
import { fmtAgo, fmtDate, fmtTime, periodLabel, todayIn, tripStatusLabel, tripTone, severityLabel, incidentCategoryLabel } from "@/lib/format";
import type { DashboardStats, Incident, LivePosition, Trip, TripPeriod, TripStop } from "@/lib/types";
import { useSchool } from "@/components/admin/school-context";
import { PageHeader } from "@/components/admin/shell";
import { BusMap, type MapBus } from "@/components/map/bus-map";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/field";
import { ErrorState, Skeleton } from "@/components/ui/states";
import { cn } from "@/components/ui/cn";

interface DashTrip extends Trip {
  bus: { code: string; plate_number: string; capacity: number } | null;
  driver: { full_name: string } | null;
  supervisor: { full_name: string } | null;
  students: { status: string }[];
}

const STALE_MS = 3 * 60_000;

export default function Dashboard() {
  const { school } = useSchool();
  const sb = supabaseBrowser();
  const today = todayIn(school.timezone);
  const late = school.settings?.late_threshold_min ?? 10;

  const q = useQuery(async () => {
    const [stats, trips, live, incidents, overCap] = await Promise.all([
      sb.rpc("school_dashboard", { p_school: school.id }),
      sb.from("trips").select("*, bus:buses(code, plate_number, capacity), driver:staff!trips_driver_id_school_id_fkey(full_name), supervisor:staff!trips_supervisor_id_school_id_fkey(full_name), students:trip_students(status)")
        .eq("school_id", school.id).eq("trip_date", today).order("scheduled_start"),
      sb.from("bus_live_positions").select("*").eq("school_id", school.id),
      sb.from("incidents").select("*").eq("school_id", school.id).neq("status", "resolved").order("created_at", { ascending: false }).limit(20),
      sb.from("bus_load").select("*").eq("school_id", school.id).eq("over_capacity", true),
    ]);
    return {
      stats: must(stats) as DashboardStats,
      trips: must(trips) as DashTrip[],
      live: must(live) as LivePosition[],
      incidents: must(incidents) as Incident[],
      overCap: must(overCap) as { bus_id: string; code: string; capacity: number; assigned_students: number }[],
    };
  }, [school.id, today]);

  // Realtime: positions stream in; other changes trigger a silent refresh.
  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => { if (pending) return; pending = setTimeout(() => { pending = null; q.reload(true); }, 800); };
    const ch = sb.channel(`dash-${school.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "bus_live_positions", filter: `school_id=eq.${school.id}` }, (p) => {
        q.setData((d) => {
          if (!d) return d;
          if (p.eventType === "DELETE") return { ...d, live: d.live.filter((l) => l.trip_id !== (p.old as LivePosition).trip_id) };
          const row = p.new as LivePosition;
          return { ...d, live: [...d.live.filter((l) => l.trip_id !== row.trip_id), row] };
        });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "trips", filter: `school_id=eq.${school.id}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "trip_students", filter: `school_id=eq.${school.id}` }, refresh)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "incidents", filter: `school_id=eq.${school.id}` }, refresh)
      .subscribe();
    const t = setInterval(() => q.reload(true), 60_000);
    return () => { void sb.removeChannel(ch); clearInterval(t); if (pending) clearTimeout(pending); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [school.id]);

  // clock for "last update" freshness
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 10_000); return () => clearInterval(t); }, []);

  const [period, setPeriod] = useState<"" | TripPeriod>("");
  const [view, setView] = useState<"active" | "all" | "delayed">("active");
  const [driver, setDriver] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const trips = q.data?.trips ?? [];
  const liveByTrip = useMemo(() => new Map((q.data?.live ?? []).map((l) => [l.trip_id, l])), [q.data?.live]);
  const isDelayed = (t: DashTrip) => t.delay_minutes > 0 || (t.status === "scheduled" && now > Date.parse(t.scheduled_start) + late * 60_000);

  const filtered = trips.filter((t) =>
    (!period || t.period === period) &&
    (!driver || t.driver_id === driver) &&
    (view === "all" || (view === "active" ? t.status === "started" || t.status === "in_progress" : isDelayed(t) && t.status !== "completed" && t.status !== "cancelled")));

  const mapBuses: MapBus[] = filtered.flatMap((t) => {
    const l = liveByTrip.get(t.id);
    if (!l) return [];
    const stale = now - Date.parse(l.recorded_at) > STALE_MS;
    return [{ id: t.id, lat: l.lat, lng: l.lng, heading: l.heading, label: t.bus?.code ?? t.name,
      tone: t.emergency_active ? "red" : stale ? "gray" : isDelayed(t) ? "amber" : "brand", stale }];
  });

  const drivers = useMemo(() => {
    const m = new Map<string, string>();
    trips.forEach((t) => t.driver_id && t.driver && m.set(t.driver_id, t.driver.full_name));
    return [...m];
  }, [trips]);

  const sel = trips.find((t) => t.id === selected) ?? null;

  if (q.error) return <ErrorState message={q.error.message} onRetry={() => q.reload()} />;
  const s = q.data?.stats;

  return (
    <div className="pb-10">
      <PageHeader title="لوحة المتابعة" subtitle={fmtDate(today, school.timezone)}
        actions={<button onClick={() => q.reload()} className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-white px-3 py-2 text-sm hover:bg-surface"><RefreshCw className={cn("size-4", q.loading && "animate-spin")} />تحديث</button>} />

      {/* KPIs */}
      <div className="grid gap-4 px-4 lg:grid-cols-2 lg:px-8">
        <KpiGroup title="الطلاب" items={s && [
          ["مسجلون في النقل", s.students_total],
          ["في الباصات الآن", s.students_on_bus, "brand"],
          ["وصلوا المدرسة", s.students_at_school],
          ["وصلوا المنازل", s.students_home],
          ["غائبون اليوم", s.students_absent],
        ]} />
        <KpiGroup title="التشغيل" items={s && [
          ["رحلات نشطة", s.trips_active, "brand"],
          ["رحلات متأخرة", s.trips_delayed, s.trips_delayed ? "amber" : undefined],
          ["باصات متاحة", s.buses_available],
          ["باصات متوقفة", s.buses_stopped, s.buses_stopped ? "amber" : undefined],
          ["سائقون / مشرفون", `${s.drivers} / ${s.supervisors}`],
        ]} />
      </div>

      <div className="mt-4 grid gap-4 px-4 lg:px-8 xl:grid-cols-[1fr_360px]">
        {/* Map */}
        <section className="overflow-hidden rounded-2xl border border-line bg-white shadow-card">
          <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
            <div className="flex rounded-xl bg-slate-100 p-1 text-sm" role="tablist" aria-label="حالة الرحلة">
              {([["active", "النشطة"], ["delayed", "المتأخرة"], ["all", "كل رحلات اليوم"]] as const).map(([k, l]) => (
                <button key={k} role="tab" aria-selected={view === k} onClick={() => setView(k)}
                  className={cn("rounded-lg px-3 py-1.5", view === k ? "bg-white font-medium shadow-card" : "text-ink-muted")}>{l}</button>
              ))}
            </div>
            <Select value={period} onChange={(e) => setPeriod(e.target.value as "" | TripPeriod)} className="h-9 w-auto" aria-label="الفترة">
              <option value="">كل الفترات</option><option value="morning">الصباحية</option><option value="afternoon">المسائية</option>
            </Select>
            <Select value={driver} onChange={(e) => setDriver(e.target.value)} className="h-9 w-auto" aria-label="السائق">
              <option value="">كل السائقين</option>
              {drivers.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
            </Select>
            <span className="ms-auto text-xs text-ink-soft">{mapBuses.length} باص على الخريطة</span>
          </div>
          <div className="relative">
            <BusMap className="h-[460px] lg:h-[560px]" buses={mapBuses} selectedId={selected} onSelect={setSelected}
              fitKey={`${view}-${period}-${driver}-${mapBuses.length}`}
              center={school.lng && school.lat ? [school.lng, school.lat] : undefined}
              points={school.lat && school.lng ? [{ id: "school", lat: school.lat, lng: school.lng, label: school.name, kind: "school" }] : []} />
            {sel && <BusCard trip={sel} live={liveByTrip.get(sel.id)} now={now} onClose={() => setSelected(null)} />}
            {q.data && mapBuses.length === 0 && (
              <div className="pointer-events-none absolute inset-x-0 top-4 mx-auto w-fit rounded-xl bg-white/95 px-4 py-2 text-sm text-ink-muted shadow-card">
                لا توجد باصات تشارك موقعها ضمن هذا التصفية
              </div>
            )}
          </div>
          {/* Trip list under map */}
          <ul className="max-h-72 divide-y divide-line overflow-y-auto border-t border-line">
            {filtered.length === 0 && <li className="p-4 text-center text-sm text-ink-muted">لا توجد رحلات</li>}
            {filtered.map((t) => {
              const onBoard = t.students.filter((x) => x.status === "boarded").length;
              const l = liveByTrip.get(t.id);
              return (
                <li key={t.id}>
                  <button onClick={() => setSelected(t.id)} className={cn("flex w-full items-center gap-3 px-4 py-2.5 text-start hover:bg-surface", selected === t.id && "bg-brand-50/60")}>
                    <Badge tone={tripTone(t.status, isDelayed(t), t.emergency_active)} dot={t.status === "in_progress"}>{tripStatusLabel[t.status]}</Badge>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{t.name}</span>
                    <span className="hidden text-xs text-ink-muted sm:inline">{t.bus?.code} · {t.driver?.full_name ?? "بدون سائق"}</span>
                    <span className="text-xs text-ink-muted"><Users className="me-1 inline size-3.5" />{onBoard}/{t.students.length}</span>
                    <span className="w-20 text-end text-xs text-ink-soft">{l ? fmtAgo(l.recorded_at, now) : fmtTime(t.scheduled_start, school.timezone)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        {/* Alerts */}
        <AlertsPanel loading={!q.data} trips={trips} incidents={q.data?.incidents ?? []} overCap={q.data?.overCap ?? []}
          liveByTrip={liveByTrip} now={now} late={late} openRequests={s?.open_requests ?? 0} onSelect={setSelected} />
      </div>
    </div>
  );
}

function KpiGroup({ title, items }: { title: string; items: false | undefined | [string, number | string, ("brand" | "amber")?][] }) {
  return (
    <section className="rounded-2xl border border-line bg-white p-4 shadow-card">
      <h2 className="mb-3 text-sm font-semibold text-ink-muted">{title}</h2>
      <dl className="grid grid-cols-3 gap-x-4 gap-y-4 sm:grid-cols-5">
        {!items ? Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12" />) : items.map(([label, value, tone]) => (
          <div key={label}>
            <dt className="text-xs text-ink-soft">{label}</dt>
            <dd className="mt-1 flex items-center gap-1.5 text-2xl font-bold tabular-nums">
              {tone && <span className={cn("size-2 rounded-full", tone === "brand" ? "bg-brand-500" : "bg-amber-500")} aria-hidden />}
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function BusCard({ trip, live, now, onClose }: { trip: DashTrip; live?: LivePosition; now: number; onClose: () => void }) {
  const { school } = useSchool();
  const sb = supabaseBrowser();
  const onBoard = trip.students.filter((x) => x.status === "boarded").length;
  const [path, setPath] = useState<[number, number][] | null>(null);
  useEffect(() => {
    let alive = true;
    sb.from("bus_locations").select("lat, lng").eq("trip_id", trip.id).order("recorded_at").limit(2000)
      .then(({ data }) => { if (alive) setPath((data ?? []).map((p) => [p.lng, p.lat])); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip.id, live?.recorded_at]);
  const stale = live ? now - Date.parse(live.recorded_at) > STALE_MS : true;
  return (
    <div className="absolute inset-x-3 bottom-3 z-10 rounded-2xl border border-line bg-white p-4 shadow-pop sm:inset-x-auto sm:end-3 sm:w-80">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-semibold">{trip.bus?.code ?? "—"} <span className="text-sm font-normal text-ink-muted">· {trip.bus?.plate_number}</span></p>
          <p className="text-sm text-ink-muted">{trip.name} · {periodLabel[trip.period]}</p>
        </div>
        <button onClick={onClose} className="rounded-lg p-1 text-ink-soft hover:bg-slate-100" aria-label="إغلاق"><X className="size-4" /></button>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
        <div><dt className="text-xs text-ink-soft">السائق</dt><dd className="font-medium">{trip.driver?.full_name ?? "—"}</dd></div>
        <div><dt className="text-xs text-ink-soft">المشرف</dt><dd className="font-medium">{trip.supervisor?.full_name ?? "—"}</dd></div>
        <div><dt className="text-xs text-ink-soft">الطلاب في الباص</dt><dd className="font-medium">{onBoard} من {trip.students.length}{trip.bus && onBoard > trip.bus.capacity && <span className="text-red-600"> (تجاوز السعة)</span>}</dd></div>
        <div><dt className="text-xs text-ink-soft">آخر تحديث للموقع</dt><dd className={cn("font-medium", stale && "text-amber-600")}>{live ? fmtAgo(live.recorded_at, now) : "لا يوجد"}</dd></div>
        <div><dt className="text-xs text-ink-soft">الحالة</dt><dd><Badge tone={tripTone(trip.status, trip.delay_minutes > 0, trip.emergency_active)}>{tripStatusLabel[trip.status]}</Badge></dd></div>
        <div><dt className="text-xs text-ink-soft">بدأت</dt><dd className="font-medium">{fmtTime(trip.started_at, school.timezone)}</dd></div>
      </dl>
      {path && path.length > 1 && <p className="mt-2 text-xs text-ink-soft">{path.length} نقطة مسار مسجلة</p>}
      <Link href={`/admin/${school.slug}/trips/${trip.id}`} className="mt-3 flex h-9 items-center justify-center rounded-xl bg-brand-600 text-sm font-medium text-white">تفاصيل الرحلة والسجل الزمني</Link>
    </div>
  );
}

function AlertsPanel({ loading, trips, incidents, overCap, liveByTrip, now, late, openRequests, onSelect }: {
  loading: boolean; trips: DashTrip[]; incidents: Incident[]; overCap: { bus_id: string; code: string; capacity: number; assigned_students: number }[];
  liveByTrip: Map<string, LivePosition>; now: number; late: number; openRequests: number; onSelect: (id: string) => void;
}) {
  const { school } = useSchool();
  type Alert = { key: string; level: "critical" | "warning" | "info"; icon: typeof AlertTriangle; title: string; body: string; tripId?: string; href?: string };
  const alerts: Alert[] = [];
  trips.filter((t) => t.emergency_active).forEach((t) => alerts.push({ key: "e" + t.id, level: "critical", icon: AlertOctagon, title: `طوارئ: ${t.name}`, body: `${t.bus?.code ?? ""} — ${t.driver?.full_name ?? ""}`, tripId: t.id }));
  incidents.filter((i) => i.severity === "critical" || i.severity === "high").forEach((i) => alerts.push({ key: "i" + i.id, level: i.severity === "critical" ? "critical" : "warning", icon: AlertTriangle, title: `بلاغ ${severityLabel[i.severity]}: ${incidentCategoryLabel[i.category]}`, body: i.description, tripId: i.trip_id ?? undefined }));
  trips.filter((t) => t.status === "scheduled" && now > Date.parse(t.scheduled_start) + late * 60_000).forEach((t) => alerts.push({ key: "l" + t.id, level: "warning", icon: Clock, title: `لم تبدأ: ${t.name}`, body: `موعدها ${fmtTime(t.scheduled_start, school.timezone)} — ${t.driver?.full_name ?? "بدون سائق"}`, tripId: t.id }));
  trips.filter((t) => t.delay_minutes > 0 && t.status !== "completed" && t.status !== "cancelled").forEach((t) => alerts.push({ key: "d" + t.id, level: "warning", icon: Clock, title: `تأخير ${t.delay_minutes} د: ${t.name}`, body: t.delay_reason ?? "", tripId: t.id }));
  trips.filter((t) => (t.status === "started" || t.status === "in_progress")).forEach((t) => {
    const l = liveByTrip.get(t.id);
    if (!l || now - Date.parse(l.recorded_at) > STALE_MS)
      alerts.push({ key: "g" + t.id, level: "warning", icon: MapPinOff, title: `انقطاع الموقع: ${t.bus?.code ?? t.name}`, body: l ? `آخر تحديث ${fmtAgo(l.recorded_at, now)}` : "لم يصل أي موقع منذ بدء الرحلة", tripId: t.id });
  });
  overCap.forEach((b) => alerts.push({ key: "c" + b.bus_id, level: "warning", icon: Gauge, title: `تجاوز سعة ${b.code}`, body: `${b.assigned_students} طالب مخصص والسعة ${b.capacity}`, href: `/admin/${school.slug}/fleet` }));
  if (openRequests > 0) alerts.push({ key: "r", level: "info", icon: MessageCircle, title: `${openRequests} طلب من أولياء الأمور`, body: "بانتظار المراجعة", href: `/admin/${school.slug}/parents?tab=requests` });

  const style = { critical: "border-red-200 bg-red-50 text-red-900", warning: "border-amber-200 bg-amber-50/60 text-amber-950", info: "border-line bg-white" };
  const label = { critical: "حرج", warning: "تنبيه", info: "معلومة" };

  return (
    <section className="rounded-2xl border border-line bg-white shadow-card">
      <h2 className="flex items-center justify-between border-b border-line px-4 py-3 font-semibold">
        التنبيهات والمشكلات
        {!loading && <Badge tone={alerts.some((a) => a.level === "critical") ? "red" : alerts.length ? "amber" : "brand"}>{alerts.length}</Badge>}
      </h2>
      <div className="max-h-[720px] space-y-2 overflow-y-auto p-3">
        {loading ? Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16" />) : alerts.length === 0 ? (
          <div className="flex flex-col items-center py-10 text-center text-sm text-ink-muted">
            <CheckCircle2 className="mb-2 size-8 text-brand-600" />كل شيء يسير بشكل طبيعي
          </div>
        ) : alerts.map((a) => {
          const inner = (
            <>
              <a.icon className="mt-0.5 size-5 shrink-0" aria-hidden />
              <div className="min-w-0">
                <p className="text-sm font-semibold"><span className="sr-only">{label[a.level]}: </span>{a.title}</p>
                <p className="line-clamp-2 text-xs opacity-80">{a.body}</p>
              </div>
            </>
          );
          const cls = cn("flex w-full gap-3 rounded-xl border p-3 text-start", style[a.level]);
          return a.href ? <Link key={a.key} href={a.href} className={cls}>{inner}</Link>
            : <button key={a.key} onClick={() => a.tripId && onSelect(a.tripId)} className={cls}>{inner}</button>;
        })}
      </div>
      <div className="border-t border-line px-4 py-3 text-xs text-ink-soft"><Bus className="me-1 inline size-3.5" />يتم التحديث مباشرة</div>
    </section>
  );
}
