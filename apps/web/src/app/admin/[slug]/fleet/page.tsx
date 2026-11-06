"use client";
import { useState } from "react";
import { AlertTriangle, Bus as BusIcon, Pencil, Plus, Trash2 } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/use-query";
import { toAppError } from "@/lib/errors";
import { busStatusLabel, fmtAgo, todayIn } from "@/lib/format";
import type { Bus, BusStatus } from "@/lib/types";
import { useSchool } from "@/components/admin/school-context";
import { PageHeader } from "@/components/admin/shell";
import { useLookups } from "@/components/admin/lookups";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { EmptyState, ErrorState, PageLoading } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/components/ui/cn";

interface Load { bus_id: string; assigned_students: number; over_capacity: boolean }

export default function FleetPage() {
  const { school, canEdit } = useSchool();
  const sb = supabaseBrowser();
  const toast = useToast();
  const lk = useLookups(school.id);
  const q = useQuery(async () => {
    const [load, routes, trips, live] = await Promise.all([
      sb.from("bus_load").select("bus_id, assigned_students, over_capacity").eq("school_id", school.id),
      sb.from("routes").select("id, name, bus_id, period").eq("school_id", school.id).eq("active", true),
      sb.from("trips").select("id, bus_id, status").eq("school_id", school.id).eq("trip_date", todayIn(school.timezone)),
      sb.from("bus_live_positions").select("bus_id, recorded_at").eq("school_id", school.id),
    ]);
    return {
      load: new Map((must(load) as Load[]).map((l) => [l.bus_id, l])),
      routes: must(routes) as { id: string; name: string; bus_id: string | null; period: string }[],
      trips: must(trips) as { id: string; bus_id: string | null; status: string }[],
      live: new Map((must(live) as { bus_id: string; recorded_at: string }[]).map((l) => [l.bus_id, l.recorded_at])),
    };
  }, [school.id]);
  const [editing, setEditing] = useState<Bus | "new" | null>(null);
  const [del, setDel] = useState<Bus | null>(null);
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (!del) return;
    setBusy(true);
    const { error } = await sb.from("buses").delete().eq("id", del.id);
    setBusy(false);
    if (error) return toast.error(toAppError(error).message);
    toast.success("تم حذف الباص");
    setDel(null);
    lk.reload(true); q.reload(true);
  }

  const buses = lk.data?.buses ?? [];
  return (
    <div className="pb-10">
      <PageHeader title="الباصات" subtitle={lk.data ? `${buses.length} مركبة · ${buses.filter((b) => b.status === "active").length} في الخدمة` : undefined}
        actions={canEdit && <Button onClick={() => setEditing("new")}><Plus className="size-4" />إضافة باص</Button>} />
      <div className="px-4 lg:px-8">
        {(lk.loading && !lk.data) || (q.loading && !q.data) ? <PageLoading /> : lk.error || q.error ? <ErrorState message={(lk.error ?? q.error)!.message} onRetry={() => { lk.reload(); q.reload(); }} /> :
          buses.length === 0 ? <EmptyState icon={BusIcon} title="لا توجد باصات" body="أضف أسطول المدرسة لربطه بالسائقين والرحلات." action={canEdit && <Button onClick={() => setEditing("new")}><Plus className="size-4" />إضافة باص</Button>} /> : (
            <ul className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
              {buses.map((b) => {
                const load = q.data!.load.get(b.id);
                const n = load?.assigned_students ?? 0;
                const pct = Math.min(100, Math.round((n / b.capacity) * 100));
                const routes = q.data!.routes.filter((r) => r.bus_id === b.id);
                const activeTrip = q.data!.trips.find((t) => t.bus_id === b.id && (t.status === "started" || t.status === "in_progress"));
                const lastGps = q.data!.live.get(b.id);
                return (
                  <li key={b.id} className="rounded-2xl border border-line bg-white p-4 shadow-card">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-lg font-bold">{b.code}</p>
                        <p className="text-sm text-ink-muted">{b.plate_number} · {b.vehicle_type}{b.model_year ? ` ${b.model_year}` : ""}</p>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <Badge tone={b.status === "active" ? "brand" : b.status === "maintenance" ? "amber" : "gray"}>{busStatusLabel[b.status]}</Badge>
                        {activeTrip && <Badge tone="brand" dot>في رحلة</Badge>}
                      </div>
                    </div>
                    <div className="mt-4">
                      <div className="mb-1 flex justify-between text-xs">
                        <span className="text-ink-muted">الطلاب المخصصون</span>
                        <span className={cn("font-semibold tabular-nums", load?.over_capacity && "text-red-600")}>{n} / {b.capacity}</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-slate-100" role="meter" aria-valuemin={0} aria-valuemax={b.capacity} aria-valuenow={n} aria-label="نسبة الإشغال">
                        <div className={cn("h-full rounded-full", load?.over_capacity ? "bg-red-500" : pct > 90 ? "bg-amber-500" : "bg-brand-500")} style={{ width: `${pct}%` }} />
                      </div>
                      {load?.over_capacity && <p className="mt-1.5 flex items-center gap-1 text-xs font-medium text-red-600"><AlertTriangle className="size-3.5" />تجاوز السعة بـ {n - b.capacity} طالب</p>}
                    </div>
                    <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                      <div><dt className="text-xs text-ink-soft">السائق</dt><dd className="font-medium">{lk.data!.staffById.get(b.default_driver_id ?? "")?.full_name ?? "—"}</dd></div>
                      <div><dt className="text-xs text-ink-soft">المشرف</dt><dd className="font-medium">{lk.data!.staffById.get(b.default_supervisor_id ?? "")?.full_name ?? "—"}</dd></div>
                      <div><dt className="text-xs text-ink-soft">مصدر GPS</dt><dd>{b.gps_source === "device" ? `جهاز تتبع ${b.gps_device_id ?? ""}` : "تطبيق السائق"}</dd></div>
                      <div><dt className="text-xs text-ink-soft">حالة GPS</dt><dd>{lastGps ? `يعمل · ${fmtAgo(lastGps)}` : activeTrip ? <span className="text-amber-600">لا توجد إشارة</span> : "غير نشط (خارج الرحلات)"}</dd></div>
                    </dl>
                    {routes.length > 0 && <p className="mt-3 text-xs text-ink-muted">الرحلات: {routes.map((r) => r.name).join("، ")}</p>}
                    {canEdit && (
                      <div className="mt-4 flex gap-2 border-t border-line pt-3">
                        <Button size="sm" variant="secondary" onClick={() => setEditing(b)}><Pencil className="size-3.5" />تعديل</Button>
                        <Button size="sm" variant="ghost" className="text-red-600" onClick={() => setDel(b)}><Trash2 className="size-3.5" />حذف</Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
      </div>
      {editing && <BusDialog bus={editing === "new" ? null : editing} lk={lk.data} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); lk.reload(true); q.reload(true); }} />}
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} onConfirm={remove} loading={busy} tone="danger" confirmLabel="حذف"
        title={`حذف ${del?.code ?? ""}؟`} description="سيُفك ارتباط الباص بالطلاب والرحلات. سجل الرحلات السابقة يبقى محفوظًا." />
    </div>
  );
}

function BusDialog({ bus, lk, onClose, onSaved }: { bus: Bus | null; lk: ReturnType<typeof useLookups>["data"]; onClose: () => void; onSaved: () => void }) {
  const { school } = useSchool();
  const sb = supabaseBrowser();
  const toast = useToast();
  const [f, setF] = useState({
    code: bus?.code ?? "", plate_number: bus?.plate_number ?? "", vehicle_type: bus?.vehicle_type ?? "حافلة",
    model_year: bus?.model_year?.toString() ?? "", capacity: bus?.capacity?.toString() ?? "24", status: bus?.status ?? "active" as BusStatus,
    default_driver_id: bus?.default_driver_id ?? "", default_supervisor_id: bus?.default_supervisor_id ?? "",
    gps_source: bus?.gps_source ?? "driver_app", gps_device_id: bus?.gps_device_id ?? "", notes: bus?.notes ?? "",
  });
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  async function save() {
    if (!f.code.trim() || !f.plate_number.trim()) return toast.error("رقم الباص واللوحة مطلوبان");
    const cap = Number(f.capacity);
    if (!Number.isInteger(cap) || cap < 1 || cap > 120) return toast.error("السعة يجب أن تكون بين 1 و120");
    setBusy(true);
    const payload = {
      school_id: school.id, code: f.code.trim(), plate_number: f.plate_number.trim(), vehicle_type: f.vehicle_type.trim() || "حافلة",
      model_year: f.model_year ? Number(f.model_year) : null, capacity: cap, status: f.status,
      default_driver_id: f.default_driver_id || null, default_supervisor_id: f.default_supervisor_id || null,
      gps_source: f.gps_source, gps_device_id: f.gps_device_id || null, notes: f.notes || null,
    };
    const { error } = bus ? await sb.from("buses").update(payload).eq("id", bus.id) : await sb.from("buses").insert(payload);
    setBusy(false);
    if (error) return toast.error(toAppError(error).message);
    toast.success(bus ? "تم حفظ التعديلات" : "تمت إضافة الباص");
    onSaved();
  }
  return (
    <Dialog open onClose={onClose} title={bus ? `تعديل ${bus.code}` : "إضافة باص"} size="lg"
      footer={<><Button onClick={save} loading={busy}>حفظ</Button><Button variant="secondary" onClick={onClose}>إلغاء</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="رقم الباص"><Input value={f.code} onChange={(e) => set("code", e.target.value)} placeholder="باص 4" /></Field>
        <Field label="لوحة المركبة"><Input value={f.plate_number} onChange={(e) => set("plate_number", e.target.value)} placeholder="أ ب ج 1234" /></Field>
        <Field label="نوع المركبة"><Input value={f.vehicle_type} onChange={(e) => set("vehicle_type", e.target.value)} /></Field>
        <Field label="سنة الصنع"><Input type="number" value={f.model_year} onChange={(e) => set("model_year", e.target.value)} /></Field>
        <Field label="السعة القصوى"><Input type="number" min={1} max={120} value={f.capacity} onChange={(e) => set("capacity", e.target.value)} /></Field>
        <Field label="حالة المركبة">
          <Select value={f.status} onChange={(e) => set("status", e.target.value as BusStatus)}>
            {Object.entries(busStatusLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="السائق الأساسي">
          <Select value={f.default_driver_id} onChange={(e) => set("default_driver_id", e.target.value)}>
            <option value="">—</option>{lk?.drivers.map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}
          </Select>
        </Field>
        <Field label="المشرف">
          <Select value={f.default_supervisor_id} onChange={(e) => set("default_supervisor_id", e.target.value)}>
            <option value="">—</option>{lk?.supervisors.map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}
          </Select>
        </Field>
        <Field label="مصدر الموقع">
          <Select value={f.gps_source} onChange={(e) => set("gps_source", e.target.value as "driver_app" | "device")}>
            <option value="driver_app">جوال السائق (تطبيق باصنا)</option><option value="device">جهاز تتبع مثبت</option>
          </Select>
        </Field>
        {f.gps_source === "device" && <Field label="معرّف جهاز التتبع"><Input dir="ltr" value={f.gps_device_id} onChange={(e) => set("gps_device_id", e.target.value)} /></Field>}
        <Field label="ملاحظات" className="sm:col-span-2"><Textarea value={f.notes} onChange={(e) => set("notes", e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}
