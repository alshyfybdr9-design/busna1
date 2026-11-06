"use client";
import Link from "next/link";
import { use, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, ArrowRight, Check, CircleSlash, Clock, Flag, MapPin, MessageSquarePlus, Navigation,
  Phone, Play, School, Signal, SignalZero, Undo2, UserCheck, UserMinus, Users, WifiOff,
} from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/use-query";
import { toAppError } from "@/lib/errors";
import { tracker, currentPosition, type TrackerState } from "@/lib/tracking";
import { DEFAULT_TRACKING, trackingConfigFrom } from "@/lib/gps-policy";
import { flushOutbox, sendAttendance } from "@/lib/outbox";
import {
  attendanceLabel, attendanceTone, fmtAgo, fmtPhone, fmtTime, incidentCategoryLabel, periodLabel,
  severityLabel, tripStatusLabel, tripTone,
} from "@/lib/format";
import type { AttendanceStatus, Bus, IncidentCategory, IncidentSeverity, Staff, Trip, TripStop, TripStudent } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, Select, Textarea } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { EmptyState, ErrorState, PageLoading } from "@/components/ui/states";
import { BusMap } from "@/components/map/bus-map";
import { cn } from "@/components/ui/cn";

interface RosterRow extends TripStudent {
  student: { id: string; full_name: string; photo_url: string | null; pickup_label: string | null; grade: string | null };
}
type Filter = "all" | AttendanceStatus;

export default function TripConsole({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const sb = supabaseBrowser();
  const toast = useToast();

  const q = useQuery(async () => {
    const { data: { user } } = await sb.auth.getUser();
    const [me, trip, roster, stops] = await Promise.all([
      sb.from("staff").select("id").eq("user_id", user!.id).eq("status", "active"),
      sb.from("trips").select("*, bus:buses(*)").eq("id", id).maybeSingle(),
      sb.from("trip_students").select("*, student:students(id, full_name, photo_url, pickup_label, grade)").eq("trip_id", id),
      sb.from("trip_stops").select("*").eq("trip_id", id).order("seq"),
    ]);
    const myIds = new Set((must(me) as Pick<Staff, "id">[]).map((s) => s.id));
    const t = must(trip) as (Trip & { bus: Bus | null }) | null;
    if (!t) return null;
    const role: "driver" | "supervisor" | null = myIds.has(t.driver_id ?? "") ? "driver" : myIds.has(t.supervisor_id ?? "") ? "supervisor" : null;
    // School-configured GPS cadence; the defaults are safe if it cannot be read.
    const cfgRes = role === "driver" ? await sb.rpc("tracking_config", { p_school: t.school_id }) : null;
    const gpsCfg = cfgRes && !cfgRes.error ? trackingConfigFrom(cfgRes.data) : DEFAULT_TRACKING;
    return { trip: t, roster: must(roster) as RosterRow[], stops: must(stops) as TripStop[], role, gpsCfg };
  }, [id]);

  // Realtime: driver & supervisor devices stay in sync.
  useEffect(() => {
    const ch = sb.channel(`trip-${id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "trip_students", filter: `trip_id=eq.${id}` }, () => q.reload(true))
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "trips", filter: `id=eq.${id}` }, () => q.reload(true))
      .subscribe();
    const onOnline = async () => {
      const r = await flushOutbox();
      if (r.sent) toast.success("تمت مزامنة الحضور", `${r.sent} عملية أُرسلت بعد عودة الاتصال`);
      r.failed.forEach((f) => toast.error("لم تُقبل عملية حضور", f.message));
      q.reload(true);
    };
    window.addEventListener("online", onOnline);
    void onOnline();
    return () => { void sb.removeChannel(ch); window.removeEventListener("online", onOnline); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // GPS sharing follows the trip state (driver only).
  const [gps, setGps] = useState<TrackerState>(tracker.current);
  useEffect(() => tracker.subscribe(setGps), []);
  const trip = q.data?.trip;
  const role = q.data?.role;
  useEffect(() => {
    if (!trip || role !== "driver") return;
    const active = trip.status === "started" || trip.status === "in_progress";
    if (active) tracker.start(trip.id, q.data?.gpsCfg);
    else if (tracker.current.tripId === trip.id) tracker.stop(true);
  }, [trip?.id, trip?.status, role, trip]);

  const [filter, setFilter] = useState<Filter>("all");
  const [dialog, setDialog] = useState<null | "start" | "arrive" | "end" | "delay" | "incident" | "note" | "contacts" | "map">(null);
  const [busy, setBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const counts = useMemo(() => {
    const c = { pending: 0, boarded: 0, absent: 0, dropped: 0 } as Record<AttendanceStatus, number>;
    q.data?.roster.forEach((r) => c[r.status]++);
    return c;
  }, [q.data]);

  const groups = useMemo(() => {
    if (!q.data) return [];
    const { roster, stops } = q.data;
    const rows = filter === "all" ? roster : roster.filter((r) => r.status === filter);
    const byStop = new Map<string | null, RosterRow[]>();
    rows.forEach((r) => byStop.set(r.trip_stop_id, [...(byStop.get(r.trip_stop_id) ?? []), r]));
    const out: { stop: TripStop | null; rows: RosterRow[] }[] = stops
      .filter((s) => byStop.has(s.id))
      .map((s) => ({ stop: s, rows: byStop.get(s.id)! }));
    if (byStop.has(null)) out.push({ stop: null, rows: byStop.get(null)! });
    out.forEach((g) => g.rows.sort((a, b) => a.student.full_name.localeCompare(b.student.full_name, "ar")));
    return out;
  }, [q.data, filter]);

  if (q.loading && !q.data) return <PageLoading rows={6} />;
  if (q.error) return <ErrorState message={q.error.message} onRetry={() => q.reload()} />;
  if (!q.data || !trip) return <EmptyState icon={CircleSlash} title="الرحلة غير موجودة أو غير مخصصة لك" action={<Link href="/staff" className="text-brand-700 underline">العودة للرحلات</Link>} />;

  const { roster, stops } = q.data;
  const isDriver = role === "driver";
  const active = trip.status === "started" || trip.status === "in_progress";
  const closed = trip.status === "completed" || trip.status === "cancelled";
  const delayed = trip.delay_minutes > 0;

  async function call<T>(fn: () => PromiseLike<{ data: T; error: unknown }>, ok?: string) {
    setBusy(true);
    try {
      const { data, error } = await fn();
      if (error) throw error;
      if (ok) toast.success(ok);
      setDialog(null);
      await q.reload(true);
      return data;
    } catch (err) {
      const e = toAppError(err);
      toast.error(e.message, e.detail);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function startTrip() {
    const pos = await currentPosition();
    const r = await call(() => sb.rpc("start_trip", { p_trip: trip!.id, p_lat: pos?.lat ?? null, p_lng: pos?.lng ?? null }), "بدأت الرحلة — تم تفعيل مشاركة الموقع");
    if (r) tracker.start(trip!.id, q.data?.gpsCfg);
  }
  async function arrive() {
    const pos = await currentPosition();
    const r = await call(() => sb.rpc("arrive_trip", { p_trip: trip!.id, p_lat: pos?.lat ?? null, p_lng: pos?.lng ?? null }));
    if (r) {
      const d = r as { dropped: number; arrived_kind: string };
      toast.success(d.arrived_kind === "school" ? "تم تسجيل الوصول إلى المدرسة" : "تم تسجيل الوصول إلى نقطة النهاية",
        d.dropped ? `تم تسجيل وصول ${d.dropped} طالب وإشعار أولياء أمورهم` : undefined);
    }
  }
  async function endTrip(markAbsent: boolean) {
    const pos = await currentPosition();
    const r = await call(() => sb.rpc("end_trip", { p_trip: trip!.id, p_lat: pos?.lat ?? null, p_lng: pos?.lng ?? null, p_mark_pending_absent: markAbsent }),
      "انتهت الرحلة — تم إيقاف مشاركة الموقع");
    if (r) tracker.stop(true);
  }

  async function mark(row: RosterRow, status: AttendanceStatus) {
    setRowBusy(row.id);
    const pos = await currentPosition(1500);
    // optimistic update
    q.setData((d) => d && { ...d, roster: d.roster.map((r) => (r.id === row.id ? { ...r, status } : r)) });
    const res = await sendAttendance({ key: row.id, tripId: trip!.id, status, lat: pos?.lat ?? null, lng: pos?.lng ?? null });
    setRowBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      q.reload(true);
    } else if (res.queued) {
      toast.warning("لا يوجد اتصال", "تم حفظ العملية وستُرسل تلقائيًا عند عودة الإنترنت");
    }
  }

  return (
    <main className="pb-44">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-line bg-white/95 px-4 pb-3 pt-[max(.75rem,env(safe-area-inset-top))] backdrop-blur">
        <div className="flex items-center gap-2">
          <Link href="/staff" className="-ms-2 rounded-lg p-2 text-ink-muted hover:bg-slate-100" aria-label="رجوع"><ArrowRight className="size-5" /></Link>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-bold">{trip.name}</h1>
            <p className="text-xs text-ink-muted">{periodLabel[trip.period]} · {trip.bus?.code ?? "بدون باص"} · {fmtTime(trip.scheduled_start)}</p>
          </div>
          <Badge tone={tripTone(trip.status, delayed, trip.emergency_active)} dot={trip.status === "in_progress"}>{tripStatusLabel[trip.status]}</Badge>
        </div>
        {isDriver && active && <GpsStrip gps={gps} />}
        {trip.emergency_active && (
          <p className="mt-2 flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700"><AlertTriangle className="size-4" />حالة طوارئ مفعّلة — الإدارة تتابع</p>
        )}
        {delayed && !closed && (
          <p className="mt-2 rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-800">متأخرة {trip.delay_minutes} دقيقة: {trip.delay_reason}</p>
        )}
      </header>

      {/* Counters */}
      <div className="grid grid-cols-4 gap-2 px-4 pt-4" role="tablist" aria-label="تصفية الطلاب">
        {([["pending", "لم يصعد"], ["boarded", "في الباص"], ["dropped", "نزل"], ["absent", "غائب"]] as const).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={filter === k} onClick={() => setFilter(filter === k ? "all" : k)}
            className={cn("rounded-xl border bg-white px-2 py-2.5 text-center transition",
              filter === k ? "border-brand-500 ring-2 ring-brand-100" : "border-line")}>
            <span className={cn("block text-xl font-bold", k === "boarded" && "text-brand-700", k === "absent" && "text-red-600", k === "dropped" && "text-sky-700")}>{counts[k]}</span>
            <span className="block text-xs text-ink-muted">{label}</span>
          </button>
        ))}
      </div>

      {/* Roster */}
      <section className="space-y-5 px-4 pt-4">
        {roster.length === 0 && <EmptyState icon={Users} title="لا يوجد طلاب في هذه الرحلة" />}
        {roster.length > 0 && groups.length === 0 && <p className="py-8 text-center text-sm text-ink-muted">لا يوجد طلاب بهذه الحالة</p>}
        {groups.map((g) => (
          <div key={g.stop?.id ?? "none"}>
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink-muted">
              <MapPin className="size-4" />
              {g.stop ? `${g.stop.seq}. ${g.stop.name}` : "بدون نقطة محددة"}
              {g.stop?.planned_at && <span className="font-normal">· {fmtTime(g.stop.planned_at)}</span>}
              {g.stop?.arrived_at && <Badge tone="blue">تم المرور</Badge>}
            </h2>
            <ul className="space-y-2">
              {g.rows.map((r) => (
                <StudentRow key={r.id} row={r} period={trip.period} disabled={closed || rowBusy === r.id}
                  canBoard={active} onMark={(s) => mark(r, s)} />
              ))}
            </ul>
          </div>
        ))}
      </section>

      {/* Secondary actions */}
      {!closed && (
        <div className="grid grid-cols-2 gap-2 px-4 pt-6">
          <Button variant="secondary" onClick={() => setDialog("delay")}><Clock className="size-4" />تأخير</Button>
          <Button variant="secondary" onClick={() => setDialog("incident")}><AlertTriangle className="size-4" />إبلاغ عن مشكلة</Button>
          <Button variant="secondary" onClick={() => setDialog("note")}><MessageSquarePlus className="size-4" />ملاحظة</Button>
          {role === "supervisor"
            ? <Button variant="secondary" onClick={() => setDialog("contacts")}><Phone className="size-4" />أولياء الأمور</Button>
            : <Button variant="secondary" onClick={() => setDialog("map")}><Navigation className="size-4" />الخريطة</Button>}
          {role === "supervisor" && <Button variant="secondary" className="col-span-2" onClick={() => setDialog("map")}><Navigation className="size-4" />موقع الباص</Button>}
        </div>
      )}

      {/* Primary action bar */}
      {isDriver && !closed && (
        <div className="fixed inset-x-0 bottom-0 z-30 mx-auto max-w-lg border-t border-line bg-white/95 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur">
          {trip.status === "scheduled" && (
            <Button size="xl" className="w-full" onClick={() => setDialog("start")}><Play className="size-6" />بدء الرحلة</Button>
          )}
          {active && (
            <div className="grid gap-2">
              {!trip.arrived_at && (
                <Button size="xl" variant="secondary" className="w-full border-2 border-brand-600 text-brand-800" onClick={() => setDialog("arrive")}>
                  {trip.period === "morning" ? <><School className="size-6" />وصلنا المدرسة</> : <><Flag className="size-6" />الوصول إلى نقطة النهاية</>}
                </Button>
              )}
              <Button size="xl" variant={trip.arrived_at ? "primary" : "danger"} className="w-full" onClick={() => setDialog("end")}>
                <Check className="size-6" />إنهاء الرحلة
              </Button>
            </div>
          )}
        </div>
      )}
      {closed && (
        <p className="mx-4 mt-6 rounded-xl bg-slate-100 p-4 text-center text-sm text-ink-muted">
          {trip.status === "completed" ? `انتهت الرحلة ${fmtTime(trip.completed_at)}` : `أُلغيت الرحلة: ${trip.cancel_reason ?? ""}`}
        </p>
      )}

      {/* Dialogs */}
      <ConfirmDialog open={dialog === "start"} onClose={() => setDialog(null)} onConfirm={startTrip} loading={busy}
        title="بدء الرحلة؟" confirmLabel="ابدأ الرحلة"
        description={`سيتم تسجيل وقت البداية وتفعيل مشاركة موقعك المباشر حتى نهاية الرحلة، وإشعار أولياء أمور ${roster.length - counts.absent} طالب.`} />

      <ConfirmDialog open={dialog === "arrive"} onClose={() => setDialog(null)} onConfirm={arrive} loading={busy}
        title={trip.period === "morning" ? "تأكيد الوصول إلى المدرسة" : "تأكيد الوصول إلى نقطة النهاية"}
        confirmLabel="تأكيد الوصول"
        description={trip.period === "morning"
          ? `سيتم تسجيل وصول ${counts.boarded} طالب داخل الباص إلى المدرسة وإشعار أولياء أمورهم. الرحلة تبقى مفتوحة حتى تضغط "إنهاء الرحلة".`
          : "سيتم تسجيل الوصول إلى نقطة النهاية. الرحلة تبقى مفتوحة حتى تضغط \"إنهاء الرحلة\"."} />

      <EndTripDialog open={dialog === "end"} onClose={() => setDialog(null)} roster={roster} busy={busy} onEnd={endTrip} />

      <DelayDialog open={dialog === "delay"} onClose={() => setDialog(null)} busy={busy}
        onSubmit={(m, r) => call(() => sb.rpc("report_delay", { p_trip: trip.id, p_minutes: m, p_reason: r }), "تم إبلاغ أولياء الأمور بالتأخير")} />

      <IncidentDialog open={dialog === "incident"} onClose={() => setDialog(null)} busy={busy}
        onSubmit={async (c, s, d) => {
          const pos = await currentPosition(1500);
          await call(() => sb.rpc("report_incident", { p_trip: trip.id, p_category: c, p_severity: s, p_description: d, p_lat: pos?.lat ?? null, p_lng: pos?.lng ?? null }),
            s === "critical" || s === "high" ? "تم إرسال البلاغ للإدارة فورًا" : "تم تسجيل البلاغ");
        }} />

      <NoteDialog open={dialog === "note"} onClose={() => setDialog(null)} busy={busy}
        onSubmit={(n) => call(() => sb.rpc("add_trip_note", { p_trip: trip.id, p_note: n }), "تم حفظ الملاحظة")} />

      {role === "supervisor" && <ContactsDialog open={dialog === "contacts"} onClose={() => setDialog(null)} tripId={trip.id} />}

      <TripMapDialog open={dialog === "map"} onClose={() => setDialog(null)} trip={trip} stops={stops} />
    </main>
  );
}

function GpsStrip({ gps }: { gps: TrackerState }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 5000); return () => clearInterval(t); }, []);
  const denied = gps.permission === "denied" || gps.permission === "unavailable";
  return (
    <div className={cn("mt-2 flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs",
      denied ? "bg-red-50 text-red-700" : !gps.online ? "bg-amber-50 text-amber-800" : "bg-brand-50 text-brand-800")} role="status">
      {denied ? <SignalZero className="size-4" /> : !gps.online ? <WifiOff className="size-4" /> : <Signal className="size-4" />}
      <span className="flex-1">
        {denied ? gps.error
          : !gps.online ? `بدون إنترنت — ${gps.queued} موقع محفوظ للإرسال`
          : gps.lastSentAt ? `مشاركة الموقع مفعّلة · آخر إرسال ${fmtAgo(new Date(gps.lastSentAt).toISOString())}`
          : gps.error ?? "جارٍ تحديد الموقع…"}
      </span>
      {gps.accuracy != null && !denied && <span className="opacity-70">±{Math.round(gps.accuracy)}م</span>}
    </div>
  );
}

function initials(name: string) {
  const p = name.trim().split(/\s+/);
  return (p[0]?.[0] ?? "") + (p[1]?.[0] ?? "");
}

function StudentRow({ row, period, disabled, canBoard, onMark }: {
  row: RosterRow; period: "morning" | "afternoon"; disabled: boolean; canBoard: boolean; onMark: (s: AttendanceStatus) => void;
}) {
  const s = row.status;
  return (
    <li className={cn("flex items-center gap-3 rounded-2xl border bg-white p-3 shadow-card",
      s === "boarded" ? "border-brand-200" : s === "absent" ? "border-red-100 opacity-80" : "border-line")}>
      {row.student.photo_url
        ? <img src={row.student.photo_url} alt="" className="size-12 shrink-0 rounded-full object-cover" />
        : <span className="grid size-12 shrink-0 place-items-center rounded-full bg-slate-100 font-semibold text-ink-muted">{initials(row.student.full_name)}</span>}
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">{row.student.full_name}</p>
        <div className="mt-0.5 flex items-center gap-2">
          <Badge tone={attendanceTone(s)}>{attendanceLabel[s]}</Badge>
          {row.boarded_at && s === "boarded" && <span className="text-xs text-ink-soft">{fmtTime(row.boarded_at)}</span>}
          {row.dropped_at && s === "dropped" && <span className="text-xs text-ink-soft">{fmtTime(row.dropped_at)}</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {s === "pending" && (
          <>
            <button disabled={disabled} onClick={() => onMark("absent")} aria-label={`تسجيل غياب ${row.student.full_name}`}
              className="grid size-12 place-items-center rounded-xl border border-line text-red-600 active:bg-red-50 disabled:opacity-40">
              <UserMinus className="size-5" />
            </button>
            <button disabled={disabled || !canBoard} onClick={() => onMark("boarded")} aria-label={`تسجيل صعود ${row.student.full_name}`}
              className="flex h-12 items-center gap-1.5 rounded-xl bg-brand-600 px-4 font-semibold text-white active:brightness-90 disabled:opacity-40">
              <UserCheck className="size-5" />صعد
            </button>
          </>
        )}
        {s === "boarded" && (
          <>
            <button disabled={disabled} onClick={() => onMark("pending")} aria-label="تراجع"
              className="grid size-12 place-items-center rounded-xl border border-line text-ink-soft disabled:opacity-40"><Undo2 className="size-5" /></button>
            <button disabled={disabled} onClick={() => onMark("dropped")} aria-label={`تسجيل نزول ${row.student.full_name}`}
              className="flex h-12 items-center gap-1.5 rounded-xl bg-sky-600 px-4 font-semibold text-white active:brightness-90 disabled:opacity-40">
              <Check className="size-5" />{period === "afternoon" ? "نزل" : "نزل"}
            </button>
          </>
        )}
        {(s === "absent" || s === "dropped") && (
          <button disabled={disabled} onClick={() => onMark(s === "absent" ? "pending" : "boarded")}
            className="flex h-10 items-center gap-1 rounded-xl border border-line px-3 text-sm text-ink-muted disabled:opacity-40">
            <Undo2 className="size-4" />تراجع
          </button>
        )}
      </div>
    </li>
  );
}

function EndTripDialog({ open, onClose, roster, busy, onEnd }: {
  open: boolean; onClose: () => void; roster: RosterRow[]; busy: boolean; onEnd: (markAbsent: boolean) => void;
}) {
  const onBoard = roster.filter((r) => r.status === "boarded");
  const pending = roster.filter((r) => r.status === "pending");
  const blocked = onBoard.length > 0;
  return (
    <Dialog open={open} onClose={onClose} title="إنهاء الرحلة" size="sm"
      footer={blocked
        ? <Button variant="secondary" onClick={onClose}>حسنًا</Button>
        : <>
            <Button variant={pending.length ? "warning" : "primary"} loading={busy} onClick={() => onEnd(pending.length > 0)}>
              {pending.length ? `تسجيلهم غائبين وإنهاء الرحلة` : "إنهاء الرحلة"}
            </Button>
            <Button variant="secondary" onClick={onClose} disabled={busy}>إلغاء</Button>
          </>}>
      {blocked ? (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-800">
          <p className="flex items-center gap-2 font-semibold"><AlertTriangle className="size-5" />لا يمكن إنهاء الرحلة</p>
          <p className="mt-1 text-sm">يوجد {onBoard.length} طالب داخل الباص لم يُسجَّل نزوله. تأكد من الباص وسجّل نزولهم أولًا:</p>
          <ul className="mt-2 list-inside list-disc text-sm font-medium">{onBoard.map((r) => <li key={r.id}>{r.student.full_name}</li>)}</ul>
        </div>
      ) : pending.length > 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900">
          <p className="font-semibold">طلاب لم تُسجَّل حالتهم ({pending.length})</p>
          <ul className="mt-2 list-inside list-disc text-sm">{pending.map((r) => <li key={r.id}>{r.student.full_name}</li>)}</ul>
          <p className="mt-2 text-sm">سيتم تسجيلهم غائبين وإشعار أولياء أمورهم.</p>
        </div>
      ) : (
        <p className="text-sm text-ink-muted">سيتم تسجيل وقت نهاية الرحلة وإيقاف مشاركة الموقع. جميع الطلاب تمت معالجة حالتهم.</p>
      )}
    </Dialog>
  );
}

const DELAY_REASONS = ["ازدحام مروري", "تأخر طالب عند نقطة الصعود", "عطل بسيط في الباص", "إغلاق طريق", "الطقس"];

function DelayDialog({ open, onClose, busy, onSubmit }: { open: boolean; onClose: () => void; busy: boolean; onSubmit: (m: number, r: string) => void }) {
  const [minutes, setMinutes] = useState(10);
  const [reason, setReason] = useState("");
  return (
    <Dialog open={open} onClose={onClose} title="الإبلاغ عن تأخير" description="سيُرسل إشعار لأولياء أمور الطلاب المعنيين." size="sm"
      footer={<><Button loading={busy} disabled={!reason.trim()} onClick={() => onSubmit(minutes, reason)}>إرسال</Button><Button variant="secondary" onClick={onClose}>إلغاء</Button></>}>
      <div className="space-y-4">
        <Field label="مدة التأخير المتوقعة">
          <Select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            {[5, 10, 15, 20, 30, 45, 60].map((m) => <option key={m} value={m}>{m} دقيقة</option>)}
          </Select>
        </Field>
        <div>
          <p className="mb-1.5 text-sm font-medium">السبب</p>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {DELAY_REASONS.map((r) => (
              <button key={r} type="button" onClick={() => setReason(r)}
                className={cn("rounded-full border px-3 py-1 text-sm", reason === r ? "border-brand-500 bg-brand-50 text-brand-800" : "border-line")}>{r}</button>
            ))}
          </div>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="أو اكتب السبب" aria-label="سبب التأخير" />
        </div>
      </div>
    </Dialog>
  );
}

function IncidentDialog({ open, onClose, busy, onSubmit }: {
  open: boolean; onClose: () => void; busy: boolean; onSubmit: (c: IncidentCategory, s: IncidentSeverity, d: string) => void;
}) {
  const [cat, setCat] = useState<IncidentCategory>("breakdown");
  const [sev, setSev] = useState<IncidentSeverity>("medium");
  const [desc, setDesc] = useState("");
  return (
    <Dialog open={open} onClose={onClose} title="إبلاغ الإدارة عن مشكلة" size="sm"
      footer={<><Button variant={sev === "critical" ? "danger" : "primary"} loading={busy} disabled={!desc.trim()} onClick={() => onSubmit(cat, sev, desc)}>إرسال البلاغ</Button><Button variant="secondary" onClick={onClose}>إلغاء</Button></>}>
      <div className="space-y-4">
        <Field label="نوع المشكلة">
          <Select value={cat} onChange={(e) => setCat(e.target.value as IncidentCategory)}>
            {Object.entries(incidentCategoryLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="الخطورة" hint={sev === "critical" ? "الطارئة تُفعّل حالة الطوارئ وتُشعر الإدارة وأولياء أمور الطلاب داخل الباص" : undefined}>
          <Select value={sev} onChange={(e) => setSev(e.target.value as IncidentSeverity)}>
            {Object.entries(severityLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="الوصف"><Textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="ماذا حدث؟ وأين؟" /></Field>
      </div>
    </Dialog>
  );
}

function NoteDialog({ open, onClose, busy, onSubmit }: { open: boolean; onClose: () => void; busy: boolean; onSubmit: (n: string) => void }) {
  const [note, setNote] = useState("");
  return (
    <Dialog open={open} onClose={onClose} title="ملاحظة على الرحلة" description="تظهر في سجل الرحلة لدى الإدارة." size="sm"
      footer={<><Button loading={busy} disabled={!note.trim()} onClick={() => { onSubmit(note); setNote(""); }}>حفظ</Button><Button variant="secondary" onClick={onClose}>إلغاء</Button></>}>
      <Textarea value={note} onChange={(e) => setNote(e.target.value)} aria-label="الملاحظة" />
    </Dialog>
  );
}

function ContactsDialog({ open, onClose, tripId }: { open: boolean; onClose: () => void; tripId: string }) {
  const sb = supabaseBrowser();
  const q = useQuery(async () => (open ? must(await sb.rpc("get_trip_contacts", { p_trip: tripId })) : []) as {
    student_id: string; student_name: string; guardian_name: string; relation: string; phone: string; phone_alt: string | null;
  }[], [open, tripId]);
  return (
    <Dialog open={open} onClose={onClose} title="التواصل مع أولياء الأمور" size="md">
      {q.loading ? <PageLoading rows={3} /> : q.error ? <ErrorState message={q.error.message} /> : (q.data ?? []).length === 0 ? (
        <EmptyState icon={Phone} title="لا توجد أرقام مسجلة" />
      ) : (
        <ul className="divide-y divide-line">
          {q.data!.map((c, i) => (
            <li key={i} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{c.student_name}</p>
                <p className="text-sm text-ink-muted">{c.guardian_name} ({c.relation}) · <span dir="ltr">{fmtPhone(c.phone)}</span></p>
              </div>
              <a href={`tel:${c.phone}`} className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-brand-600 px-3 text-sm font-medium text-white">
                <Phone className="size-4" />اتصال
              </a>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function TripMapDialog({ open, onClose, trip, stops }: { open: boolean; onClose: () => void; trip: Trip; stops: TripStop[] }) {
  const sb = supabaseBrowser();
  const q = useQuery(async () => {
    if (!open) return null;
    return must(await sb.from("bus_live_positions").select("*").eq("trip_id", trip.id).maybeSingle()) as
      { lat: number; lng: number; heading: number | null; recorded_at: string } | null;
  }, [open, trip.id]);
  const pos = q.data;
  return (
    <Dialog open={open} onClose={onClose} title="موقع الباص" size="lg"
      description={pos ? `آخر تحديث ${fmtAgo(pos.recorded_at)}` : "لا يوجد موقع مباشر (الرحلة غير نشطة أو لم يصل أول موقع بعد)"}>
      {open && (
        <BusMap className="h-[60vh] rounded-xl" fitKey={`${open}-${pos?.recorded_at}`}
          buses={pos ? [{ id: trip.id, lat: pos.lat, lng: pos.lng, heading: pos.heading, label: "الباص", tone: "brand" }] : []}
          points={[
            ...stops.map((s) => ({ id: s.id, lat: s.lat, lng: s.lng, label: s.name, kind: "stop" as const })),
            ...(trip.end_lat && trip.end_lng ? [{ id: "end", lat: trip.end_lat, lng: trip.end_lng, label: trip.end_label ?? "", kind: trip.period === "morning" ? "school" as const : "stop" as const }] : []),
          ]} />
      )}
    </Dialog>
  );
}
