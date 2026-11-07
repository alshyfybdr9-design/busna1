"use client";
import { useState } from "react";
import { Building2, GraduationCap, Pencil, Plus, School as SchoolIcon } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/use-query";
import { toAppError } from "@/lib/errors";
import type { Institution, InstitutionKind } from "@/lib/types";
import { useSchool } from "@/components/admin/school-context";
import { BusMap } from "@/components/map/bus-map";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { ErrorState, PageLoading } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";

export const institutionKindLabel: Record<InstitutionKind, string> = { school: "مدرسة", university: "جامعة", other: "جهة أخرى" };
const kindIcon: Record<InstitutionKind, typeof SchoolIcon> = { school: SchoolIcon, university: GraduationCap, other: Building2 };

/** Schools / universities served by this tenant (Settings page). */
export function InstitutionsSection() {
  const { school, canEdit } = useSchool();
  const sb = supabaseBrowser();
  const toast = useToast();
  const q = useQuery(async () => must(await sb.from("institutions").select("*").eq("school_id", school.id).order("created_at")) as Institution[], [school.id]);
  const [editing, setEditing] = useState<Institution | "new" | null>(null);
  const activeCount = (q.data ?? []).filter((i) => i.status === "active").length;

  async function toggle(i: Institution) {
    if (i.status === "active" && activeCount <= 1) return toast.error("يجب أن تبقى جهة واحدة فعّالة على الأقل");
    const { error } = await sb.from("institutions").update({ status: i.status === "active" ? "suspended" : "active" }).eq("id", i.id);
    if (error) return toast.error(toAppError(error).message);
    q.reload(true);
  }

  return (
    <section className="h-fit rounded-2xl border border-line bg-white p-5 shadow-card">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h2 className="font-semibold">الجهات المخدومة</h2>
        {canEdit && <Button size="sm" variant="secondary" onClick={() => setEditing("new")}><Plus className="size-4" />إضافة جهة</Button>}
      </div>
      <p className="mb-4 text-sm text-ink-muted">
        المدارس أو الجامعات التي ينقل لها حسابكم. عند وجود أكثر من جهة يظهر اختيار الجهة في الطلاب والرحلات.
      </p>
      {q.loading && !q.data ? <PageLoading rows={2} /> : q.error ? <ErrorState message={q.error.message} onRetry={() => q.reload()} /> : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {q.data!.map((i) => {
            const Icon = kindIcon[i.kind];
            return (
              <li key={i.id} className="flex items-center gap-3 p-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700"><Icon className="size-4" /></span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{i.name}</p>
                  <p className="truncate text-xs text-ink-soft">{institutionKindLabel[i.kind]}{i.city ? ` · ${i.city}` : ""}{i.lat == null ? " · بدون موقع" : ""}</p>
                </div>
                {i.status !== "active" && <Badge tone="gray">موقوفة</Badge>}
                {canEdit && <>
                  <button onClick={() => toggle(i)} className="text-xs text-ink-muted hover:underline">{i.status === "active" ? "إيقاف" : "تفعيل"}</button>
                  <button onClick={() => setEditing(i)} className="rounded-lg p-1.5 hover:bg-slate-100" aria-label={`تعديل ${i.name}`}><Pencil className="size-4" /></button>
                </>}
              </li>
            );
          })}
        </ul>
      )}
      {editing && <InstitutionDialog institution={editing === "new" ? null : editing} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); q.reload(true); }} />}
    </section>
  );
}

function InstitutionDialog({ institution, onClose, onSaved }: { institution: Institution | null; onClose: () => void; onSaved: () => void }) {
  const { school } = useSchool();
  const sb = supabaseBrowser();
  const toast = useToast();
  const [f, setF] = useState({
    name: institution?.name ?? "", kind: institution?.kind ?? ("school" as InstitutionKind), city: institution?.city ?? "",
    address: institution?.address ?? "", lat: institution?.lat ?? null as number | null, lng: institution?.lng ?? null as number | null,
    start_time: institution?.settings?.start_time ?? "07:00",
  });
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  async function save() {
    if (f.name.trim().length < 2) return toast.error("اسم الجهة مطلوب");
    setBusy(true);
    const payload = {
      school_id: school.id, name: f.name.trim(), kind: f.kind, city: f.city || null, address: f.address || null,
      lat: f.lat, lng: f.lng, settings: { ...(institution?.settings ?? {}), start_time: f.start_time },
    };
    const { error } = institution
      ? await sb.from("institutions").update(payload).eq("id", institution.id)
      : await sb.from("institutions").insert(payload);
    setBusy(false);
    if (error) return toast.error(toAppError(error).message);
    toast.success(institution ? "تم حفظ الجهة" : "تمت إضافة الجهة");
    onSaved();
  }

  return (
    <Dialog open onClose={onClose} title={institution ? "تعديل الجهة" : "إضافة جهة"} size="lg"
      footer={<><Button onClick={save} loading={busy}>حفظ</Button><Button variant="secondary" onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="اسم الجهة"><Input value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="مثال: جامعة الملك سعود — المدينة الجامعية" /></Field>
        <Field label="النوع">
          <Select value={f.kind} onChange={(e) => set("kind", e.target.value as InstitutionKind)}>
            {Object.entries(institutionKindLabel).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
        </Field>
        <Field label="المدينة"><Input value={f.city} onChange={(e) => set("city", e.target.value)} /></Field>
        <Field label="بداية الدوام" hint="لتقرير الالتزام بالوصول"><Input type="time" value={f.start_time} onChange={(e) => set("start_time", e.target.value)} /></Field>
        <Field label="العنوان" className="sm:col-span-2"><Input value={f.address} onChange={(e) => set("address", e.target.value)} /></Field>
      </div>
      <BusMap className="mt-4 h-56 rounded-xl" fitKey={`inst-${institution?.id ?? "new"}`}
        center={f.lng != null && f.lat != null ? [f.lng, f.lat] : school.lng != null && school.lat != null ? [school.lng, school.lat] : undefined}
        onMapClick={(lat, lng) => setF((x) => ({ ...x, lat: +lat.toFixed(6), lng: +lng.toFixed(6) }))}
        points={f.lat != null && f.lng != null ? [{ id: "i", lat: f.lat, lng: f.lng, label: f.name || "الجهة", kind: "school" }] : []} />
      <p className="mt-2 text-xs text-ink-soft">انقر على الخريطة لتحديد موقع الجهة (نقطة الوصول للرحلات الصباحية).</p>
    </Dialog>
  );
}
