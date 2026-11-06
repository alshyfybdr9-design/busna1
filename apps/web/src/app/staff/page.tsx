"use client";
import Link from "next/link";
import { useEffect } from "react";
import { Bus, CalendarClock, ChevronLeft, Clock, Users } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/use-query";
import { fmtDate, fmtTime, periodLabel, todayIn, tripStatusLabel, tripTone } from "@/lib/format";
import type { Bus as BusT, Staff, Trip } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorState, PageLoading } from "@/components/ui/states";
import { SignOutButton } from "@/components/sign-out";
import { cn } from "@/components/ui/cn";

interface TripRow extends Trip { bus: Pick<BusT, "code" | "plate_number"> | null; students: { count: number }[] }

export default function StaffHome() {
  const sb = supabaseBrowser();
  const q = useQuery(async () => {
    const { data: { user } } = await sb.auth.getUser();
    const me = must(await sb.from("staff").select("*").eq("user_id", user!.id).eq("status", "active")) as Staff[];
    if (me.length === 0) return { me, trips: [] as TripRow[] };
    const ids = me.map((s) => s.id).join(",");
    const trips = must(await sb.from("trips")
      .select("*, bus:buses(code, plate_number), students:trip_students(count)")
      .eq("trip_date", todayIn())
      .or(`driver_id.in.(${ids}),supervisor_id.in.(${ids})`)
      .order("scheduled_start")) as TripRow[];
    return { me, trips };
  }, []);

  // Keep the list fresh while the app is open.
  useEffect(() => {
    const ch = sb.channel("staff-trips").on("postgres_changes", { event: "*", schema: "public", table: "trips" }, () => q.reload(true)).subscribe();
    return () => { void sb.removeChannel(ch); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (q.loading && !q.data) return <PageLoading />;
  if (q.error) return <ErrorState message={q.error.message} onRetry={() => q.reload()} />;
  const { me, trips } = q.data!;
  const myIds = new Set(me.map((s) => s.id));
  const name = me[0]?.full_name ?? "";
  const active = trips.filter((t) => t.status === "started" || t.status === "in_progress");
  const rest = trips.filter((t) => !active.includes(t));

  return (
    <main className="pb-10">
      <header className="sticky top-0 z-10 border-b border-line bg-white/95 px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))] backdrop-blur">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-ink-muted">مرحبًا</p>
            <h1 className="text-xl font-bold">{name || "—"}</h1>
          </div>
          <SignOutButton compact />
        </div>
        <p className="mt-1 flex items-center gap-1.5 text-sm text-ink-muted"><CalendarClock className="size-4" />{fmtDate(todayIn())}</p>
      </header>

      {me.length === 0 ? (
        <EmptyState icon={Users} title="حسابك غير مرتبط بأي مدرسة" body="اطلب من إدارة المدرسة تسجيل رقم جوالك كسائق أو مشرف." />
      ) : trips.length === 0 ? (
        <EmptyState icon={Bus} title="لا توجد رحلات لك اليوم" body="ستظهر رحلاتك هنا عندما تجدولها إدارة المدرسة." />
      ) : (
        <div className="space-y-6 px-4 pt-4">
          {active.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-semibold text-brand-800">رحلة جارية</h2>
              <ul className="space-y-3">{active.map((t) => <TripCard key={t.id} t={t} role={myIds.has(t.driver_id ?? "") ? "driver" : "supervisor"} highlight />)}</ul>
            </section>
          )}
          {rest.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-semibold text-ink-muted">رحلات اليوم</h2>
              <ul className="space-y-3">{rest.map((t) => <TripCard key={t.id} t={t} role={myIds.has(t.driver_id ?? "") ? "driver" : "supervisor"} />)}</ul>
            </section>
          )}
        </div>
      )}
    </main>
  );
}

function TripCard({ t, role, highlight }: { t: TripRow; role: "driver" | "supervisor"; highlight?: boolean }) {
  const delayed = t.delay_minutes > 0;
  return (
    <li>
      <Link href={`/staff/trip/${t.id}`}
        className={cn("block rounded-2xl border bg-white p-4 shadow-card transition active:scale-[.99]",
          highlight ? "border-brand-300 ring-2 ring-brand-100" : "border-line")}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={tripTone(t.status, delayed, t.emergency_active)} dot={t.status === "in_progress"}>{tripStatusLabel[t.status]}</Badge>
              <Badge>{periodLabel[t.period]}</Badge>
              {delayed && <Badge tone="amber">متأخرة {t.delay_minutes} د</Badge>}
            </div>
            <p className="mt-2 truncate text-lg font-semibold">{t.name}</p>
          </div>
          <ChevronLeft className="mt-1 size-5 shrink-0 text-ink-soft" aria-hidden />
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-sm text-ink-muted">
          <span className="flex items-center gap-1.5"><Clock className="size-4" />{fmtTime(t.scheduled_start)}</span>
          <span className="flex items-center gap-1.5"><Bus className="size-4" />{t.bus?.code ?? "—"}</span>
          <span className="flex items-center gap-1.5"><Users className="size-4" />{t.students?.[0]?.count ?? 0} طالب</span>
        </div>
        <p className="mt-2 text-xs text-ink-soft">دورك: {role === "driver" ? "سائق" : "مشرف"}</p>
      </Link>
    </li>
  );
}
