"use client";
import Link from "next/link";
import { use, useEffect, useState } from "react";
import { AlertOctagon, ArrowRight, Ban, Clock, UserCog } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/use-query";
import { toAppError } from "@/lib/errors";
import { attendanceLabel, attendanceTone, fmtAgo, fmtDate, fmtTime, periodLabel, tripStatusLabel, tripTone } from "@/lib/format";
import type { LivePosition, Trip, TripEvent, TripStop, TripStudent } from "@/lib/types";
import { useSchool } from "@/components/admin/school-context";
import { useLookups } from "@/components/admin/lookups";
import { Table, Td } from "@/components/admin/table";
import { BusMap } from "@/components/map/bus-map";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { ErrorState, PageLoading } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";

const EVENT_LABEL: Record<string, string> = {
  trip_started: "بدء الرحلة",
  attendance_boarded: "صعود",
  attendance_dropped: "نزول",
  attendance_absent: "غياب",
  attendance_pending: "تراجع عن حالة",
  arrived_school: "الوصول إلى المدرسة",
  arrived_end_point: "الوصول إلى نقطة النهاية",
  trip_completed: "إنهاء الرحلة",
  trip_delayed: "تأخير",
  trip_cancelled: "إلغاء",
  incident_reported: "بلاغ",
  emergency_cleared: "إنهاء حالة الطوارئ",
  note: "ملاحظة",
  assignment_changed: "تغيير التكليف",
};
const ROLE_LABEL: Record<string, string> = { driver: "السائق", supervisor: "المشرف", admin: "الإدارة" };

type RosterRow = TripStudent & { student: { full_name: string; grade: string | null } };

export default function TripDetail({ params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = use(params);
  const { school, canEdit } = useSchool();
  const sb = supabaseBrowser();
  const toast = useToast();
  const lk = useLookups(school.id);

  const q = useQuery(async () => {
    const [trip, roster, stops, events, live, path] = await Promise.all([
      sb.from("trips").select("*").eq("id", tripId).maybeSingle(),
      sb.from("trip_students").select("*, student:students(full_name, grade)").eq("trip_id", tripId),
      sb.from("trip_stops").select("*").eq("trip_id", tripId).order("seq"),
      sb.from("trip_events").select("*").eq("trip_id", tripId).order("created_at"),
      sb.from("bus_live_positions").select("*").eq("trip_id", tripId).maybeSingle(),
      sb.from("bus_locations").select("lat, lng").eq("trip_id", tripId).order("recorded_at").limit(5000),
    ]);
    return {
      trip: must(trip) as Trip | null,
      roster: (must(roster) as RosterRow[]).sort((a, b) => a.student.full_name.localeCompare(b.student.full_name, "ar")),
      stops: must(stops) as TripStop[],
      events: must(events) as TripEvent[],
      live: must(live) as LivePosition | null,
      path: (must(path) as { lat: number; lng: number }[]).map((p) => [p.lng, p.lat] as [number, number]),
    };
  }, [tripId]);

  useEffect(() => {
    const ch = sb.channel(`admin-trip-${tripId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "trip_events", filter: `trip_id=eq.${tripId}` }, () => q.reload(true))
      .on("postgres_changes", { event: "*", schema: "public", table: "bus_live_positions", filter: `trip_id=eq.${tripId}` }, () => q.reload(true))
      .subscribe();
    return () => { void sb.removeChannel(ch); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId]);

  const [dialog, setDialog] = useState<null | "cancel" | "assign" | "delay" | "emergency">(null);
  const [busy, setBusy] = useState(false);

  async function rpc(name: string, args: Record<string, unknown>, ok: string) {
    setBusy(true);
    const { error } = await sb.rpc(name, args);
    setBusy(false);
    if (error) { const e = toAppError(error); toast.error(e.message, e.detail); return; }
    toast.success(ok);
    setDialog(null);
    q.reload(true);
  }

  if (q.loading && !q.data) return <PageLoading rows={6} />;
  if (q.error) return <ErrorState message={q.error.message} onRetry={() => q.reload()} />;
  const d = q.data!;
  if (!d.trip) return <ErrorState message="الرحلة غير موجودة" />;
  const t = d.trip;
  const tz = school.timezone;
  const name = (id: string | null) => (id ? lk.data?.staffById.get(id)?.full_name : null) ?? "—";
  const closed = t.status === "completed" || t.status === "cancelled";
  const studentName = new Map(d.roster.map((r) => [r.student_id, r.student.full_name]));

  return (
    <div className="px-4 pb-12 pt-6 lg:px-8">
      <Link href={`/admin/${school.slug}/trips`} className="mb-3 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink"><ArrowRight className="size-4" />الرحلات</Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold">{t.name}</h1>
            <Badge tone={tripTone(t.status, t.delay_minutes > 0, t.emergency_active)} dot={t.status === "in_progress"}>{tripStatusLabel[t.status]}</Badge>
            {t.emergency_active && <Badge tone="red"><AlertOctagon className="size-3" />طوارئ</Badge>}
          </div>
          <p className="mt-1 text-sm text-ink-muted">{fmtDate(t.trip_date, tz)} · {periodLabel[t.period]} · الانطلاق {fmtTime(t.scheduled_start, tz)}</p>
        </div>
        {canEdit && !closed && (
          <div className="flex flex-wrap gap-2">
            {t.emergency_active && <Button variant="danger" onClick={() => setDialog("emergency")}>إنهاء حالة الطوارئ</Button>}
            <Button variant="secondary" onClick={() => setDialog("assign")}><UserCog className="size-4" />تغيير التكليف</Button>
            <Button variant="secondary" onClick={() => setDialog("delay")}><Clock className="size-4" />تأخير</Button>
            <Button variant="secondary" className="text-red-600" onClick={() => setDialog("cancel")}><Ban className="size-4" />إلغاء</Button>
          </div>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          <section className="overflow-hidden rounded-2xl border border-line bg-white shadow-card">
            <BusMap className="h-96" fitKey={`${t.id}-${d.path.length > 0}`}
              buses={d.live ? [{ id: t.id, lat: d.live.lat, lng: d.live.lng, heading: d.live.heading, label: lk.data?.busById.get(t.bus_id ?? "")?.code ?? "الباص", tone: t.emergency_active ? "red" : "brand" }] : []}
              path={d.path}
              points={[
                ...d.stops.map((s) => ({ id: s.id, lat: s.lat, lng: s.lng, label: `${s.seq}. ${s.name}`, kind: "stop" as const })),
                ...(t.end_lat && t.end_lng ? [{ id: "end", lat: t.end_lat, lng: t.end_lng, label: t.end_label ?? "", kind: t.period === "morning" ? "school" as const : "stop" as const }] : []),
              ]} />
            <dl className="grid grid-cols-2 gap-4 border-t border-line p-4 text-sm sm:grid-cols-4">
              <div><dt className="text-xs text-ink-soft">الباص</dt><dd className="font-medium">{lk.data?.busById.get(t.bus_id ?? "")?.code ?? "—"}</dd></div>
              <div><dt className="text-xs text-ink-soft">السائق</dt><dd className="font-medium">{name(t.driver_id)}</dd></div>
              <div><dt className="text-xs text-ink-soft">المشرف</dt><dd className="font-medium">{name(t.supervisor_id)}</dd></div>
              <div><dt className="text-xs text-ink-soft">آخر موقع</dt><dd className="font-medium">{d.live ? fmtAgo(d.live.recorded_at) : closed ? "توقف التتبع" : "—"}</dd></div>
              <div><dt className="text-xs text-ink-soft">بدأت</dt><dd className="font-medium">{fmtTime(t.started_at, tz)}</dd></div>
              <div><dt className="text-xs text-ink-soft">الوصول</dt><dd className="font-medium">{fmtTime(t.arrived_at, tz)}</dd></div>
              <div><dt className="text-xs text-ink-soft">انتهت</dt><dd className="font-medium">{fmtTime(t.completed_at, tz)}</dd></div>
              <div><dt className="text-xs text-ink-soft">التأخير</dt><dd className="font-medium">{t.delay_minutes ? `${t.delay_minutes} د — ${t.delay_reason}` : "—"}</dd></div>
            </dl>
          </section>

          <Table head={["الطالب", "الصف", "الحالة", "الصعود", "النزول"]}>
            {d.roster.map((r) => (
              <tr key={r.id}>
                <Td className="font-medium">{r.student.full_name}</Td>
                <Td className="text-ink-muted">{r.student.grade ?? "—"}</Td>
                <Td><Badge tone={attendanceTone(r.status)}>{attendanceLabel[r.status]}</Badge></Td>
                <Td>{fmtTime(r.boarded_at, tz)}</Td>
                <Td>{fmtTime(r.dropped_at, tz)}{r.drop_place === "school" ? " (المدرسة)" : ""}</Td>
              </tr>
            ))}
          </Table>
        </div>

        <section className="rounded-2xl border border-line bg-white shadow-card">
          <h2 className="border-b border-line px-4 py-3 font-semibold">السجل الزمني</h2>
          {d.events.length === 0 ? <p className="p-6 text-center text-sm text-ink-muted">لم تبدأ الرحلة بعد</p> : (
            <ol className="max-h-[720px] space-y-4 overflow-y-auto p-4">
              {d.events.map((e) => {
                const note = (e.data as { note?: string; reason?: string; minutes?: number }) ?? {};
                return (
                  <li key={e.id} className="flex gap-3">
                    <span className="mt-0.5 w-14 shrink-0 text-xs tabular-nums text-ink-soft">{fmtTime(e.created_at, tz)}</span>
                    <div className="min-w-0 text-sm">
                      <p className="font-medium">
                        {EVENT_LABEL[e.type] ?? e.type}
                        {e.student_id && <span className="font-normal"> — {studentName.get(e.student_id) ?? ""}</span>}
                      </p>
                      <p className="text-xs text-ink-muted">
                        {e.actor_role ? ROLE_LABEL[e.actor_role] ?? e.actor_role : "النظام"}
                        {(e.data as { auto?: boolean })?.auto ? " · تلقائي" : ""}
                        {e.lat != null ? " · 📍" : ""}
                      </p>
                      {(note.note || note.reason) && <p className="mt-1 rounded-lg bg-surface px-2 py-1 text-xs">{note.note ?? note.reason}</p>}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </div>

      <CancelDialog open={dialog === "cancel"} onClose={() => setDialog(null)} busy={busy}
        onSubmit={(reason) => rpc("cancel_trip", { p_trip: t.id, p_reason: reason }, "تم إلغاء الرحلة وإشعار أولياء الأمور")} />
      <AssignDialog open={dialog === "assign"} onClose={() => setDialog(null)} busy={busy} trip={t} lk={lk.data}
        onSubmit={(bus, drv, sup) => rpc("update_trip_assignment", { p_trip: t.id, p_bus: bus || null, p_driver: drv || null, p_supervisor: sup || null }, "تم تحديث التكليف")} />
      <DelayDialog open={dialog === "delay"} onClose={() => setDialog(null)} busy={busy}
        onSubmit={(m, r) => rpc("report_delay", { p_trip: t.id, p_minutes: m, p_reason: r }, "تم تسجيل التأخير وإشعار أولياء الأمور")} />
      <ConfirmDialog open={dialog === "emergency"} onClose={() => setDialog(null)} loading={busy} title="إنهاء حالة الطوارئ؟"
        description="تأكد من معالجة الموقف والتواصل مع أولياء الأمور المعنيين." confirmLabel="إنهاء حالة الطوارئ"
        onConfirm={() => rpc("clear_trip_emergency", { p_trip: t.id }, "تم إنهاء حالة الطوارئ")} />
    </div>
  );
}

function CancelDialog({ open, onClose, busy, onSubmit }: { open: boolean; onClose: () => void; busy: boolean; onSubmit: (r: string) => void }) {
  const [reason, setReason] = useState("");
  return (
    <Dialog open={open} onClose={onClose} title="إلغاء الرحلة" description="سيُرسل إشعار إلغاء لأولياء أمور الطلاب في هذه الرحلة." size="sm"
      footer={<><Button variant="danger" loading={busy} disabled={!reason.trim()} onClick={() => onSubmit(reason)}>إلغاء الرحلة</Button><Button variant="secondary" onClick={onClose}>رجوع</Button></>}>
      <Field label="سبب الإلغاء"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Dialog>
  );
}

function DelayDialog({ open, onClose, busy, onSubmit }: { open: boolean; onClose: () => void; busy: boolean; onSubmit: (m: number, r: string) => void }) {
  const [m, setM] = useState(10);
  const [r, setR] = useState("");
  return (
    <Dialog open={open} onClose={onClose} title="تسجيل تأخير" size="sm"
      footer={<><Button loading={busy} disabled={!r.trim()} onClick={() => onSubmit(m, r)}>حفظ وإشعار</Button><Button variant="secondary" onClick={onClose}>رجوع</Button></>}>
      <div className="space-y-3">
        <Field label="الدقائق"><Input type="number" min={1} max={240} value={m} onChange={(e) => setM(Number(e.target.value))} /></Field>
        <Field label="السبب"><Textarea value={r} onChange={(e) => setR(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}

function AssignDialog({ open, onClose, busy, trip, lk, onSubmit }: {
  open: boolean; onClose: () => void; busy: boolean; trip: Trip;
  lk: ReturnType<typeof useLookups>["data"]; onSubmit: (bus: string, driver: string, sup: string) => void;
}) {
  const [bus, setBus] = useState(trip.bus_id ?? "");
  const [drv, setDrv] = useState(trip.driver_id ?? "");
  const [sup, setSup] = useState(trip.supervisor_id ?? "");
  const started = trip.status !== "scheduled";
  return (
    <Dialog open={open} onClose={onClose} title="تغيير تكليف الرحلة" description="يسري على هذه الرحلة فقط. لتغيير دائم عدّل الجدول المتكرر." size="sm"
      footer={<><Button loading={busy} onClick={() => onSubmit(bus, drv, sup)}>حفظ</Button><Button variant="secondary" onClick={onClose}>رجوع</Button></>}>
      <div className="space-y-3">
        <Field label="الباص">
          <Select value={bus} onChange={(e) => setBus(e.target.value)}>
            <option value="">—</option>{lk?.buses.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.plate_number}</option>)}
          </Select>
        </Field>
        <Field label="السائق" hint={started ? "لا يمكن تغيير السائق بعد بدء الرحلة" : undefined}>
          <Select value={drv} onChange={(e) => setDrv(e.target.value)} disabled={started}>
            <option value="">—</option>{lk?.drivers.map((b) => <option key={b.id} value={b.id}>{b.full_name}</option>)}
          </Select>
        </Field>
        <Field label="المشرف">
          <Select value={sup} onChange={(e) => setSup(e.target.value)}>
            <option value="">—</option>{lk?.supervisors.map((b) => <option key={b.id} value={b.id}>{b.full_name}</option>)}
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}
