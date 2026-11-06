"use client";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Inbox, Link2, MessageSquare, Pencil, Plus, Search, Trash2, UsersRound } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/use-query";
import { toAppError } from "@/lib/errors";
import { fmtDateTime, fmtPhone } from "@/lib/format";
import type { Guardian, Notification, ParentRequest, Student } from "@/lib/types";
import { useSchool } from "@/components/admin/school-context";
import { PageHeader } from "@/components/admin/shell";
import { Table, Td, Toolbar } from "@/components/admin/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { EmptyState, ErrorState, PageLoading } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/components/ui/cn";

type GRow = Guardian & { children: { relation: string; student: Pick<Student, "id" | "full_name" | "grade"> }[] };
type RRow = ParentRequest & { guardian: { full_name: string; phone: string }; student: { full_name: string } | null };

const kindLabel: Record<ParentRequest["kind"], string> = {
  pickup_change: "تغيير نقطة الصعود", absence_notice: "إبلاغ غياب", contact: "طلب تواصل", complaint: "شكوى", feedback: "ملاحظة",
};
const statusLabel: Record<ParentRequest["status"], [string, "neutral" | "amber" | "brand" | "red"]> = {
  open: ["جديد", "neutral"], in_review: ["قيد المراجعة", "amber"], resolved: ["تمت المعالجة", "brand"], rejected: ["مرفوض", "red"],
};

export default function Page() {
  return <Suspense><ParentsPage /></Suspense>;
}

function ParentsPage() {
  const initial = useSearchParams().get("tab");
  const [tab, setTab] = useState<"list" | "requests" | "log">(initial === "requests" ? "requests" : "list");
  return (
    <div className="pb-10">
      <PageHeader title="أولياء الأمور" subtitle="ولي الأمر يدخل التطبيق برقم الجوال المسجّل ويرى أبناءه المرتبطين فقط" />
      <div className="px-4 lg:px-8">
        <div className="mb-4 inline-flex rounded-xl bg-slate-100 p-1 text-sm" role="tablist">
          {([["list", "أولياء الأمور"], ["requests", "الطلبات والشكاوى"], ["log", "سجل الإشعارات"]] as const).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
              className={cn("rounded-lg px-4 py-1.5", tab === k ? "bg-white font-medium shadow-card" : "text-ink-muted")}>{l}</button>
          ))}
        </div>
        {tab === "list" ? <Guardians /> : tab === "requests" ? <Requests /> : <Log />}
      </div>
    </div>
  );
}

function Guardians() {
  const { school, canEdit } = useSchool();
  const sb = supabaseBrowser();
  const q = useQuery(async () => {
    const [g, s] = await Promise.all([
      sb.from("guardians").select("*, children:student_guardians(relation, student:students(id, full_name, grade))").eq("school_id", school.id).order("full_name"),
      sb.from("students").select("id, full_name, grade").eq("school_id", school.id).order("full_name"),
    ]);
    return { guardians: must(g) as GRow[], students: must(s) as Pick<Student, "id" | "full_name" | "grade">[] };
  }, [school.id]);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<GRow | "new" | null>(null);

  const list = (q.data?.guardians ?? []).filter((g) => !search || g.full_name.includes(search) || g.phone.includes(search.replace(/^0/, "")) || g.children.some((c) => c.student.full_name.includes(search)));
  return (
    <>
      <Toolbar>
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute start-3 top-2.5 size-4 text-ink-soft" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="بحث بالاسم أو الجوال أو اسم الطالب" className="ps-9" />
        </div>
        {canEdit && <Button onClick={() => setEditing("new")}><Plus className="size-4" />إضافة ولي أمر</Button>}
      </Toolbar>
      {q.loading && !q.data ? <PageLoading /> : q.error ? <ErrorState message={q.error.message} onRetry={() => q.reload()} /> :
        list.length === 0 ? <EmptyState icon={UsersRound} title="لا يوجد أولياء أمور" body="يُضاف أولياء الأمور تلقائيًا عند استيراد الطلاب، أو يدويًا من هنا." /> : (
          <Table head={["ولي الأمر", "الجوال", "الأبناء", "التطبيق", "الإشعارات", ""]}>
            {list.map((g) => (
              <tr key={g.id} className={cn("hover:bg-surface", g.status !== "active" && "opacity-60")}>
                <Td className="font-medium">{g.full_name}</Td>
                <Td><span dir="ltr">{fmtPhone(g.phone)}</span>{g.phone_alt && <span dir="ltr" className="block text-xs text-ink-soft">{fmtPhone(g.phone_alt)}</span>}</Td>
                <Td>{g.children.length === 0 ? <span className="text-xs text-amber-700">غير مرتبط بطالب</span> : g.children.map((c) => <span key={c.student.id} className="block text-sm">{c.student.full_name} <span className="text-xs text-ink-soft">({c.relation})</span></span>)}</Td>
                <Td>{g.user_id ? <Badge tone="brand">مفعّل</Badge> : <Badge tone="gray">لم يسجّل بعد</Badge>}</Td>
                <Td className="text-xs">{g.notify_push ? "تطبيق" : ""}{g.notify_push && g.notify_sms ? " + " : ""}{g.notify_sms ? "رسائل SMS" : ""}{!g.notify_push && !g.notify_sms ? "متوقفة" : ""}</Td>
                <Td>{canEdit && <button onClick={() => setEditing(g)} className="rounded-lg p-1.5 hover:bg-slate-100" aria-label="تعديل"><Pencil className="size-4" /></button>}</Td>
              </tr>
            ))}
          </Table>
        )}
      {editing && q.data && <GuardianDialog guardian={editing === "new" ? null : editing} students={q.data.students} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); q.reload(true); }} />}
    </>
  );
}

function GuardianDialog({ guardian, students, onClose, onSaved }: {
  guardian: GRow | null; students: Pick<Student, "id" | "full_name" | "grade">[]; onClose: () => void; onSaved: () => void;
}) {
  const { school } = useSchool();
  const sb = supabaseBrowser();
  const toast = useToast();
  const [f, setF] = useState({
    full_name: guardian?.full_name ?? "", phone: guardian?.phone ?? "", phone_alt: guardian?.phone_alt ?? "", email: guardian?.email ?? "",
    notify_push: guardian?.notify_push ?? true, notify_sms: guardian?.notify_sms ?? false, status: guardian?.status ?? "active",
  });
  const [links, setLinks] = useState(guardian?.children.map((c) => ({ student_id: c.student.id, relation: c.relation })) ?? []);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const name = new Map(students.map((s) => [s.id, s.full_name]));

  async function save() {
    if (f.full_name.trim().length < 2 || !f.phone.trim()) return toast.error("الاسم ورقم الجوال مطلوبان");
    setBusy(true);
    try {
      const payload = { school_id: school.id, full_name: f.full_name.trim(), phone: f.phone.trim(), phone_alt: f.phone_alt || null,
        email: f.email || null, notify_push: f.notify_push, notify_sms: f.notify_sms, status: f.status };
      const id = guardian
        ? (must(await sb.from("guardians").update(payload).eq("id", guardian.id).select("id").single()) as { id: string }).id
        : (must(await sb.from("guardians").insert(payload).select("id").single()) as { id: string }).id;
      const before = new Set(guardian?.children.map((c) => c.student.id) ?? []);
      const after = new Set(links.map((l) => l.student_id));
      const removed = [...before].filter((x) => !after.has(x));
      if (removed.length) must(await sb.from("student_guardians").delete().eq("guardian_id", id).in("student_id", removed));
      if (links.length) must(await sb.from("student_guardians").upsert(links.map((l) => ({ school_id: school.id, guardian_id: id, student_id: l.student_id, relation: l.relation }))));
      toast.success("تم الحفظ");
      onSaved();
    } catch (err) {
      toast.error(toAppError(err).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={guardian ? `تعديل ${guardian.full_name}` : "إضافة ولي أمر"} size="lg"
      footer={<><Button onClick={save} loading={busy}>حفظ</Button><Button variant="secondary" onClick={onClose}>إلغاء</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="الاسم"><Input value={f.full_name} onChange={(e) => set("full_name", e.target.value)} /></Field>
        <Field label="الجوال" hint="رقم الدخول للتطبيق"><Input dir="ltr" inputMode="tel" value={f.phone} onChange={(e) => set("phone", e.target.value)} /></Field>
        <Field label="جوال إضافي"><Input dir="ltr" inputMode="tel" value={f.phone_alt} onChange={(e) => set("phone_alt", e.target.value)} /></Field>
        <Field label="البريد الإلكتروني"><Input dir="ltr" type="email" value={f.email} onChange={(e) => set("email", e.target.value)} /></Field>
        <div className="flex flex-wrap gap-4 sm:col-span-2">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-brand-600" checked={f.notify_push} onChange={(e) => set("notify_push", e.target.checked)} />إشعارات التطبيق</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-brand-600" checked={f.notify_sms} onChange={(e) => set("notify_sms", e.target.checked)} />رسائل SMS</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-brand-600" checked={f.status === "active"} onChange={(e) => set("status", e.target.checked ? "active" : "suspended")} />الحساب نشط</label>
        </div>
        <div className="sm:col-span-2">
          <p className="mb-1.5 text-sm font-medium">الأبناء المرتبطون</p>
          <ul className="mb-2 divide-y divide-line rounded-xl border border-line">
            {links.length === 0 && <li className="p-3 text-center text-sm text-ink-muted">لا يوجد</li>}
            {links.map((l) => (
              <li key={l.student_id} className="flex items-center gap-2 p-2">
                <span className="flex-1 text-sm">{name.get(l.student_id)}</span>
                <Select value={l.relation} onChange={(e) => setLinks((x) => x.map((y) => y.student_id === l.student_id ? { ...y, relation: e.target.value } : y))} className="h-8 w-32 text-xs" aria-label="صلة القرابة">
                  {["الأب", "الأم", "الأخ", "الأخت", "الجد", "الجدة", "ولي أمر"].map((r) => <option key={r}>{r}</option>)}
                </Select>
                <button onClick={() => setLinks((x) => x.filter((y) => y.student_id !== l.student_id))} className="rounded p-1 text-ink-soft hover:text-red-600" aria-label="فك الارتباط"><Trash2 className="size-4" /></button>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="اختر طالبًا">
              <option value="">اختر طالبًا لربطه…</option>
              {students.filter((s) => !links.some((l) => l.student_id === s.id)).map((s) => <option key={s.id} value={s.id}>{s.full_name} — {s.grade ?? ""}</option>)}
            </Select>
            <Button variant="secondary" disabled={!pick} onClick={() => { setLinks((x) => [...x, { student_id: pick, relation: "الأب" }]); setPick(""); }}><Link2 className="size-4" />ربط</Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function Requests() {
  const { school, canEdit } = useSchool();
  const sb = supabaseBrowser();
  const toast = useToast();
  const [filter, setFilter] = useState<"open" | "all">("open");
  const q = useQuery(async () => {
    let qq = sb.from("parent_requests").select("*, guardian:guardians(full_name, phone), student:students(full_name)").eq("school_id", school.id).order("created_at", { ascending: false }).limit(200);
    if (filter === "open") qq = qq.in("status", ["open", "in_review"]);
    return must(await qq) as RRow[];
  }, [school.id, filter]);
  const [active, setActive] = useState<RRow | null>(null);
  const [status, setStatus] = useState<ParentRequest["status"]>("resolved");
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);

  async function respond() {
    if (!active) return;
    setBusy(true);
    const { error } = await sb.rpc("respond_parent_request", { p_id: active.id, p_status: status, p_response: reply });
    setBusy(false);
    if (error) return toast.error(toAppError(error).message);
    toast.success("تم الحفظ", reply.trim() ? "أُرسل الرد لولي الأمر كإشعار" : undefined);
    setActive(null); setReply("");
    q.reload(true);
  }

  return (
    <>
      <Toolbar>
        <Select value={filter} onChange={(e) => setFilter(e.target.value as "open" | "all")} className="w-auto" aria-label="تصفية">
          <option value="open">المفتوحة</option><option value="all">الكل</option>
        </Select>
      </Toolbar>
      {q.loading && !q.data ? <PageLoading /> : q.error ? <ErrorState message={q.error.message} onRetry={() => q.reload()} /> :
        q.data!.length === 0 ? <EmptyState icon={Inbox} title="لا توجد طلبات" body="تصل هنا طلبات وشكاوى أولياء الأمور من التطبيق أو عبر المساعد الذكي." /> : (
          <ul className="space-y-3">
            {q.data!.map((r) => (
              <li key={r.id} className="rounded-2xl border border-line bg-white p-4 shadow-card">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge tone={r.kind === "complaint" ? "red" : "neutral"}>{kindLabel[r.kind]}</Badge>
                    <span className="font-medium">{r.guardian.full_name}</span>
                    {r.student && <span className="text-sm text-ink-muted">· {r.student.full_name}</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-ink-soft">{fmtDateTime(r.created_at, school.timezone)}</span>
                    <Badge tone={statusLabel[r.status][1]}>{statusLabel[r.status][0]}</Badge>
                  </div>
                </div>
                <p className="mt-2 text-sm">{r.body}</p>
                {r.response && <p className="mt-2 rounded-lg bg-surface p-2 text-sm"><span className="font-medium">الرد: </span>{r.response}</p>}
                <div className="mt-3 flex gap-2">
                  <a href={`tel:${r.guardian.phone}`} className="inline-flex h-8 items-center rounded-lg border border-line px-3 text-sm" dir="ltr">{fmtPhone(r.guardian.phone)}</a>
                  {canEdit && <Button size="sm" onClick={() => { setActive(r); setStatus(r.status === "open" ? "resolved" : r.status); setReply(r.response ?? ""); }}><MessageSquare className="size-3.5" />الرد / تحديث الحالة</Button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      <Dialog open={!!active} onClose={() => setActive(null)} title="الرد على الطلب" size="sm"
        footer={<><Button onClick={respond} loading={busy}>حفظ</Button><Button variant="secondary" onClick={() => setActive(null)}>إلغاء</Button></>}>
        <div className="space-y-3">
          <p className="rounded-lg bg-surface p-2 text-sm">{active?.body}</p>
          <Field label="الحالة">
            <Select value={status} onChange={(e) => setStatus(e.target.value as ParentRequest["status"])}>
              {Object.entries(statusLabel).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </Field>
          <Field label="الرد لولي الأمر" hint="يُرسل كإشعار في تطبيق ولي الأمر"><Textarea value={reply} onChange={(e) => setReply(e.target.value)} /></Field>
        </div>
      </Dialog>
    </>
  );
}

function Log() {
  const { school } = useSchool();
  const sb = supabaseBrowser();
  const q = useQuery(async () => must(await sb.from("notifications").select("*, guardian:guardians(full_name)")
    .eq("school_id", school.id).not("guardian_id", "is", null).order("created_at", { ascending: false }).limit(300)) as (Notification & { guardian: { full_name: string } | null })[], [school.id]);
  if (q.loading && !q.data) return <PageLoading />;
  if (q.error) return <ErrorState message={q.error.message} onRetry={() => q.reload()} />;
  if (q.data!.length === 0) return <EmptyState icon={MessageSquare} title="لم تُرسل إشعارات بعد" />;
  return (
    <Table head={["الوقت", "ولي الأمر", "الإشعار", "القراءة"]}>
      {q.data!.map((n) => (
        <tr key={n.id}>
          <Td className="whitespace-nowrap text-xs text-ink-muted">{fmtDateTime(n.created_at, school.timezone)}</Td>
          <Td>{n.guardian?.full_name ?? "—"}</Td>
          <Td><span className="font-medium">{n.title}</span><span className="block text-xs text-ink-muted">{n.body}</span></Td>
          <Td>{n.read_at ? <Badge tone="brand">قُرئ</Badge> : <Badge>لم يُقرأ</Badge>}</Td>
        </tr>
      ))}
    </Table>
  );
}
