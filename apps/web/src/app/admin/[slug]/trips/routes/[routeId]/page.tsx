"use client";
import Link from "next/link";
import { use, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowDown, ArrowRight, ArrowUp, MapPin, Search, Trash2 } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/use-query";
import { toAppError } from "@/lib/errors";
import { weekdayLabels } from "@/lib/format";
import type { Route, RouteStop, Student, TripPeriod } from "@/lib/types";
import { useSchool } from "@/components/admin/school-context";
import { useLookups } from "@/components/admin/lookups";
import { BusMap } from "@/components/map/bus-map";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { ErrorState, PageLoading } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/components/ui/cn";

interface StopDraft { key: string; id?: string; name: string; lat: number; lng: number; offset_min: number }
interface Assign { student_id: string; stopKey: string | null }

export default function RouteEditor({ params }: { params: Promise<{ routeId: string }> }) {
  const { routeId } = use(params);
  const isNew = routeId === "new";
  const { school, canEdit } = useSchool();
  const sb = supabaseBrowser();
  const router = useRouter();
  const toast = useToast();
  const lk = useLookups(school.id);

  const q = useQuery(async () => {
    const students = must(await sb.from("students").select("id, full_name, grade, pickup_label, pickup_lat, pickup_lng, bus_id, transport_status")
      .eq("school_id", school.id).eq("transport_status", "active").order("full_name")) as Student[];
    if (isNew) return { route: null, stops: [] as RouteStop[], assigned: [] as { student_id: string; stop_id: string | null }[], students };
    const [route, stops, assigned] = await Promise.all([
      sb.from("routes").select("*").eq("id", routeId).maybeSingle(),
      sb.from("route_stops").select("*").eq("route_id", routeId).order("seq"),
      sb.from("route_students").select("student_id, stop_id").eq("route_id", routeId),
    ]);
    return { route: must(route) as Route | null, stops: must(stops) as RouteStop[], assigned: must(assigned) as { student_id: string; stop_id: string | null }[], students };
  }, [routeId, school.id]);

  const [form, setForm] = useState({
    name: "", period: "morning" as TripPeriod, bus_id: "", driver_id: "", supervisor_id: "", institution_id: "",
    weekdays: [0, 1, 2, 3, 4], departure_time: "06:15", active: true,
    start_label: "", start_lat: "", start_lng: "", end_label: "", end_lat: "", end_lng: "",
  });
  const [stops, setStops] = useState<StopDraft[]>([]);
  const [assign, setAssign] = useState<Assign[]>([]);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // hydrate
  useEffect(() => {
    if (!q.data) return;
    const r = q.data.route;
    const sLat = school.lat?.toString() ?? "", sLng = school.lng?.toString() ?? "";
    if (r) {
      setForm({
        name: r.name, period: r.period, bus_id: r.bus_id ?? "", driver_id: r.driver_id ?? "", supervisor_id: r.supervisor_id ?? "",
        institution_id: r.institution_id,
        weekdays: r.weekdays, departure_time: r.departure_time.slice(0, 5), active: r.active,
        start_label: r.start_label ?? "", start_lat: r.start_lat?.toString() ?? "", start_lng: r.start_lng?.toString() ?? "",
        end_label: r.end_label ?? "", end_lat: r.end_lat?.toString() ?? "", end_lng: r.end_lng?.toString() ?? "",
      });
    } else {
      setForm((f) => ({ ...f, end_label: school.name, end_lat: sLat, end_lng: sLng }));
    }
    const drafts = q.data.stops.map((s) => ({ key: s.id, id: s.id, name: s.name, lat: s.lat, lng: s.lng, offset_min: s.offset_min }));
    setStops(drafts);
    setAssign(q.data.assigned.map((a) => ({ student_id: a.student_id, stopKey: a.stop_id })));
  }, [q.data, school.lat, school.lng, school.name]);

  // Selecting the bus pre-fills its default crew.
  function setBus(busId: string) {
    const b = lk.data?.busById.get(busId);
    setForm((f) => ({ ...f, bus_id: busId,
      driver_id: f.driver_id || b?.default_driver_id || "", supervisor_id: f.supervisor_id || b?.default_supervisor_id || "" }));
  }
  // The school-side end of a route: the selected institution when it has a location, else the tenant's own.
  function placeOf(institutionId: string) {
    const i = lk.data?.institutionById.get(institutionId);
    return i && i.lat != null && i.lng != null
      ? { label: i.name, lat: i.lat.toString(), lng: i.lng.toString() }
      : { label: school.name, lat: school.lat?.toString() ?? "", lng: school.lng?.toString() ?? "" };
  }
  function setInstitution(id: string) {
    // Move the school-side end point with the institution, unless the admin typed a custom one.
    setForm((f) => {
      const prev = placeOf(f.institution_id), next = placeOf(id);
      if (f.period === "morning" && (f.end_label === prev.label || !f.end_label))
        return { ...f, institution_id: id, end_label: next.label, end_lat: next.lat, end_lng: next.lng };
      if (f.period === "afternoon" && (f.start_label === prev.label || !f.start_label))
        return { ...f, institution_id: id, start_label: next.label, start_lat: next.lat, start_lng: next.lng };
      return { ...f, institution_id: id };
    });
  }
  function setPeriod(p: TripPeriod) {
    // Morning ends at school; afternoon starts at school.
    setForm((f) => {
      const sch = placeOf(f.institution_id);
      return p === "morning"
        ? { ...f, period: p, end_label: sch.label, end_lat: sch.lat, end_lng: sch.lng, start_label: f.start_label === sch.label ? "" : f.start_label }
        : { ...f, period: p, start_label: sch.label, start_lat: sch.lat, start_lng: sch.lng, end_label: f.end_label === sch.label ? "" : f.end_label };
    });
  }

  const bus = lk.data?.busById.get(form.bus_id);
  const overCapacity = bus && assign.length > bus.capacity;
  const studentsById = useMemo(() => new Map((q.data?.students ?? []).map((s) => [s.id, s])), [q.data]);
  const assignedSet = new Set(assign.map((a) => a.student_id));
  const candidates = (q.data?.students ?? []).filter((s) => !assignedSet.has(s.id) && (!search || s.full_name.includes(search) || s.pickup_label?.includes(search)));

  function nearestStop(lat: number | null, lng: number | null): string | null {
    if (lat == null || lng == null || stops.length === 0) return null;
    let best: StopDraft | null = null, bestD = Infinity;
    for (const s of stops) { const d = (s.lat - lat) ** 2 + (s.lng - lng) ** 2; if (d < bestD) { bestD = d; best = s; } }
    return best?.key ?? null;
  }

  function move(i: number, dir: -1 | 1) {
    setStops((s) => { const n = [...s]; const j = i + dir; if (j < 0 || j >= n.length) return s; [n[i], n[j]] = [n[j], n[i]]; return n; });
  }

  async function save() {
    if (!form.name.trim()) return toast.error("أدخل اسم الرحلة");
    if (form.weekdays.length === 0) return toast.error("اختر يومًا واحدًا على الأقل");
    if (stops.some((s) => !s.name.trim())) return toast.error("أدخل اسمًا لكل نقطة توقف");
    setSaving(true);
    try {
      const num = (v: string) => (v.trim() === "" ? null : Number(v));
      const payload = {
        name: form.name.trim(), period: form.period, bus_id: form.bus_id || null,
        driver_id: form.driver_id || null, supervisor_id: form.supervisor_id || null, weekdays: [...form.weekdays].sort(),
        institution_id: form.institution_id || null,
        departure_time: form.departure_time, active: form.active,
        start_label: form.start_label || null, start_lat: num(form.start_lat), start_lng: num(form.start_lng),
        end_label: form.end_label || null, end_lat: num(form.end_lat), end_lng: num(form.end_lng),
      };
      // One atomic RPC: route + ordered stops + students. New stops use their
      // client-generated key as id, so student→stop links survive the save.
      const id = must(await sb.rpc("save_route", {
        p_school: school.id,
        p_route_id: isNew ? null : routeId,
        p_route: payload,
        p_stops: stops.map((s) => ({ id: s.key, name: s.name.trim(), lat: s.lat, lng: s.lng, offset_min: s.offset_min })),
        p_students: assign.map((a) => ({ student_id: a.student_id, stop_id: a.stopKey })),
      })) as string;
      toast.success("تم حفظ الرحلة", "تنعكس التغييرات على الرحلات القادمة التي لم تبدأ عند إنشائها.");
      if (isNew) router.replace(`/admin/${school.slug}/trips/routes/${id}`);
      else q.reload(true);
    } catch (err) {
      toast.error(toAppError(err).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setSaving(true);
    const { error } = await sb.from("routes").delete().eq("id", routeId);
    setSaving(false);
    if (error) return toast.error(toAppError(error).message);
    toast.success("تم حذف الرحلة المتكررة");
    router.replace(`/admin/${school.slug}/trips`);
  }

  if (q.loading && !q.data) return <PageLoading rows={6} />;
  if (q.error) return <ErrorState message={q.error.message} onRetry={() => q.reload()} />;
  if (!isNew && !q.data?.route) return <ErrorState message="الرحلة غير موجودة" />;

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const endPoint = form.end_lat && form.end_lng ? { lat: Number(form.end_lat), lng: Number(form.end_lng) } : null;
  const startPoint = form.start_lat && form.start_lng ? { lat: Number(form.start_lat), lng: Number(form.start_lng) } : null;

  return (
    <div className="px-4 pb-28 pt-6 lg:px-8">
      <Link href={`/admin/${school.slug}/trips`} className="mb-3 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink"><ArrowRight className="size-4" />الرحلات</Link>
      <h1 className="mb-6 text-2xl font-bold">{isNew ? "رحلة متكررة جديدة" : form.name}</h1>

      <fieldset disabled={!canEdit} className="grid gap-6 xl:grid-cols-[1fr_1fr]">
        <div className="space-y-6">
          <section className="space-y-4 rounded-2xl border border-line bg-white p-5 shadow-card">
            <h2 className="font-semibold">البيانات الأساسية</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="اسم الرحلة" className="sm:col-span-2"><Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="مثال: النرجس — صباحي" /></Field>
              {lk.data?.multiInstitution && (
                <Field label="الجهة" className="sm:col-span-2">
                  <Select value={form.institution_id || lk.data.institutions[0]?.id} onChange={(e) => setInstitution(e.target.value)}>
                    {lk.data.institutions.filter((i) => i.status === "active" || i.id === form.institution_id).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                  </Select>
                </Field>
              )}
              <Field label="الفترة">
                <Select value={form.period} onChange={(e) => setPeriod(e.target.value as TripPeriod)}>
                  <option value="morning">صباحية (إلى المدرسة)</option><option value="afternoon">مسائية (العودة للمنازل)</option>
                </Select>
              </Field>
              <Field label="وقت الانطلاق"><Input type="time" value={form.departure_time} onChange={(e) => set("departure_time", e.target.value)} /></Field>
              <Field label="الباص">
                <Select value={form.bus_id} onChange={(e) => setBus(e.target.value)}>
                  <option value="">— اختر —</option>
                  {lk.data?.buses.map((b) => <option key={b.id} value={b.id} disabled={b.status !== "active"}>{b.code} · {b.plate_number} (سعة {b.capacity}){b.status !== "active" ? " — غير متاح" : ""}</option>)}
                </Select>
              </Field>
              <Field label="السائق">
                <Select value={form.driver_id} onChange={(e) => set("driver_id", e.target.value)}>
                  <option value="">— اختر —</option>
                  {lk.data?.drivers.filter((d) => d.status === "active").map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}
                </Select>
              </Field>
              <Field label="المشرف">
                <Select value={form.supervisor_id} onChange={(e) => set("supervisor_id", e.target.value)}>
                  <option value="">— بدون —</option>
                  {lk.data?.supervisors.filter((d) => d.status === "active").map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}
                </Select>
              </Field>
              <label className="flex items-center gap-2 self-end pb-2 text-sm">
                <input type="checkbox" checked={form.active} onChange={(e) => set("active", e.target.checked)} className="size-4 accent-brand-600" />فعّالة
              </label>
            </div>
            <div>
              <p className="mb-1.5 text-sm font-medium">أيام التكرار</p>
              <div className="flex flex-wrap gap-1.5">
                {weekdayLabels.map((d, i) => {
                  const on = form.weekdays.includes(i);
                  return (
                    <button key={i} type="button" aria-pressed={on}
                      onClick={() => set("weekdays", on ? form.weekdays.filter((x) => x !== i) : [...form.weekdays, i])}
                      className={cn("rounded-full border px-3 py-1.5 text-sm", on ? "border-brand-500 bg-brand-50 font-medium text-brand-800" : "border-line")}>{d}</button>
                  );
                })}
              </div>
            </div>
          </section>

          <section className="space-y-3 rounded-2xl border border-line bg-white p-5 shadow-card">
            <h2 className="font-semibold">نقطة البداية والنهاية</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="البداية"><Input value={form.start_label} onChange={(e) => set("start_label", e.target.value)} /></Field>
              <Field label="خط العرض"><Input dir="ltr" inputMode="decimal" value={form.start_lat} onChange={(e) => set("start_lat", e.target.value)} /></Field>
              <Field label="خط الطول"><Input dir="ltr" inputMode="decimal" value={form.start_lng} onChange={(e) => set("start_lng", e.target.value)} /></Field>
              <Field label="النهاية"><Input value={form.end_label} onChange={(e) => set("end_label", e.target.value)} /></Field>
              <Field label="خط العرض"><Input dir="ltr" inputMode="decimal" value={form.end_lat} onChange={(e) => set("end_lat", e.target.value)} /></Field>
              <Field label="خط الطول"><Input dir="ltr" inputMode="decimal" value={form.end_lng} onChange={(e) => set("end_lng", e.target.value)} /></Field>
            </div>
          </section>

          <section className="rounded-2xl border border-line bg-white p-5 shadow-card">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold">الطلاب ({assign.length}{bus ? ` من ${bus.capacity}` : ""})</h2>
            </div>
            {overCapacity && (
              <p role="alert" className="mb-3 flex items-center gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
                <AlertTriangle className="size-4" />عدد الطلاب يتجاوز سعة الباص ({bus!.capacity}).
              </p>
            )}
            <ul className="mb-4 divide-y divide-line rounded-xl border border-line">
              {assign.length === 0 && <li className="p-3 text-center text-sm text-ink-muted">لم يُضف طلاب بعد</li>}
              {assign.map((a) => {
                const s = studentsById.get(a.student_id);
                return (
                  <li key={a.student_id} className="flex items-center gap-2 p-2.5">
                    <span className="min-w-0 flex-1 truncate text-sm">{s?.full_name ?? "طالب غير نشط"}</span>
                    <Select value={a.stopKey ?? ""} onChange={(e) => setAssign((x) => x.map((y) => y.student_id === a.student_id ? { ...y, stopKey: e.target.value || null } : y))}
                      className="h-8 w-44 text-xs" aria-label="نقطة التوقف">
                      <option value="">بدون نقطة</option>
                      {stops.map((st, i) => <option key={st.key} value={st.key}>{i + 1}. {st.name || "—"}</option>)}
                    </Select>
                    <button type="button" onClick={() => setAssign((x) => x.filter((y) => y.student_id !== a.student_id))} className="rounded-lg p-1.5 text-ink-soft hover:bg-red-50 hover:text-red-600" aria-label="إزالة"><Trash2 className="size-4" /></button>
                  </li>
                );
              })}
            </ul>
            <div className="relative">
              <Search className="pointer-events-none absolute start-3 top-2.5 size-4 text-ink-soft" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ابحث عن طالب لإضافته" className="ps-9" />
            </div>
            <ul className="mt-2 max-h-56 overflow-y-auto">
              {candidates.slice(0, 50).map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => setAssign((x) => [...x, { student_id: s.id, stopKey: nearestStop(s.pickup_lat, s.pickup_lng) }])}
                    className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-start text-sm hover:bg-surface">
                    <span>{s.full_name} <span className="text-xs text-ink-soft">{s.grade}</span></span>
                    <span className="text-xs text-ink-soft">{s.pickup_label ?? ""}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div className="space-y-6">
          <section className="overflow-hidden rounded-2xl border border-line bg-white shadow-card xl:sticky xl:top-4">
            <div className="flex items-center justify-between border-b border-line px-5 py-3">
              <h2 className="font-semibold">المسار ونقاط التوقف</h2>
              <span className="text-xs text-ink-soft">انقر على الخريطة لإضافة نقطة</span>
            </div>
            <BusMap className="h-80" fitKey={`${q.data?.route?.id ?? "new"}-${stops.length === 0}`}
              center={school.lng && school.lat ? [school.lng, school.lat] : undefined}
              onMapClick={canEdit ? (lat, lng) => setStops((s) => [...s, { key: crypto.randomUUID(), name: `نقطة ${s.length + 1}`, lat: +lat.toFixed(6), lng: +lng.toFixed(6), offset_min: (s.at(-1)?.offset_min ?? 0) + 5 }]) : undefined}
              path={[...(startPoint ? [[startPoint.lng, startPoint.lat] as [number, number]] : []), ...stops.map((s) => [s.lng, s.lat] as [number, number]), ...(endPoint ? [[endPoint.lng, endPoint.lat] as [number, number]] : [])]}
              points={[
                ...stops.map((s) => ({ id: s.key, lat: s.lat, lng: s.lng, label: s.name, kind: "stop" as const })),
                ...(endPoint ? [{ id: "end", ...endPoint, label: form.end_label, kind: form.period === "morning" ? "school" as const : "stop" as const }] : []),
                ...(startPoint ? [{ id: "start", ...startPoint, label: form.start_label, kind: form.period === "afternoon" ? "school" as const : "stop" as const }] : []),
              ]} />
            <ol className="divide-y divide-line">
              {stops.length === 0 && <li className="flex items-center gap-2 p-4 text-sm text-ink-muted"><MapPin className="size-4" />لا توجد نقاط توقف — انقر على الخريطة لإضافتها بالترتيب.</li>}
              {stops.map((s, i) => (
                <li key={s.key} className="flex items-center gap-2 px-4 py-2.5">
                  <span className="grid size-7 shrink-0 place-items-center rounded-full bg-brand-50 text-xs font-bold text-brand-800">{i + 1}</span>
                  <Input value={s.name} onChange={(e) => setStops((x) => x.map((y) => y.key === s.key ? { ...y, name: e.target.value } : y))} className="h-8" aria-label="اسم النقطة" />
                  <Input type="number" min={0} value={s.offset_min} onChange={(e) => setStops((x) => x.map((y) => y.key === s.key ? { ...y, offset_min: Math.max(0, Number(e.target.value)) } : y))}
                    className="h-8 w-20" aria-label="دقائق بعد الانطلاق" title="دقائق بعد الانطلاق" />
                  <span className="text-xs text-ink-soft">د</span>
                  <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="rounded p-1 text-ink-soft hover:bg-slate-100 disabled:opacity-30" aria-label="لأعلى"><ArrowUp className="size-4" /></button>
                  <button type="button" onClick={() => move(i, 1)} disabled={i === stops.length - 1} className="rounded p-1 text-ink-soft hover:bg-slate-100 disabled:opacity-30" aria-label="لأسفل"><ArrowDown className="size-4" /></button>
                  <button type="button" onClick={() => { setStops((x) => x.filter((y) => y.key !== s.key)); setAssign((x) => x.map((a) => a.stopKey === s.key ? { ...a, stopKey: null } : a)); }}
                    className="rounded p-1 text-ink-soft hover:bg-red-50 hover:text-red-600" aria-label="حذف النقطة"><Trash2 className="size-4" /></button>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </fieldset>

      {canEdit && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-white/95 px-4 py-3 backdrop-blur lg:ps-[276px]">
          <div className="flex flex-wrap gap-2">
            <Button onClick={save} loading={saving}>حفظ</Button>
            <Link href={`/admin/${school.slug}/trips`}><Button variant="secondary" disabled={saving}>إلغاء</Button></Link>
            {!isNew && <Button variant="ghost" className="ms-auto text-red-600" onClick={() => setConfirmDelete(true)}><Trash2 className="size-4" />حذف</Button>}
          </div>
        </div>
      )}
      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={remove} loading={saving} tone="danger"
        title="حذف الرحلة المتكررة؟" confirmLabel="حذف نهائي"
        description="لن تُنشأ رحلات جديدة من هذا الجدول. سجل الرحلات السابقة يبقى محفوظًا. للإيقاف المؤقت استخدم خيار «فعّالة» بدلًا من الحذف." />
    </div>
  );
}
