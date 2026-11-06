"use client";
import { useState } from "react";
import { BarChart3, Download, FileText, Play } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { toAppError } from "@/lib/errors";
import { exportXlsx } from "@/lib/excel";
import { todayIn } from "@/lib/format";
import { useSchool } from "@/components/admin/school-context";
import { PageHeader } from "@/components/admin/shell";
import { Table, Td } from "@/components/admin/table";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { EmptyState, ErrorState, PageLoading } from "@/components/ui/states";
import { cn } from "@/components/ui/cn";

const REPORTS = [
  { key: "attendance", title: "حضور الطلاب", desc: "عدد الرحلات والحضور والغياب ونسبة الحضور لكل طالب" },
  { key: "trips", title: "الرحلات اليومية", desc: "كل رحلة: الأوقات المجدولة والفعلية وعدد الطلاب" },
  { key: "delays", title: "تأخر الباصات", desc: "الرحلات المتأخرة ومدة التأخير وسببه" },
  { key: "drivers", title: "السائقون", desc: "الرحلات المنفذة والالتزام بموعد البدء والبلاغات" },
  { key: "buses", title: "استخدام الباصات", desc: "عدد الرحلات ومتوسط الإشغال مقارنة بالسعة" },
  { key: "absences", title: "الطلاب الغائبون", desc: "كل حالة غياب مسجلة مع التاريخ والرحلة" },
  { key: "incidents", title: "الحوادث والمشكلات", desc: "البلاغات المرفوعة من السائقين والمشرفين" },
  { key: "punctuality", title: "الالتزام بمواعيد الوصول", desc: "وصول الرحلات الصباحية قبل بداية الدوام" },
] as const;
type Kind = (typeof REPORTS)[number]["key"];

function shift(date: string, days: number) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export default function ReportsPage() {
  const { school } = useSchool();
  const sb = supabaseBrowser();
  const today = todayIn(school.timezone);
  const [kind, setKind] = useState<Kind>("attendance");
  const [from, setFrom] = useState(shift(today, -6));
  const [to, setTo] = useState(today);
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const report = REPORTS.find((r) => r.key === kind)!;

  async function run(k = kind) {
    setLoading(true); setError(null);
    const { data, error } = await sb.rpc("school_report", { p_school: school.id, p_kind: k, p_from: from, p_to: to });
    setLoading(false);
    if (error) { setError(toAppError(error).message); setRows(null); return; }
    setRows(data as Record<string, unknown>[]);
  }

  const cols = rows?.[0] ? Object.keys(rows[0]) : [];
  const fileName = `${report.title}-${from}-${to}`;

  return (
    <div className="pb-10">
      <PageHeader title="التقارير" subtitle="تقارير النقل المدرسي مع تصدير Excel وPDF" />
      <div className="grid gap-4 px-4 lg:grid-cols-[280px_1fr] lg:px-8">
        <nav className="space-y-1 print:hidden" aria-label="أنواع التقارير">
          {REPORTS.map((r) => (
            <button key={r.key} onClick={() => { setKind(r.key); setRows(null); }}
              className={cn("w-full rounded-xl border px-3 py-2.5 text-start transition",
                kind === r.key ? "border-brand-300 bg-brand-50" : "border-transparent hover:bg-white")}>
              <span className={cn("block text-sm", kind === r.key && "font-semibold text-brand-800")}>{r.title}</span>
              <span className="block text-xs text-ink-soft">{r.desc}</span>
            </button>
          ))}
        </nav>

        <section className="min-w-0">
          <div className="mb-4 flex flex-wrap items-end gap-3 rounded-2xl border border-line bg-white p-4 shadow-card print:hidden">
            <Field label="من"><Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="إلى"><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
            <Field label="فترة سريعة">
              <Select defaultValue="" onChange={(e) => {
                const v = e.target.value; if (!v) return;
                setTo(today);
                setFrom(v === "today" ? today : v === "week" ? shift(today, -6) : v === "month" ? shift(today, -29) : shift(today, -89));
              }}>
                <option value="">—</option><option value="today">اليوم</option><option value="week">آخر 7 أيام</option><option value="month">آخر 30 يومًا</option><option value="quarter">آخر 90 يومًا</option>
              </Select>
            </Field>
            <Button onClick={() => run()} loading={loading}><Play className="size-4 -scale-x-100" />عرض التقرير</Button>
            {rows && rows.length > 0 && (
              <div className="ms-auto flex gap-2">
                <Button variant="secondary" onClick={() => exportXlsx(rows, report.title, fileName)}><Download className="size-4" />Excel</Button>
                <Button variant="secondary" onClick={() => window.print()} title="يفتح نافذة الطباعة — اختر «حفظ كـ PDF»"><FileText className="size-4" />PDF</Button>
              </div>
            )}
          </div>

          {/* Printed header */}
          <div className="mb-4 hidden print:block">
            <p className="text-lg font-bold">{school.name} — {report.title}</p>
            <p className="text-sm">الفترة: {from} إلى {to}</p>
          </div>

          {loading ? <PageLoading /> : error ? <ErrorState message={error} onRetry={() => run()} /> :
            rows == null ? <EmptyState icon={BarChart3} title={report.title} body={`${report.desc}. اختر الفترة ثم اضغط «عرض التقرير».`} /> :
            rows.length === 0 ? <EmptyState icon={BarChart3} title="لا توجد بيانات في هذه الفترة" /> : (
              <>
                <p className="mb-2 text-sm text-ink-muted">{rows.length} سجل</p>
                <Table head={cols} className="print:overflow-visible print:shadow-none">
                  {rows.map((r, i) => (
                    <tr key={i} className="hover:bg-surface">
                      {cols.map((c) => <Td key={c} className="whitespace-nowrap tabular-nums">{r[c] == null || r[c] === "" ? "—" : String(r[c])}</Td>)}
                    </tr>
                  ))}
                </Table>
              </>
            )}
        </section>
      </div>
    </div>
  );
}
