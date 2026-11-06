"use client";
import Link from "next/link";
import { useState } from "react";
import { CalendarPlus, Plus, Route as RouteIcon } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/use-query";
import { toAppError } from "@/lib/errors";
import { fmtTime, periodLabel, todayIn, tripStatusLabel, tripTone, weekdayLabels } from "@/lib/format";
import type { Route, Trip } from "@/lib/types";
import { useSchool } from "@/components/admin/school-context";
import { PageHeader } from "@/components/admin/shell";
import { useLookups } from "@/components/admin/lookups";
import { Table, Td, Toolbar } from "@/components/admin/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { EmptyState, ErrorState, PageLoading } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/components/ui/cn";

interface TripRow extends Trip { students: { status: string }[] }

export default function TripsPage() {
  const { school } = useSchool();
  const [tab, setTab] = useState<"day" | "routes">("day");
  return (
    <div className="pb-10">
      <PageHeader title="الرحلات" subtitle="الرحلات اليومية والجداول المتكررة حسب أيام الأسبوع"
        actions={<Link href={`/admin/${school.slug}/trips/routes/new`}><Button><Plus className="size-4" />رحلة متكررة جديدة</Button></Link>} />
      <div className="px-4 lg:px-8">
        <div className="mb-4 inline-flex rounded-xl bg-slate-100 p-1 text-sm" role="tablist">
          {([["day", "رحلات اليوم"], ["routes", "الجداول المتكررة"]] as const).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
              className={cn("rounded-lg px-4 py-1.5", tab === k ? "bg-white font-medium shadow-card" : "text-ink-muted")}>{l}</button>
          ))}
        </div>
        {tab === "day" ? <DayTrips /> : <Routes />}
      </div>
    </div>
  );
}

function DayTrips() {
  const { school, canEdit } = useSchool();
  const sb = supabaseBrowser();
  const toast = useToast();
  const lk = useLookups(school.id);
  const [date, setDate] = useState(todayIn(school.timezone));
  const [busy, setBusy] = useState(false);
  const q = useQuery(async () => must(await sb.from("trips").select("*, students:trip_students(status)")
    .eq("school_id", school.id).eq("trip_date", date).order("scheduled_start")) as TripRow[], [school.id, date]);

  async function generate() {
    setBusy(true);
    const { data, error } = await sb.rpc("generate_trips", { p_school: school.id, p_date: date });
    setBusy(false);
    if (error) return toast.error(toAppError(error).message);
    toast.success(data ? `تم إنشاء ${data} رحلة` : "الرحلات موجودة مسبقًا — تم تحديث قوائم الطلاب");
    q.reload(true);
  }

  return (
    <>
      <Toolbar>
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-auto" aria-label="التاريخ" />
        {canEdit && <Button variant="secondary" onClick={generate} loading={busy}><CalendarPlus className="size-4" />إنشاء رحلات هذا اليوم من الجداول</Button>}
      </Toolbar>
      {q.loading && !q.data ? <PageLoading /> : q.error ? <ErrorState message={q.error.message} onRetry={() => q.reload()} /> :
        q.data!.length === 0 ? (
          <EmptyState icon={RouteIcon} title="لا توجد رحلات في هذا اليوم"
            body="تُنشأ الرحلات تلقائيًا من الجداول المتكررة. اضغط «إنشاء رحلات هذا اليوم» إذا لم تظهر." />
        ) : (
          <Table head={["الرحلة", "الفترة", "الانطلاق", "الباص", "السائق", "المشرف", "الطلاب", "الحالة"]}>
            {q.data!.map((t) => {
              const c = (s: string) => t.students.filter((x) => x.status === s).length;
              return (
                <tr key={t.id} className="hover:bg-surface">
                  <Td><Link href={`/admin/${school.slug}/trips/${t.id}`} className="font-medium text-brand-700 hover:underline">{t.name}</Link></Td>
                  <Td>{periodLabel[t.period]}</Td>
                  <Td>{fmtTime(t.scheduled_start, school.timezone)}</Td>
                  <Td>{lk.data?.busById.get(t.bus_id ?? "")?.code ?? "—"}</Td>
                  <Td>{lk.data?.staffById.get(t.driver_id ?? "")?.full_name ?? <span className="text-red-600">غير محدد</span>}</Td>
                  <Td>{lk.data?.staffById.get(t.supervisor_id ?? "")?.full_name ?? "—"}</Td>
                  <Td className="whitespace-nowrap text-xs text-ink-muted">{t.students.length} · في الباص {c("boarded")} · غائب {c("absent")}</Td>
                  <Td><Badge tone={tripTone(t.status, t.delay_minutes > 0, t.emergency_active)}>{tripStatusLabel[t.status]}{t.delay_minutes > 0 ? ` · +${t.delay_minutes}د` : ""}</Badge></Td>
                </tr>
              );
            })}
          </Table>
        )}
    </>
  );
}

function Routes() {
  const { school } = useSchool();
  const sb = supabaseBrowser();
  const lk = useLookups(school.id);
  const q = useQuery(async () => must(await sb.from("routes").select("*, stops:route_stops(count), students:route_students(count)")
    .eq("school_id", school.id).order("period").order("departure_time")) as (Route & { stops: { count: number }[]; students: { count: number }[] })[], [school.id]);

  if (q.loading && !q.data) return <PageLoading />;
  if (q.error) return <ErrorState message={q.error.message} onRetry={() => q.reload()} />;
  if (q.data!.length === 0) return (
    <EmptyState icon={RouteIcon} title="لا توجد جداول رحلات بعد" body="أنشئ رحلة متكررة: حدد الباص والسائق والمشرف ونقاط التوقف والطلاب وأيام الأسبوع."
      action={<Link href={`/admin/${school.slug}/trips/routes/new`}><Button><Plus className="size-4" />رحلة متكررة جديدة</Button></Link>} />
  );
  return (
    <Table head={["الرحلة", "الفترة", "الانطلاق", "الأيام", "الباص", "السائق", "التوقفات", "الطلاب", ""]}>
      {q.data!.map((r) => (
        <tr key={r.id} className={cn("hover:bg-surface", !r.active && "opacity-60")}>
          <Td><Link href={`/admin/${school.slug}/trips/routes/${r.id}`} className="font-medium text-brand-700 hover:underline">{r.name}</Link></Td>
          <Td>{periodLabel[r.period]}</Td>
          <Td>{r.departure_time.slice(0, 5)}</Td>
          <Td className="text-xs">{r.weekdays.length === 7 ? "يوميًا" : r.weekdays.map((d) => weekdayLabels[d]).join("، ")}</Td>
          <Td>{lk.data?.busById.get(r.bus_id ?? "")?.code ?? "—"}</Td>
          <Td>{lk.data?.staffById.get(r.driver_id ?? "")?.full_name ?? "—"}</Td>
          <Td>{r.stops[0]?.count ?? 0}</Td>
          <Td>{r.students[0]?.count ?? 0}</Td>
          <Td>{!r.active && <Badge tone="gray">موقوفة</Badge>}</Td>
        </tr>
      ))}
    </Table>
  );
}
