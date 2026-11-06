"use client";
import { useEffect, useMemo, useState } from "react";
import {
  Bell, Bus, Clock, Home, MessageCircle, Phone, School, Send, Sparkles, UserRound,
} from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/use-query";
import { toAppError } from "@/lib/errors";
import { fmtAgo, fmtDateTime, fmtPhone, fmtTime } from "@/lib/format";
import type { Guardian, Notification, ParentChild, ParentRequest } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Select, Textarea } from "@/components/ui/field";
import { EmptyState, ErrorState, PageLoading } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { SignOutButton } from "@/components/sign-out";
import { brandVars } from "@/components/brand";
import { AssistantChat } from "@/components/assistant-chat";
import { ParentLiveMap } from "@/components/parent/live-map";
import { childStatus } from "@/components/parent/status";
import { cn } from "@/components/ui/cn";

type Tab = "home" | "alerts" | "assistant" | "requests";
const SELECTED_KEY = "busna:parent:child";

export default function ParentApp() {
  const sb = supabaseBrowser();
  const [tab, setTab] = useState<Tab>("home");
  const [selected, setSelected] = useState<string | null>(null);

  const overview = useQuery(async () => must(await sb.rpc("parent_overview")) as ParentChild[], []);
  const children = overview.data ?? [];
  const child = children.find((c) => c.student_id === selected) ?? children[0];

  useEffect(() => {
    try { setSelected(localStorage.getItem(SELECTED_KEY)); } catch { /* ignore */ }
  }, []);
  const choose = (id: string) => { setSelected(id); try { localStorage.setItem(SELECTED_KEY, id); } catch { /* ignore */ } };

  // Notifications (realtime)
  const notifs = useQuery(async () => must(await sb.from("notifications").select("*").order("created_at", { ascending: false }).limit(100)) as Notification[], []);
  useEffect(() => {
    const ch = sb.channel("parent-notifs")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications" }, () => { notifs.reload(true); overview.reload(true); })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "trips" }, () => overview.reload(true))
      .subscribe();
    const t = setInterval(() => overview.reload(true), 60_000);
    return () => { void sb.removeChannel(ch); clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const unread = (notifs.data ?? []).filter((n) => !n.read_at).length;

  if (overview.loading && !overview.data) return <PageLoading />;
  if (overview.error) return <ErrorState message={overview.error.message} onRetry={() => overview.reload()} />;
  if (!child) {
    return (
      <main className="p-4">
        <div className="flex justify-end"><SignOutButton /></div>
        <EmptyState icon={UserRound} title="لا يوجد أبناء مرتبطون بحسابك" body="تأكد أن المدرسة سجّلت رقم جوالك نفسه الذي دخلت به، أو تواصل مع إدارة المدرسة." />
      </main>
    );
  }

  return (
    <div style={brandVars(child.school.primary_color)} className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 border-b border-line bg-white/95 px-4 pb-3 pt-[max(.75rem,env(safe-area-inset-top))] backdrop-blur">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {child.school.logo_url ? <img src={child.school.logo_url} alt="" className="size-8 rounded-lg object-contain" /> : <School className="size-6 text-brand-600" />}
            <span className="text-sm font-semibold">{child.school.name}</span>
          </div>
          <SignOutButton compact />
        </div>
        {children.length > 1 && (
          <div className="-mx-1 mt-3 flex gap-2 overflow-x-auto px-1 pb-1" role="tablist" aria-label="الأبناء">
            {children.map((c) => (
              <button key={c.student_id} role="tab" aria-selected={c.student_id === child.student_id} onClick={() => choose(c.student_id)}
                className={cn("flex shrink-0 items-center gap-2 rounded-full border py-1 pe-3 ps-1 text-sm transition",
                  c.student_id === child.student_id ? "border-brand-500 bg-brand-50 font-semibold text-brand-800" : "border-line bg-white")}>
                <Avatar name={c.full_name} url={c.photo_url} size="sm" />
                {c.full_name.split(" ")[0]}
              </button>
            ))}
          </div>
        )}
      </header>

      <main className="flex-1 pb-24">
        {tab === "home" && <HomeTab child={child} />}
        {tab === "alerts" && <AlertsTab q={notifs} children={children} />}
        {tab === "assistant" && (
          <AssistantChat endpoint="/api/assistant/parent" context={{ student_id: child.student_id }} className="h-[calc(100dvh-10rem)]"
            intro={`اسألني عن رحلة ${child.full_name.split(" ")[0]} اليوم، أو كيف تتواصل مع المدرسة. أجيب من بيانات النظام الفعلية فقط.`}
            suggestions={["وين الباص الآن؟", `هل ${child.full_name.split(" ")[0]} وصل المدرسة؟`, "ليش الباص متأخر؟", "كيف أغير نقطة الصعود؟", "أبغى أتواصل مع المدرسة"]} />
        )}
        {tab === "requests" && <RequestsTab children={children} defaultChild={child.student_id} />}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-30 mx-auto grid max-w-lg grid-cols-4 border-t border-line bg-white pb-[env(safe-area-inset-bottom)]" aria-label="التنقل">
        {([["home", "الرئيسية", Home], ["alerts", "الإشعارات", Bell], ["assistant", "المساعد", Sparkles], ["requests", "طلباتي", MessageCircle]] as const).map(([k, label, Icon]) => (
          <button key={k} onClick={() => { setTab(k); if (k === "alerts") void markAllRead(sb, notifs.data ?? [], () => notifs.reload(true)); }}
            aria-current={tab === k ? "page" : undefined}
            className={cn("relative flex flex-col items-center gap-0.5 py-2.5 text-xs", tab === k ? "font-semibold text-brand-700" : "text-ink-soft")}>
            <Icon className="size-5" />{label}
            {k === "alerts" && unread > 0 && <span className="absolute end-[30%] top-1.5 min-w-4 rounded-full bg-red-600 px-1 text-[10px] font-bold leading-4 text-white">{unread}</span>}
          </button>
        ))}
      </nav>
    </div>
  );
}

async function markAllRead(sb: ReturnType<typeof supabaseBrowser>, list: Notification[], done: () => void) {
  const ids = list.filter((n) => !n.read_at).map((n) => n.id);
  if (ids.length === 0) return;
  await sb.from("notifications").update({ read_at: new Date().toISOString() }).in("id", ids);
  done();
}

function Avatar({ name, url, size = "md" }: { name: string; url: string | null; size?: "sm" | "md" | "lg" }) {
  const cls = size === "sm" ? "size-7 text-xs" : size === "lg" ? "size-16 text-xl" : "size-10 text-sm";
  const p = name.trim().split(/\s+/);
  return url
    ? <img src={url} alt="" className={cn(cls, "shrink-0 rounded-full object-cover")} />
    : <span className={cn(cls, "grid shrink-0 place-items-center rounded-full bg-brand-100 font-semibold text-brand-800")}>{(p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")}</span>;
}

function HomeTab({ child }: { child: ParentChild }) {
  const status = useMemo(() => childStatus(child), [child]);
  const t = status.trip;
  const tz = child.school.timezone;
  const toneBg = { brand: "from-brand-600 to-brand-700 text-white", blue: "from-sky-600 to-sky-700 text-white", amber: "from-amber-500 to-amber-600 text-white", red: "from-red-600 to-red-700 text-white", neutral: "from-slate-700 to-slate-800 text-white" }[status.tone];

  return (
    <div className="space-y-4 p-4">
      <section className={cn("rounded-3xl bg-gradient-to-bl p-5 shadow-pop", toneBg)} aria-live="polite">
        <div className="flex items-center gap-3">
          <Avatar name={child.full_name} url={child.photo_url} size="lg" />
          <div className="min-w-0">
            <p className="truncate text-lg font-bold">{child.full_name}</p>
            <p className="text-sm opacity-85">{[child.grade, child.section && `فصل ${child.section}`].filter(Boolean).join(" · ")}</p>
          </div>
        </div>
        <p className="mt-5 text-2xl font-bold leading-snug">{status.headline}</p>
        {status.detail && <p className="mt-1 text-sm opacity-90">{status.detail}</p>}
      </section>

      {t && t.status !== "cancelled" && <ParentLiveMap key={child.student_id + t.trip_id} studentId={child.student_id} childName={child.full_name.split(" ")[0]} />}

      {t && (
        <section className="rounded-2xl border border-line bg-white p-4 shadow-card">
          <h2 className="mb-3 font-semibold">تفاصيل الرحلة</h2>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Info icon={Bus} label="الباص" value={t.bus ? `${t.bus.code} · ${t.bus.plate_number}` : "—"} />
            <Info icon={Clock} label="موعد الانطلاق" value={fmtTime(t.scheduled_start, tz)} />
            <Info icon={UserRound} label="السائق" value={t.driver_name ?? "—"} />
            <Info icon={UserRound} label="المشرف" value={t.supervisor?.name ?? "—"} />
            {t.stop_name && <Info icon={Home} label="نقطة الصعود" value={t.stop_name} />}
            {t.stop_planned_at && <Info icon={Clock} label="الوقت المتوقع عند النقطة" value={fmtTime(t.stop_planned_at, tz)} />}
          </dl>
          {t.supervisor?.phone && (
            <a href={`tel:${t.supervisor.phone}`} className="mt-4 flex h-11 items-center justify-center gap-2 rounded-xl border border-line text-sm font-medium hover:bg-surface">
              <Phone className="size-4" />الاتصال بالمشرف <span dir="ltr" className="text-ink-muted">{fmtPhone(t.supervisor.phone)}</span>
            </a>
          )}
        </section>
      )}

      {child.trips.length > 0 && (
        <section className="rounded-2xl border border-line bg-white p-4 shadow-card">
          <h2 className="mb-3 font-semibold">اليوم</h2>
          <ol className="relative space-y-4 border-s-2 border-line ps-5">
            {child.trips.flatMap((tr) => [
              tr.started_at && { at: tr.started_at, text: `بدأت ${tr.period === "morning" ? "الرحلة الصباحية" : "رحلة العودة"}` },
              tr.boarded_at && { at: tr.boarded_at, text: "صعد إلى الباص" },
              tr.dropped_at && { at: tr.dropped_at, text: tr.drop_place === "school" ? "وصل إلى المدرسة" : tr.period === "afternoon" ? "وصل إلى المنزل" : "نزل من الباص" },
              tr.attendance === "absent" && { at: tr.scheduled_start, text: `غائب عن ${tr.period === "morning" ? "الرحلة الصباحية" : "رحلة العودة"}` },
              !tr.started_at && tr.status === "scheduled" && { at: tr.scheduled_start, text: `${tr.period === "morning" ? "الرحلة الصباحية" : "رحلة العودة"} (مجدولة)`, future: true },
            ].filter(Boolean) as { at: string; text: string; future?: boolean }[])
              .sort((a, b) => a.at.localeCompare(b.at))
              .map((e, i) => (
                <li key={i} className="relative">
                  <span className={cn("absolute -start-[1.65rem] top-1 size-3 rounded-full ring-4 ring-white", e.future ? "bg-slate-300" : "bg-brand-600")} />
                  <p className={cn("text-sm", e.future ? "text-ink-muted" : "font-medium")}>{e.text}</p>
                  <p className="text-xs text-ink-soft">{fmtTime(e.at, tz)}</p>
                </li>
              ))}
          </ol>
        </section>
      )}
    </div>
  );
}

function Info({ icon: Icon, label, value }: { icon: typeof Bus; label: string; value: string }) {
  return (
    <div>
      <dt className="flex items-center gap-1 text-xs text-ink-soft"><Icon className="size-3.5" />{label}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
    </div>
  );
}

function AlertsTab({ q, children }: { q: ReturnType<typeof useQuery<Notification[]>>; children: ParentChild[] }) {
  if (q.loading && !q.data) return <PageLoading />;
  if (q.error) return <ErrorState message={q.error.message} onRetry={() => q.reload()} />;
  const list = q.data ?? [];
  if (list.length === 0) return <EmptyState icon={Bell} title="لا توجد إشعارات بعد" body="ستصلك هنا إشعارات بدء الرحلة وصعود ابنك ووصوله." />;
  const names = new Map(children.map((c) => [c.student_id, c.full_name.split(" ")[0]]));
  return (
    <ul className="divide-y divide-line bg-white">
      {list.map((n) => (
        <li key={n.id} className={cn("flex gap-3 px-4 py-3", !n.read_at && "bg-brand-50/50")}>
          <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.read_at ? "bg-transparent" : "bg-brand-600")} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="font-semibold">{n.title}</p>
              <span className="shrink-0 text-xs text-ink-soft">{fmtAgo(n.created_at)}</span>
            </div>
            <p className="text-sm text-ink-muted">{n.body}</p>
            {n.student_id && names.get(n.student_id) && children.length > 1 && <Badge className="mt-1">{names.get(n.student_id)}</Badge>}
          </div>
        </li>
      ))}
    </ul>
  );
}

const kindLabel: Record<ParentRequest["kind"], string> = {
  pickup_change: "تغيير نقطة الصعود",
  absence_notice: "إبلاغ عن غياب",
  contact: "طلب تواصل",
  complaint: "شكوى",
  feedback: "ملاحظة / اقتراح",
};
const statusLabel: Record<ParentRequest["status"], [string, "neutral" | "amber" | "brand" | "red"]> = {
  open: ["جديد", "neutral"], in_review: ["قيد المراجعة", "amber"], resolved: ["تمت المعالجة", "brand"], rejected: ["مرفوض", "red"],
};

function RequestsTab({ children, defaultChild }: { children: ParentChild[]; defaultChild: string }) {
  const sb = supabaseBrowser();
  const toast = useToast();
  const [kind, setKind] = useState<ParentRequest["kind"]>("pickup_change");
  const [studentId, setStudentId] = useState(defaultChild);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const q = useQuery(async () => {
    const { data: { user } } = await sb.auth.getUser();
    const guardians = must(await sb.from("guardians").select("id, school_id").eq("user_id", user!.id)) as Pick<Guardian, "id" | "school_id">[];
    const requests = must(await sb.from("parent_requests").select("*").order("created_at", { ascending: false })) as ParentRequest[];
    return { guardians, requests };
  }, []);

  async function submit() {
    const child = children.find((c) => c.student_id === studentId);
    const g = q.data?.guardians.find((x) => x.school_id === child?.school.id);
    if (!child || !g) return toast.error("تعذّر تحديد ولي الأمر لهذا الطالب");
    setBusy(true);
    const { error } = await sb.from("parent_requests").insert({ school_id: g.school_id, guardian_id: g.id, student_id: studentId, kind, body: body.trim() });
    setBusy(false);
    if (error) return toast.error(toAppError(error).message);
    toast.success("تم إرسال طلبك للمدرسة");
    setBody("");
    q.reload(true);
  }

  return (
    <div className="space-y-4 p-4">
      <section className="rounded-2xl border border-line bg-white p-4 shadow-card">
        <h2 className="mb-3 font-semibold">طلب جديد للمدرسة</h2>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="النوع">
              <Select value={kind} onChange={(e) => setKind(e.target.value as ParentRequest["kind"])}>
                {Object.entries(kindLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field label="الطالب">
              <Select value={studentId} onChange={(e) => setStudentId(e.target.value)}>
                {children.map((c) => <option key={c.student_id} value={c.student_id}>{c.full_name.split(" ")[0]}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="التفاصيل">
            <Textarea value={body} onChange={(e) => setBody(e.target.value)}
              placeholder={kind === "pickup_change" ? "اكتب الموقع الجديد المقترح (اسم الحي/المعلم القريب)" : "اكتب طلبك"} />
          </Field>
          <Button className="w-full" onClick={submit} loading={busy} disabled={!body.trim()}><Send className="size-4 -scale-x-100" />إرسال</Button>
        </div>
      </section>
      {q.data && q.data.requests.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-ink-muted">طلباتي السابقة</h2>
          <ul className="space-y-2">
            {q.data.requests.map((r) => (
              <li key={r.id} className="rounded-2xl border border-line bg-white p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{kindLabel[r.kind]}</span>
                  <Badge tone={statusLabel[r.status][1]}>{statusLabel[r.status][0]}</Badge>
                </div>
                <p className="mt-1 text-sm text-ink-muted">{r.body}</p>
                {r.response && <p className="mt-2 rounded-lg bg-surface p-2 text-sm"><span className="font-medium">رد المدرسة: </span>{r.response}</p>}
                <p className="mt-1 text-xs text-ink-soft">{fmtDateTime(r.created_at)}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
