"use client";
import { useMemo, useState } from "react";
import {
  AlertTriangle, ArrowLeftRight, Download, FileSpreadsheet, History, MoreHorizontal, Pencil, Plus, Printer, QrCode, Search, Trash2, Upload, Users,
} from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/use-query";
import { toAppError } from "@/lib/errors";
import { downloadStudentTemplate, exportXlsx, mapStudentRows, readXlsx } from "@/lib/excel";
import { attendanceLabel, attendanceTone, fmtDate, fmtDateTime, fmtPhone, fmtTime, periodLabel } from "@/lib/format";
import type { AttendanceStatus, Guardian, Notification, Student, TransportStatus, TripPeriod } from "@/lib/types";
import { useSchool } from "@/components/admin/school-context";
import { PageHeader } from "@/components/admin/shell";
import { StudentCardsDialog } from "@/components/admin/student-card";
import { useLookups } from "@/components/admin/lookups";
import { Table, Td, Toolbar } from "@/components/admin/table";
import { BusMap } from "@/components/map/bus-map";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { EmptyState, ErrorState, PageLoading } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";

type Row = Student & { guardians: { relation: string; guardian: Pick<Guardian, "id" | "full_name" | "phone" | "user_id"> }[] };
const statusLabel: Record<TransportStatus, [string, "brand" | "amber" | "gray"]> = {
  active: ["مشترك", "brand"], suspended: ["موقوف", "amber"], withdrawn: ["منسحب", "gray"],
};

export default function StudentsPage() {
  const { school, canEdit } = useSchool();
  const sb = supabaseBrowser();
  const toast = useToast();
  const lk = useLookups(school.id);
  const q = useQuery(async () => must(await sb.from("students")
    .select("*, guardians:student_guardians(relation, guardian:guardians(id, full_name, phone, user_id))")
    .eq("school_id", school.id).order("full_name")) as Row[], [school.id]);

  const [search, setSearch] = useState("");
  const [grade, setGrade] = useState("");
  const [bus, setBus] = useState("");
  const [inst, setInst] = useState("");
  const [status, setStatus] = useState<"" | TransportStatus>("");
  const [editing, setEditing] = useState<Row | "new" | null>(null);
  const [transfer, setTransfer] = useState<Row | null>(null);
  const [history, setHistory] = useState<Row | null>(null);
  const [del, setDel] = useState<Row | null>(null);
  const [importing, setImporting] = useState(false);
  const [cards, setCards] = useState<Row[] | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const rows = q.data ?? [];
  const grades = useMemo(() => [...new Set(rows.map((r) => r.grade).filter(Boolean))] as string[], [rows]);
  const loadByBus = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r) => r.bus_id && r.transport_status === "active" && m.set(r.bus_id, (m.get(r.bus_id) ?? 0) + 1));
    return m;
  }, [rows]);
  const filtered = rows.filter((r) =>
    (!search || r.full_name.includes(search) || r.student_number.includes(search) || r.guardians.some((g) => g.guardian.phone.includes(search.replace(/^0/, "")))) &&
    (!grade || r.grade === grade) && (!inst || r.institution_id === inst) && (!bus || (bus === "none" ? !r.bus_id : r.bus_id === bus)) && (!status || r.transport_status === status));

  async function setTransport(r: Row, s: TransportStatus) {
    const { error } = await sb.from("students").update({ transport_status: s }).eq("id", r.id);
    if (error) return toast.error(toAppError(error).message);
    toast.success(s === "active" ? "تم تفعيل اشتراك النقل" : "تم إيقاف اشتراك النقل", s !== "active" ? "لن يُضاف الطالب للرحلات الجديدة" : undefined);
    q.reload(true);
  }

  async function remove() {
    if (!del) return;
    setBusy(true);
    const { error } = await sb.from("students").delete().eq("id", del.id);
    setBusy(false);
    if (error) return toast.error(toAppError(error).message);
    toast.success("تم حذف الطالب");
    setDel(null);
    q.reload(true);
  }

  function exportList() {
    void exportXlsx(filtered.map((r) => ({
      "الرقم المدرسي": r.student_number, "اسم الطالب": r.full_name,
      ...(lk.data?.multiInstitution ? { "الجهة": lk.data.institutionById.get(r.institution_id)?.name ?? "" } : {}),
      "الصف": r.grade ?? "", "الفصل": r.section ?? "",
      "الباص": lk.data?.busById.get(r.bus_id ?? "")?.code ?? "", "نقطة الصعود": r.pickup_label ?? "",
      "ولي الأمر": r.guardians.map((g) => g.guardian.full_name).join("، "), "الجوال": r.guardians.map((g) => fmtPhone(g.guardian.phone)).join("، "),
      "حالة الاشتراك": statusLabel[r.transport_status][0],
    })), "الطلاب", `طلاب-${school.slug}`);
  }

  return (
    <div className="pb-10">
      <PageHeader title="الطلاب" subtitle={q.data ? `${rows.filter((r) => r.transport_status === "active").length} طالب مشترك في النقل` : undefined}
        actions={canEdit && <>
          <Button variant="secondary" onClick={() => setImporting(true)}><Upload className="size-4" />استيراد Excel</Button>
          <Button onClick={() => setEditing("new")}><Plus className="size-4" />إضافة طالب</Button>
        </>} />
      <div className="px-4 lg:px-8">
        <Toolbar>
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute start-3 top-2.5 size-4 text-ink-soft" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="بحث بالاسم أو الرقم المدرسي أو الجوال" className="ps-9" />
          </div>
          {lk.data?.multiInstitution && (
            <Select value={inst} onChange={(e) => setInst(e.target.value)} className="w-auto" aria-label="الجهة">
              <option value="">كل الجهات</option>{lk.data.institutions.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </Select>
          )}
          <Select value={grade} onChange={(e) => setGrade(e.target.value)} className="w-auto" aria-label="الصف"><option value="">كل الصفوف</option>{grades.map((g) => <option key={g}>{g}</option>)}</Select>
          <Select value={bus} onChange={(e) => setBus(e.target.value)} className="w-auto" aria-label="الباص">
            <option value="">كل الباصات</option><option value="none">بدون باص</option>
            {lk.data?.buses.map((b) => <option key={b.id} value={b.id}>{b.code}</option>)}
          </Select>
          <Select value={status} onChange={(e) => setStatus(e.target.value as "" | TransportStatus)} className="w-auto" aria-label="الحالة">
            <option value="">كل الحالات</option>{Object.entries(statusLabel).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
          </Select>
          <Button variant="ghost" onClick={exportList} disabled={!filtered.length}><Download className="size-4" />تصدير</Button>
          <Button variant="ghost" onClick={() => setCards(filtered)} disabled={!filtered.length} title="بطاقات الطلاب الظاهرين في القائمة"><Printer className="size-4" />طباعة البطاقات</Button>
        </Toolbar>

        {q.loading && !q.data ? <PageLoading /> : q.error ? <ErrorState message={q.error.message} onRetry={() => q.reload()} /> :
          rows.length === 0 ? (
            <EmptyState icon={Users} title="لا يوجد طلاب بعد" body="أضف الطلاب يدويًا أو استوردهم دفعة واحدة من ملف Excel."
              action={canEdit && <div className="flex gap-2"><Button variant="secondary" onClick={() => setImporting(true)}><Upload className="size-4" />استيراد</Button><Button onClick={() => setEditing("new")}><Plus className="size-4" />إضافة طالب</Button></div>} />
          ) : filtered.length === 0 ? <p className="py-10 text-center text-sm text-ink-muted">لا توجد نتائج مطابقة</p> : (
            <Table head={["الطالب", "الصف", "الباص", "ولي الأمر", "جوال ولي الأمر", "نقطة الصعود", "الاشتراك", ""]}>
              {filtered.map((r) => {
                const b = lk.data?.busById.get(r.bus_id ?? "");
                const over = b && (loadByBus.get(b.id) ?? 0) > b.capacity;
                return (
                  <tr key={r.id} className="hover:bg-surface">
                    <Td>
                      <button onClick={() => setHistory(r)} className="text-start">
                        <span className="block font-medium hover:text-brand-700">{r.full_name}</span>
                        <span className="text-xs text-ink-soft">#{r.student_number}{lk.data?.multiInstitution && ` · ${lk.data.institutionById.get(r.institution_id)?.name ?? ""}`}</span>
                      </button>
                    </Td>
                    <Td className="text-ink-muted">{[r.grade, r.section].filter(Boolean).join(" / ") || "—"}</Td>
                    <Td>{b ? <span className="inline-flex items-center gap-1">{b.code}{over && <AlertTriangle className="size-4 text-amber-500" aria-label="الباص متجاوز السعة" />}</span> : <span className="text-ink-soft">—</span>}</Td>
                    <Td>
                      {r.guardians.length === 0 ? <span className="text-xs text-amber-700">بدون ولي أمر</span> : r.guardians.map((g) => (
                        <span key={g.guardian.id} className="block text-xs">
                          {g.guardian.full_name} <span className="text-ink-soft">({g.relation})</span>
                          {!g.guardian.user_id && <span className="block text-ink-soft">لم يفعّل التطبيق</span>}
                        </span>
                      ))}
                    </Td>
                    <Td>
                      {r.guardians.length === 0 ? <span className="text-ink-soft">—</span> : r.guardians.map((g) => (
                        <a key={g.guardian.id} href={`tel:${g.guardian.phone}`} dir="ltr" className="block text-xs hover:text-brand-700" style={{ textAlign: "right" }}>
                          {fmtPhone(g.guardian.phone)}
                        </a>
                      ))}
                    </Td>
                    <Td className="text-xs">{r.pickup_label ?? "—"}{r.pickup_lat == null && <span className="block text-amber-700">بدون موقع</span>}</Td>
                    <Td><Badge tone={statusLabel[r.transport_status][1]}>{statusLabel[r.transport_status][0]}</Badge></Td>
                    <Td className="relative whitespace-nowrap">
                      <button onClick={() => setCards([r])} className="rounded-lg p-1.5 hover:bg-slate-100" aria-label={`بطاقة ${r.full_name}`} title="بطاقة الطالب (QR)"><QrCode className="size-5" /></button>
                      {canEdit && (
                        <>
                          <button onClick={() => setMenu(menu === r.id ? null : r.id)} className="rounded-lg p-1.5 hover:bg-slate-100" aria-label="إجراءات" aria-expanded={menu === r.id}><MoreHorizontal className="size-5" /></button>
                          {menu === r.id && (
                            <div className="absolute end-4 top-11 z-10 w-48 rounded-xl border border-line bg-white py-1 text-sm shadow-pop" onMouseLeave={() => setMenu(null)}>
                              <MenuItem icon={Pencil} onClick={() => { setEditing(r); setMenu(null); }}>تعديل البيانات</MenuItem>
                              <MenuItem icon={ArrowLeftRight} onClick={() => { setTransfer(r); setMenu(null); }}>نقل إلى باص آخر</MenuItem>
                              <MenuItem icon={History} onClick={() => { setHistory(r); setMenu(null); }}>سجل الحضور والإشعارات</MenuItem>
                              {r.transport_status === "active"
                                ? <MenuItem icon={AlertTriangle} onClick={() => { void setTransport(r, "suspended"); setMenu(null); }}>إيقاف الاشتراك</MenuItem>
                                : <MenuItem icon={Users} onClick={() => { void setTransport(r, "active"); setMenu(null); }}>تفعيل الاشتراك</MenuItem>}
                              <MenuItem icon={Trash2} danger onClick={() => { setDel(r); setMenu(null); }}>حذف</MenuItem>
                            </div>
                          )}
                        </>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </Table>
          )}
      </div>

      {editing && <StudentDialog student={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); q.reload(true); }} lk={lk.data} />}
      {transfer && <TransferDialog student={transfer} lk={lk.data} load={loadByBus} onClose={() => setTransfer(null)} onDone={() => { setTransfer(null); q.reload(true); }} />}
      {history && <HistoryDialog student={history} onClose={() => setHistory(null)} />}
      {cards && <StudentCardsDialog students={cards} school={school} busById={lk.data?.busById} canEdit={canEdit}
        onClose={() => setCards(null)} onReissued={() => q.reload(true)} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} onDone={() => { setImporting(false); q.reload(true); }} />}
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} onConfirm={remove} loading={busy} tone="danger" confirmLabel="حذف نهائي"
        title={`حذف ${del?.full_name ?? ""}؟`}
        description="سيُحذف الطالب وسجل حضوره نهائيًا. إذا كان الطالب سيعود لاحقًا استخدم «إيقاف الاشتراك» بدلًا من الحذف." />
    </div>
  );
}

function MenuItem({ icon: Icon, children, onClick, danger }: { icon: typeof Pencil; children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className={`flex w-full items-center gap-2 px-3 py-2 text-start hover:bg-surface ${danger ? "text-red-600" : ""}`}>
      <Icon className="size-4" />{children}
    </button>
  );
}

function StudentDialog({ student, onClose, onSaved, lk }: {
  student: Row | null; onClose: () => void; onSaved: () => void; lk: ReturnType<typeof useLookups>["data"];
}) {
  const { school } = useSchool();
  const sb = supabaseBrowser();
  const toast = useToast();
  const [f, setF] = useState({
    student_number: student?.student_number ?? "", full_name: student?.full_name ?? "", grade: student?.grade ?? "",
    section: student?.section ?? "", photo_url: student?.photo_url ?? "", home_address: student?.home_address ?? "",
    pickup_label: student?.pickup_label ?? "", pickup_lat: student?.pickup_lat ?? null as number | null,
    pickup_lng: student?.pickup_lng ?? null as number | null, bus_id: student?.bus_id ?? "", notes: student?.notes ?? "",
    institution_id: student?.institution_id ?? lk?.institutions.find((i) => i.status === "active")?.id ?? "",
    guardian_name: "", guardian_phone: "", relation: "الأب",
  });
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  async function save() {
    if (!f.student_number.trim() || f.full_name.trim().length < 2) return toast.error("الرقم المدرسي والاسم مطلوبان");
    setBusy(true);
    try {
      const payload = {
        school_id: school.id, student_number: f.student_number.trim(), full_name: f.full_name.trim(), grade: f.grade || null,
        section: f.section || null, photo_url: f.photo_url || null, home_address: f.home_address || null,
        pickup_label: f.pickup_label || null, pickup_lat: f.pickup_lat, pickup_lng: f.pickup_lng,
        home_lat: f.pickup_lat, home_lng: f.pickup_lng, notes: f.notes || null,
        // omitted => the database keeps the current one / uses the tenant default
        ...(f.institution_id ? { institution_id: f.institution_id } : {}),
      };
      let id = student?.id;
      if (student) {
        must(await sb.from("students").update(payload).eq("id", student.id));
        if ((f.bus_id || null) !== student.bus_id) must(await sb.rpc("transfer_student", { p_student: student.id, p_bus: f.bus_id || null }));
      } else {
        const created = must(await sb.from("students").insert(payload).select("id").single()) as { id: string };
        id = created.id;
        if (f.bus_id) must(await sb.rpc("transfer_student", { p_student: id, p_bus: f.bus_id }));
      }
      if (f.guardian_phone.trim() && id) {
        // Reuse via the import RPC: creates or links the guardian by phone.
        const r = must(await sb.rpc("import_students", { p_school: school.id, p_rows: [{
          student_number: payload.student_number, full_name: payload.full_name,
          guardian_name: f.guardian_name, guardian_phone: f.guardian_phone, relation: f.relation,
        }] })) as { ok: boolean; errors: { error: string }[] };
        if (!r.ok) throw { code: "P0001", message: "invalid", hint: r.errors[0]?.error };
      }
      toast.success(student ? "تم حفظ التعديلات" : "تمت إضافة الطالب");
      onSaved();
    } catch (err) {
      toast.error(toAppError(err).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={student ? "تعديل بيانات الطالب" : "إضافة طالب"} size="lg"
      footer={<><Button onClick={save} loading={busy}>حفظ</Button><Button variant="secondary" onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="الاسم الكامل"><Input value={f.full_name} onChange={(e) => set("full_name", e.target.value)} /></Field>
        <Field label="الرقم المدرسي"><Input value={f.student_number} onChange={(e) => set("student_number", e.target.value)} dir="ltr" /></Field>
        {lk?.multiInstitution && (
          <Field label="الجهة" className="sm:col-span-2">
            <Select value={f.institution_id} onChange={(e) => set("institution_id", e.target.value)}>
              {lk.institutions.filter((i) => i.status === "active" || i.id === f.institution_id).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="الصف"><Input value={f.grade} onChange={(e) => set("grade", e.target.value)} placeholder="الثالث الابتدائي" /></Field>
        <Field label="الفصل"><Input value={f.section} onChange={(e) => set("section", e.target.value)} /></Field>
        <Field label="الباص المخصص">
          <Select value={f.bus_id} onChange={(e) => set("bus_id", e.target.value)}>
            <option value="">بدون</option>{lk?.buses.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.plate_number}</option>)}
          </Select>
        </Field>
        <Field label="رابط الصورة" hint="اختياري"><Input value={f.photo_url} onChange={(e) => set("photo_url", e.target.value)} dir="ltr" /></Field>
        <Field label="عنوان المنزل" className="sm:col-span-2"><Input value={f.home_address} onChange={(e) => set("home_address", e.target.value)} /></Field>
        <Field label="نقطة الصعود (وصف)" className="sm:col-span-2"><Input value={f.pickup_label} onChange={(e) => set("pickup_label", e.target.value)} placeholder="مثال: بوابة المجمع الشمالية" /></Field>
        <div className="sm:col-span-2">
          <p className="mb-1.5 text-sm font-medium">موقع نقطة الصعود على الخريطة <span className="font-normal text-ink-soft">(انقر لتحديده)</span></p>
          <BusMap className="h-56 rounded-xl" fitKey="student"
            center={f.pickup_lng != null && f.pickup_lat != null ? [f.pickup_lng, f.pickup_lat] : school.lng && school.lat ? [school.lng, school.lat] : undefined}
            onMapClick={(lat, lng) => setF((x) => ({ ...x, pickup_lat: +lat.toFixed(6), pickup_lng: +lng.toFixed(6) }))}
            points={f.pickup_lat != null && f.pickup_lng != null ? [{ id: "p", lat: f.pickup_lat, lng: f.pickup_lng, label: f.pickup_label || "نقطة الصعود", kind: "home" }] : []} />
          {f.pickup_lat != null && <p className="mt-1 text-xs text-ink-soft" dir="ltr">{f.pickup_lat}, {f.pickup_lng}</p>}
        </div>
        {!student && (
          <>
            <Field label="اسم ولي الأمر"><Input value={f.guardian_name} onChange={(e) => set("guardian_name", e.target.value)} /></Field>
            <Field label="جوال ولي الأمر" hint="سيتمكن من الدخول لتطبيق ولي الأمر بهذا الرقم"><Input value={f.guardian_phone} onChange={(e) => set("guardian_phone", e.target.value)} dir="ltr" inputMode="tel" placeholder="05XXXXXXXX" /></Field>
          </>
        )}
        <Field label="ملاحظات" className="sm:col-span-2"><Textarea value={f.notes} onChange={(e) => set("notes", e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}

function TransferDialog({ student, lk, load, onClose, onDone }: {
  student: Row; lk: ReturnType<typeof useLookups>["data"]; load: Map<string, number>; onClose: () => void; onDone: () => void;
}) {
  const sb = supabaseBrowser();
  const toast = useToast();
  const [bus, setBus] = useState(student.bus_id ?? "");
  const [busy, setBusy] = useState(false);
  const target = lk?.busById.get(bus);
  const willOverflow = target && bus !== student.bus_id && (load.get(bus) ?? 0) + 1 > target.capacity;
  async function go() {
    setBusy(true);
    const { error } = await sb.rpc("transfer_student", { p_student: student.id, p_bus: bus || null });
    setBusy(false);
    if (error) return toast.error(toAppError(error).message);
    toast.success("تم نقل الطالب", "أُضيف لرحلات الباص الجديد وأُزيل من رحلات الباص السابق التي لم تبدأ.");
    onDone();
  }
  return (
    <Dialog open onClose={onClose} title={`نقل ${student.full_name}`} size="sm"
      footer={<><Button onClick={go} loading={busy} disabled={bus === (student.bus_id ?? "")}>نقل</Button><Button variant="secondary" onClick={onClose}>إلغاء</Button></>}>
      <Field label="الباص الجديد">
        <Select value={bus} onChange={(e) => setBus(e.target.value)}>
          <option value="">بدون باص</option>
          {lk?.buses.map((b) => <option key={b.id} value={b.id} disabled={b.status !== "active"}>{b.code} — {load.get(b.id) ?? 0}/{b.capacity}{b.status !== "active" ? " (غير متاح)" : ""}</option>)}
        </Select>
      </Field>
      {willOverflow && <p role="alert" className="mt-3 flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800"><AlertTriangle className="size-4" />سيتجاوز الباص سعته القصوى ({target!.capacity}).</p>}
    </Dialog>
  );
}

function HistoryDialog({ student, onClose }: { student: Row; onClose: () => void }) {
  const { school } = useSchool();
  const sb = supabaseBrowser();
  const [tab, setTab] = useState<"att" | "notif">("att");
  const q = useQuery(async () => {
    const [att, notifs] = await Promise.all([
      sb.from("trip_students").select("status, boarded_at, dropped_at, drop_place, trip:trips(name, trip_date, period, status)")
        .eq("student_id", student.id).order("updated_at", { ascending: false }).limit(60),
      sb.from("notifications").select("*").eq("student_id", student.id).order("created_at", { ascending: false }).limit(60),
    ]);
    return {
      att: must(att) as unknown as { status: AttendanceStatus; boarded_at: string | null; dropped_at: string | null; drop_place: string | null; trip: { name: string; trip_date: string; period: TripPeriod; status: string } }[],
      notifs: must(notifs) as Notification[],
    };
  }, [student.id]);
  const tz = school.timezone;
  return (
    <Dialog open onClose={onClose} title={student.full_name} description={`#${student.student_number} · ${student.grade ?? ""}`} size="lg">
      <div className="mb-3 inline-flex rounded-xl bg-slate-100 p-1 text-sm">
        <button onClick={() => setTab("att")} className={`rounded-lg px-3 py-1 ${tab === "att" ? "bg-white shadow-card" : ""}`}>سجل الحضور والرحلات</button>
        <button onClick={() => setTab("notif")} className={`rounded-lg px-3 py-1 ${tab === "notif" ? "bg-white shadow-card" : ""}`}>الإشعارات المرسلة</button>
      </div>
      {q.loading ? <PageLoading rows={3} /> : q.error ? <ErrorState message={q.error.message} /> : tab === "att" ? (
        q.data!.att.length === 0 ? <p className="py-6 text-center text-sm text-ink-muted">لا يوجد سجل بعد</p> : (
          <ul className="divide-y divide-line text-sm">
            {q.data!.att.sort((a, b) => b.trip.trip_date.localeCompare(a.trip.trip_date)).map((a, i) => (
              <li key={i} className="flex items-center justify-between gap-3 py-2">
                <span><span className="font-medium">{fmtDate(a.trip.trip_date, tz)}</span> <span className="text-ink-muted">· {periodLabel[a.trip.period]} · {a.trip.name}</span></span>
                <span className="flex items-center gap-2 text-xs text-ink-muted">
                  {a.boarded_at && <>صعد {fmtTime(a.boarded_at, tz)}</>}{a.dropped_at && <> · نزل {fmtTime(a.dropped_at, tz)}</>}
                  <Badge tone={attendanceTone(a.status)}>{attendanceLabel[a.status]}</Badge>
                </span>
              </li>
            ))}
          </ul>
        )
      ) : q.data!.notifs.length === 0 ? <p className="py-6 text-center text-sm text-ink-muted">لا توجد إشعارات</p> : (
        <ul className="divide-y divide-line text-sm">
          {q.data!.notifs.map((n) => (
            <li key={n.id} className="py-2">
              <div className="flex justify-between gap-2"><span className="font-medium">{n.title}</span><span className="text-xs text-ink-soft">{fmtDateTime(n.created_at, tz)}</span></div>
              <p className="text-ink-muted">{n.body}</p>
              <p className="text-xs text-ink-soft">{n.read_at ? `قُرئ ${fmtDateTime(n.read_at, tz)}` : "لم يُقرأ"}</p>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { school } = useSchool();
  const sb = supabaseBrowser();
  const toast = useToast();
  const [rows, setRows] = useState<Record<string, string | null>[] | null>(null);
  const [errors, setErrors] = useState<{ row: number | null; error: string }[]>([]);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);

  async function onFile(file: File) {
    setFileName(file.name);
    setBusy(true);
    try {
      const mapped = mapStudentRows(await readXlsx(file));
      setRows(mapped);
      const r = must(await sb.rpc("import_students", { p_school: school.id, p_rows: mapped, p_dry_run: true })) as { ok: boolean; errors: { row: number | null; error: string }[] };
      setErrors(r.errors);
    } catch (err) {
      setRows(null);
      toast.error(toAppError(err).message);
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (!rows) return;
    setBusy(true);
    const { data, error } = await sb.rpc("import_students", { p_school: school.id, p_rows: rows });
    setBusy(false);
    if (error) return toast.error(toAppError(error).message);
    const r = data as { ok: boolean; created: number; updated: number; guardians_created: number; errors: { row: number; error: string }[] };
    if (!r.ok) { setErrors(r.errors); return; }
    toast.success("تم الاستيراد", `${r.created} طالب جديد · ${r.updated} تحديث · ${r.guardians_created} ولي أمر جديد`);
    onDone();
  }

  return (
    <Dialog open onClose={onClose} title="استيراد الطلاب من Excel" size="lg"
      description="يُحدَّث الطالب الموجود بنفس الرقم المدرسي، ويُربط ولي الأمر برقم جواله. لا يُكتب أي شيء إذا وُجد خطأ في الملف."
      footer={<><Button onClick={run} loading={busy} disabled={!rows || rows.length === 0 || errors.length > 0}>استيراد {rows?.length ?? 0} طالب</Button><Button variant="secondary" onClick={onClose}>إلغاء</Button></>}>
      <div className="space-y-4">
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-line p-8 text-center hover:border-brand-300">
          <FileSpreadsheet className="size-8 text-brand-600" />
          <span className="font-medium">{fileName || "اختر ملف Excel (xlsx)"}</span>
          <span className="text-xs text-ink-soft">العمود الأول للرقم المدرسي ثم اسم الطالب — استخدم القالب لضمان الأعمدة الصحيحة</span>
          <input type="file" accept=".xlsx,.xls,.csv" className="sr-only" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        </label>
        <button onClick={() => void downloadStudentTemplate()} className="text-sm text-brand-700 underline">تحميل قالب الاستيراد</button>
        {rows && errors.length === 0 && <p className="rounded-xl bg-brand-50 px-3 py-2 text-sm text-brand-800">الملف سليم: {rows.length} طالب جاهز للاستيراد.</p>}
        {errors.length > 0 && (
          <div role="alert" className="max-h-60 overflow-y-auto rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            <p className="mb-1 font-semibold">يجب تصحيح الأخطاء التالية ({errors.length}):</p>
            <ul className="list-inside list-disc">{errors.map((e, i) => <li key={i}>{e.row ? `السطر ${e.row + 1}: ` : ""}{e.error}</li>)}</ul>
          </div>
        )}
      </div>
    </Dialog>
  );
}
