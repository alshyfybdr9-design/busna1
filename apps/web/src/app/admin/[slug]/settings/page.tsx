"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { UserPlus } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/use-query";
import { toAppError } from "@/lib/errors";
import { fmtDate } from "@/lib/format";
import type { MemberRole } from "@/lib/types";
import { useSchool } from "@/components/admin/school-context";
import { PageHeader } from "@/components/admin/shell";
import { InstitutionsSection } from "@/components/admin/institutions";
import { BusMap } from "@/components/map/bus-map";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { ErrorState, PageLoading } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";

const roleLabel: Record<MemberRole, string> = { owner: "مالك", admin: "مدير", viewer: "مشاهدة فقط" };

export default function SettingsPage() {
  const { school, canEdit, role } = useSchool();
  const sb = supabaseBrowser();
  const toast = useToast();
  const router = useRouter();
  const [f, setF] = useState({
    name: school.name, name_en: school.name_en ?? "", logo_url: school.logo_url ?? "", primary_color: school.primary_color,
    city: school.city ?? "", address: school.address ?? "", lat: school.lat, lng: school.lng,
    approach_radius_m: school.settings?.approach_radius_m ?? 700, late_threshold_min: school.settings?.late_threshold_min ?? 10,
    school_start_time: (school.settings as { school_start_time?: string })?.school_start_time ?? "07:00",
  });
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  async function save() {
    if (f.name.trim().length < 2) return toast.error("اسم المدرسة مطلوب");
    if (!/^#[0-9a-f]{6}$/i.test(f.primary_color)) return toast.error("اللون يجب أن يكون بصيغة #RRGGBB");
    setBusy(true);
    const { error } = await sb.from("schools").update({
      name: f.name.trim(), name_en: f.name_en || null, logo_url: f.logo_url || null, primary_color: f.primary_color,
      city: f.city || null, address: f.address || null, lat: f.lat, lng: f.lng,
      settings: { ...school.settings, approach_radius_m: Number(f.approach_radius_m), late_threshold_min: Number(f.late_threshold_min), school_start_time: f.school_start_time },
    }).eq("id", school.id);
    setBusy(false);
    if (error) return toast.error(toAppError(error).message);
    toast.success("تم حفظ الإعدادات");
    router.refresh();
  }

  return (
    <div className="pb-10">
      <PageHeader title="الإعدادات" subtitle="هوية المدرسة وإعدادات التشغيل والفريق" />
      <div className="grid gap-6 px-4 lg:px-8 xl:grid-cols-2">
        <fieldset disabled={!canEdit} className="space-y-6">
          <section className="space-y-4 rounded-2xl border border-line bg-white p-5 shadow-card">
            <h2 className="font-semibold">الهوية</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="اسم المدرسة"><Input value={f.name} onChange={(e) => set("name", e.target.value)} /></Field>
              <Field label="الاسم بالإنجليزية"><Input dir="ltr" value={f.name_en} onChange={(e) => set("name_en", e.target.value)} /></Field>
              <Field label="رابط الشعار" hint="صورة PNG أو SVG مربعة"><Input dir="ltr" value={f.logo_url} onChange={(e) => set("logo_url", e.target.value)} /></Field>
              <Field label="اللون الأساسي">
                <div className="flex gap-2">
                  <input type="color" value={f.primary_color} onChange={(e) => set("primary_color", e.target.value)} className="h-10 w-12 cursor-pointer rounded-lg border border-line" aria-label="اختيار اللون" />
                  <Input dir="ltr" value={f.primary_color} onChange={(e) => set("primary_color", e.target.value)} />
                </div>
              </Field>
            </div>
            <div className="flex items-center gap-3 rounded-xl bg-surface p-3">
              {f.logo_url ? <img src={f.logo_url} alt="" className="size-10 rounded-lg object-contain" /> : <span className="grid size-10 place-items-center rounded-lg font-bold text-white" style={{ background: f.primary_color }}>{f.name[0]}</span>}
              <span className="font-semibold">{f.name}</span>
              <span className="ms-auto rounded-lg px-3 py-1.5 text-sm text-white" style={{ background: f.primary_color }}>معاينة الزر</span>
            </div>
          </section>

          <section className="space-y-4 rounded-2xl border border-line bg-white p-5 shadow-card">
            <h2 className="font-semibold">التشغيل</h2>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="مسافة إشعار الاقتراب (م)" hint="يُشعر ولي الأمر عندما يقترب الباص من نقطة الصعود">
                <Input type="number" min={100} max={5000} step={50} value={f.approach_radius_m} onChange={(e) => set("approach_radius_m", Number(e.target.value))} />
              </Field>
              <Field label="اعتبار الرحلة متأخرة بعد (د)">
                <Input type="number" min={1} max={120} value={f.late_threshold_min} onChange={(e) => set("late_threshold_min", Number(e.target.value))} />
              </Field>
              <Field label="بداية الدوام" hint="لتقرير الالتزام بالوصول">
                <Input type="time" value={f.school_start_time} onChange={(e) => set("school_start_time", e.target.value)} />
              </Field>
            </div>
          </section>

          <section className="space-y-4 rounded-2xl border border-line bg-white p-5 shadow-card">
            <h2 className="font-semibold">موقع المدرسة</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="المدينة"><Input value={f.city} onChange={(e) => set("city", e.target.value)} /></Field>
              <Field label="العنوان"><Input value={f.address} onChange={(e) => set("address", e.target.value)} /></Field>
            </div>
            <BusMap className="h-64 rounded-xl" fitKey="school" center={f.lng && f.lat ? [f.lng, f.lat] : undefined}
              onMapClick={canEdit ? (lat, lng) => setF((x) => ({ ...x, lat: +lat.toFixed(6), lng: +lng.toFixed(6) })) : undefined}
              points={f.lat && f.lng ? [{ id: "s", lat: f.lat, lng: f.lng, label: f.name, kind: "school" }] : []} />
            <p className="text-xs text-ink-soft">انقر على الخريطة لتحديد موقع المدرسة. {f.lat && <span dir="ltr">({f.lat}, {f.lng})</span>}</p>
          </section>
          {canEdit && <Button onClick={save} loading={busy}>حفظ الإعدادات</Button>}
        </fieldset>

        <div className="space-y-6">
          <InstitutionsSection />
          <Team isOwner={role === "owner"} />
        </div>
      </div>
    </div>
  );
}

function Team({ isOwner }: { isOwner: boolean }) {
  const { school } = useSchool();
  const sb = supabaseBrowser();
  const toast = useToast();
  const q = useQuery(async () => must(await sb.rpc("list_school_members", { p_school: school.id })) as
    { user_id: string; email: string; full_name: string | null; role: MemberRole; created_at: string }[], [school.id]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>("admin");
  const [busy, setBusy] = useState(false);

  async function add() {
    setBusy(true);
    const { error } = await sb.rpc("add_school_member", { p_school: school.id, p_email: email, p_role: role });
    setBusy(false);
    if (error) return toast.error(toAppError(error).message);
    toast.success("تمت إضافة العضو");
    setEmail("");
    q.reload(true);
  }
  async function removeMember(userId: string) {
    const { error } = await sb.from("school_members").delete().eq("school_id", school.id).eq("user_id", userId);
    if (error) return toast.error(toAppError(error).message);
    toast.success("تمت إزالة العضو");
    q.reload(true);
  }

  return (
    <section className="h-fit rounded-2xl border border-line bg-white p-5 shadow-card">
      <h2 className="mb-1 font-semibold">فريق لوحة التحكم</h2>
      <p className="mb-4 text-sm text-ink-muted">المدير يعدّل البيانات، والمشاهد يطّلع فقط. السائقون والمشرفون وأولياء الأمور لا يحتاجون إضافة هنا.</p>
      {q.loading && !q.data ? <PageLoading rows={2} /> : q.error ? <ErrorState message={q.error.message} /> : (
        <ul className="mb-4 divide-y divide-line rounded-xl border border-line">
          {q.data!.map((m) => (
            <li key={m.user_id} className="flex items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{m.full_name ?? m.email}</p>
                <p className="truncate text-xs text-ink-soft" dir="ltr">{m.email}</p>
              </div>
              <Badge tone={m.role === "owner" ? "brand" : "neutral"}>{roleLabel[m.role]}</Badge>
              <span className="hidden text-xs text-ink-soft sm:inline">{fmtDate(m.created_at)}</span>
              {isOwner && m.role !== "owner" && <button onClick={() => removeMember(m.user_id)} className="text-xs text-red-600 hover:underline">إزالة</button>}
            </li>
          ))}
        </ul>
      )}
      {isOwner && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="البريد الإلكتروني" className="min-w-48 flex-1"><Input dir="ltr" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="الصلاحية">
            <Select value={role} onChange={(e) => setRole(e.target.value as MemberRole)}>
              <option value="admin">مدير</option><option value="viewer">مشاهدة فقط</option>
            </Select>
          </Field>
          <Button onClick={add} loading={busy} disabled={!email.includes("@")}><UserPlus className="size-4" />إضافة</Button>
        </div>
      )}
    </section>
  );
}
