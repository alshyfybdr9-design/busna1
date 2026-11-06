"use client";
import { useState } from "react";
import { History, Pencil, Plus, UserRound } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/use-query";
import { toAppError } from "@/lib/errors";
import { fmtDate, fmtPhone, fmtTime, periodLabel, tripStatusLabel, tripTone } from "@/lib/format";
import type { Staff, StaffRole, Trip } from "@/lib/types";
import { useSchool } from "@/components/admin/school-context";
import { PageHeader } from "@/components/admin/shell";
import { useLookups } from "@/components/admin/lookups";
import { Table, Td, Toolbar } from "@/components/admin/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { EmptyState, ErrorState, PageLoading } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/components/ui/cn";

export default function StaffPage() {
  const { school, canEdit } = useSchool();
  const lk = useLookups(school.id);
  const [role, setRole] = useState<StaffRole>("driver");
  const [editing, setEditing] = useState<Staff | "new" | null>(null);
  const [history, setHistory] = useState<Staff | null>(null);
  const list = (lk.data?.staff ?? []).filter((s) => s.role === role);
  const busOf = (id: string) => lk.data?.buses.filter((b) => b.default_driver_id === id || b.default_supervisor_id === id).map((b) => b.code).join("، ");

  return (
    <div className="pb-10">
      <PageHeader title="السائقون والمشرفون" subtitle="السائق والمشرف يدخلان التطبيق برقم الجوال المسجّل هنا"
        actions={canEdit && <Button onClick={() => setEditing("new")}><Plus className="size-4" />إضافة {role === "driver" ? "سائق" : "مشرف"}</Button>} />
      <div className="px-4 lg:px-8">
        <Toolbar>
          <div className="inline-flex rounded-xl bg-slate-100 p-1 text-sm" role="tablist">
            {([["driver", "السائقون"], ["supervisor", "المشرفون"]] as const).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={role === k} onClick={() => setRole(k)}
                className={cn("rounded-lg px-4 py-1.5", role === k ? "bg-white font-medium shadow-card" : "text-ink-muted")}>
                {l} ({(lk.data?.staff ?? []).filter((s) => s.role === k).length})
              </button>
            ))}
          </div>
        </Toolbar>
        {lk.loading && !lk.data ? <PageLoading /> : lk.error ? <ErrorState message={lk.error.message} onRetry={() => lk.reload()} /> :
          list.length === 0 ? <EmptyState icon={UserRound} title={role === "driver" ? "لا يوجد سائقون" : "لا يوجد مشرفون"} /> : (
            <Table head={["الاسم", "الجوال", "الباص", role === "driver" ? "الرخصة" : "", "الحساب", "الحالة", ""]}>
              {list.map((s) => {
                const expiring = s.license_expiry && Date.parse(s.license_expiry) < Date.now() + 30 * 864e5;
                return (
                  <tr key={s.id} className="hover:bg-surface">
                    <Td className="font-medium">{s.full_name}</Td>
                    <Td><span dir="ltr">{fmtPhone(s.phone)}</span></Td>
                    <Td>{busOf(s.id) || "—"}</Td>
                    <Td className="text-xs">{role === "driver" ? <>{s.license_number ?? "—"}{s.license_expiry && <span className={cn("block", expiring ? "font-medium text-red-600" : "text-ink-soft")}>تنتهي {fmtDate(s.license_expiry)}</span>}</> : null}</Td>
                    <Td>{s.user_id ? <Badge tone="brand">مفعّل</Badge> : <Badge tone="gray">لم يسجّل الدخول بعد</Badge>}</Td>
                    <Td><Badge tone={s.status === "active" ? "brand" : "amber"}>{s.status === "active" ? "نشط" : "موقوف"}</Badge></Td>
                    <Td className="whitespace-nowrap">
                      <button onClick={() => setHistory(s)} className="rounded-lg p-1.5 hover:bg-slate-100" aria-label="سجل الرحلات"><History className="size-4" /></button>
                      {canEdit && <button onClick={() => setEditing(s)} className="rounded-lg p-1.5 hover:bg-slate-100" aria-label="تعديل"><Pencil className="size-4" /></button>}
                    </Td>
                  </tr>
                );
              })}
            </Table>
          )}
      </div>
      {editing && <StaffDialog staff={editing === "new" ? null : editing} role={role} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); lk.reload(true); }} />}
      {history && <StaffHistory staff={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

function StaffDialog({ staff, role, onClose, onSaved }: { staff: Staff | null; role: StaffRole; onClose: () => void; onSaved: () => void }) {
  const { school } = useSchool();
  const sb = supabaseBrowser();
  const toast = useToast();
  const [f, setF] = useState({
    full_name: staff?.full_name ?? "", phone: staff?.phone ?? "", role: staff?.role ?? role, national_id: staff?.national_id ?? "",
    license_number: staff?.license_number ?? "", license_expiry: staff?.license_expiry ?? "", status: staff?.status ?? "active", notes: staff?.notes ?? "",
  });
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  async function save() {
    if (f.full_name.trim().length < 2 || !/^(\+?966|0)?5\d{8}$/.test(f.phone.replace(/\s/g, ""))) return toast.error("أدخل الاسم ورقم جوال سعودي صحيح");
    setBusy(true);
    const payload = {
      school_id: school.id, full_name: f.full_name.trim(), phone: f.phone.trim(), role: f.role, national_id: f.national_id || null,
      license_number: f.license_number || null, license_expiry: f.license_expiry || null, status: f.status, notes: f.notes || null,
    };
    const { error } = staff ? await sb.from("staff").update(payload).eq("id", staff.id) : await sb.from("staff").insert(payload);
    setBusy(false);
    if (error) return toast.error(toAppError(error).message);
    toast.success(staff ? "تم حفظ التعديلات" : "تمت الإضافة", staff ? undefined : "يمكنه الآن الدخول برقم الجوال عبر رمز التحقق");
    onSaved();
  }
  return (
    <Dialog open onClose={onClose} title={staff ? `تعديل ${staff.full_name}` : f.role === "driver" ? "إضافة سائق" : "إضافة مشرف"} size="lg"
      footer={<><Button onClick={save} loading={busy}>حفظ</Button><Button variant="secondary" onClick={onClose}>إلغاء</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="الاسم الكامل"><Input value={f.full_name} onChange={(e) => set("full_name", e.target.value)} /></Field>
        <Field label="رقم الجوال"><Input dir="ltr" inputMode="tel" value={f.phone} onChange={(e) => set("phone", e.target.value)} placeholder="05XXXXXXXX" /></Field>
        <Field label="الدور">
          <Select value={f.role} onChange={(e) => set("role", e.target.value as StaffRole)} disabled={!!staff}>
            <option value="driver">سائق</option><option value="supervisor">مشرف</option>
          </Select>
        </Field>
        <Field label="رقم الهوية / الإقامة"><Input dir="ltr" value={f.national_id} onChange={(e) => set("national_id", e.target.value)} /></Field>
        {f.role === "driver" && <>
          <Field label="رقم الرخصة"><Input dir="ltr" value={f.license_number} onChange={(e) => set("license_number", e.target.value)} /></Field>
          <Field label="تاريخ انتهاء الرخصة"><Input type="date" value={f.license_expiry} onChange={(e) => set("license_expiry", e.target.value)} /></Field>
        </>}
        <Field label="الحالة" hint="الموقوف لا يستطيع الدخول للتطبيق ولا تنفيذ الرحلات">
          <Select value={f.status} onChange={(e) => set("status", e.target.value as "active" | "suspended")}>
            <option value="active">نشط</option><option value="suspended">موقوف</option>
          </Select>
        </Field>
        <Field label="ملاحظات" className="sm:col-span-2"><Textarea value={f.notes} onChange={(e) => set("notes", e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}

function StaffHistory({ staff, onClose }: { staff: Staff; onClose: () => void }) {
  const { school } = useSchool();
  const sb = supabaseBrowser();
  const q = useQuery(async () => {
    const col = staff.role === "driver" ? "driver_id" : "supervisor_id";
    const trips = must(await sb.from("trips").select("*").eq(col, staff.id).order("trip_date", { ascending: false }).order("scheduled_start", { ascending: false }).limit(60)) as Trip[];
    return trips;
  }, [staff.id]);
  const tz = school.timezone;
  const rows = q.data ?? [];
  const done = rows.filter((t) => t.status === "completed");
  const onTime = done.filter((t) => t.started_at && Date.parse(t.started_at) <= Date.parse(t.scheduled_start) + 5 * 60_000).length;
  return (
    <Dialog open onClose={onClose} title={`سجل رحلات ${staff.full_name}`} size="lg"
      description={done.length ? `${done.length} رحلة مكتملة · الالتزام ببدء الرحلة في موعدها ${Math.round((onTime / done.length) * 100)}%` : undefined}>
      {q.loading ? <PageLoading rows={3} /> : q.error ? <ErrorState message={q.error.message} /> : rows.length === 0 ? <p className="py-6 text-center text-sm text-ink-muted">لا توجد رحلات</p> : (
        <ul className="divide-y divide-line text-sm">
          {rows.map((t) => {
            const late = t.started_at ? Math.round((Date.parse(t.started_at) - Date.parse(t.scheduled_start)) / 60_000) : null;
            return (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span><span className="font-medium">{fmtDate(t.trip_date, tz)}</span> <span className="text-ink-muted">· {periodLabel[t.period]} · {t.name}</span></span>
                <span className="flex items-center gap-2 text-xs text-ink-muted">
                  {t.started_at && <>بدأ {fmtTime(t.started_at, tz)}{late != null && late > 5 && <span className="text-amber-700"> (+{late} د)</span>}</>}
                  {t.completed_at && <> · أنهى {fmtTime(t.completed_at, tz)}</>}
                  <Badge tone={tripTone(t.status)}>{tripStatusLabel[t.status]}</Badge>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
