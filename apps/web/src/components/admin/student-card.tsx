"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Printer, RefreshCw } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { toAppError } from "@/lib/errors";
import { studentQrSvg } from "@/lib/student-qr";
import type { Bus, School, Student } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";

export type CardStudent = Pick<Student, "id" | "full_name" | "student_number" | "grade" | "section" | "photo_url" | "bus_id" | "qr_token">;

/**
 * One ID-1 sized card (85.6 × 54 mm, like a bank card), laid out RTL.
 * Sized in mm so it prints at real size.
 */
export function StudentCard({ student, school, bus, qrSvg }: {
  student: CardStudent; school: Pick<School, "name" | "logo_url" | "primary_color">; bus?: Pick<Bus, "code"> | null; qrSvg: string | null;
}) {
  const color = school.primary_color;
  const gradeLine = [student.grade, student.section].filter(Boolean).join(" / ");
  return (
    <div className="student-card flex flex-col overflow-hidden rounded-[3mm] border border-line bg-white text-ink"
      style={{ width: "85.6mm", height: "54mm", printColorAdjust: "exact", WebkitPrintColorAdjust: "exact" }}>
      <div className="flex items-center gap-[2mm] px-[3mm] py-[1.8mm] text-white" style={{ background: color }}>
        {school.logo_url
          ? <img src={school.logo_url} alt="" className="size-[6mm] rounded-[1mm] bg-white object-contain" />
          : <span className="grid size-[6mm] place-items-center rounded-[1mm] bg-white/20 text-[3mm] font-bold">{school.name[0]}</span>}
        <span className="truncate text-[3mm] font-semibold">{school.name}</span>
        <span className="ms-auto shrink-0 text-[2.4mm] opacity-90">بطاقة النقل المدرسي</span>
      </div>
      <div className="flex flex-1 items-center gap-[3mm] px-[3mm] py-[2mm]">
        <div className="flex min-w-0 flex-1 flex-col gap-[1.2mm]">
          <div className="flex items-center gap-[2mm]">
            {student.photo_url
              ? <img src={student.photo_url} alt="" className="size-[11mm] shrink-0 rounded-[1.5mm] object-cover" />
              : <span className="grid size-[11mm] shrink-0 place-items-center rounded-[1.5mm] text-[4.5mm] font-bold"
                  style={{ background: `${color}1A`, color }}>{student.full_name.trim()[0]}</span>}
            <span className="line-clamp-2 text-[3.6mm] font-bold leading-tight">{student.full_name}</span>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-[2mm] gap-y-[0.6mm] text-[2.7mm] leading-tight">
            <dt className="text-ink-soft">الرقم المدرسي</dt><dd className="font-medium" dir="ltr" style={{ textAlign: "right" }}>{student.student_number}</dd>
            {gradeLine && <><dt className="text-ink-soft">الصف</dt><dd className="truncate font-medium">{gradeLine}</dd></>}
            <dt className="text-ink-soft">الباص</dt><dd className="font-medium">{bus?.code ?? "—"}</dd>
          </dl>
        </div>
        <div className="flex shrink-0 flex-col items-center gap-[0.8mm]">
          <div className="size-[26mm] [&>svg]:size-full" aria-label="رمز QR لتسجيل الصعود والنزول"
            dangerouslySetInnerHTML={qrSvg ? { __html: qrSvg } : undefined} />
          <span className="text-[2.2mm] text-ink-soft">امسح عند الصعود والنزول</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Preview + print for one or many students. With one student and edit
 * rights, the admin can also re-issue the QR (the old card stops working).
 */
export function StudentCardsDialog({ students, school, busById, canEdit, onClose, onReissued }: {
  students: CardStudent[];
  school: Pick<School, "name" | "logo_url" | "primary_color">;
  busById: Map<string, Bus> | undefined;
  canEdit: boolean;
  onClose: () => void;
  onReissued?: () => void;
}) {
  const toast = useToast();
  const [list, setList] = useState(students);
  const [svgs, setSvgs] = useState<Map<string, string> | null>(null);
  const [confirmReissue, setConfirmReissue] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mounted, setMounted] = useState(false); // portal target exists only in the browser
  useEffect(() => setMounted(true), []);
  const single = list.length === 1 ? list[0] : null;

  useEffect(() => {
    let alive = true;
    setSvgs(null);
    void Promise.all(list.map(async (s) => [s.id, await studentQrSvg(s.qr_token)] as const))
      .then((pairs) => { if (alive) setSvgs(new Map(pairs)); })
      .catch(() => { if (alive) toast.error("تعذّر إنشاء رمز QR"); });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);

  async function reissue() {
    if (!single) return;
    setBusy(true);
    const { data, error } = await supabaseBrowser().rpc("regenerate_student_qr", { p_student: single.id });
    setBusy(false);
    if (error) return toast.error(toAppError(error).message);
    setList([{ ...single, qr_token: data as string }]);
    setConfirmReissue(false);
    toast.success("تم إصدار رمز جديد", "البطاقة القديمة لم تعد صالحة. اطبع البطاقة الجديدة وسلّمها للطالب.");
    onReissued?.();
  }

  const preview = list.slice(0, 6);
  const card = (s: CardStudent) => (
    <StudentCard key={s.id} student={s} school={school} bus={busById?.get(s.bus_id ?? "")} qrSvg={svgs?.get(s.id) ?? null} />
  );

  return (
    <>
      <Dialog open onClose={onClose} size="lg"
        title={single ? `بطاقة ${single.full_name}` : `بطاقات الطلاب (${list.length})`}
        description="بمقاس البطاقة البنكية (85.6 × 54 مم). يحمل رمز QR معرّفًا سريًا فقط، بلا اسم أو رقم جوال."
        footer={<>
          <Button onClick={() => window.print()} disabled={!svgs}><Printer className="size-4" />طباعة {single ? "البطاقة" : "البطاقات"}</Button>
          {single && canEdit && !confirmReissue && (
            <Button variant="secondary" onClick={() => setConfirmReissue(true)}><RefreshCw className="size-4" />إصدار رمز جديد</Button>
          )}
          {confirmReissue && <>
            <Button variant="warning" onClick={reissue} loading={busy}>تأكيد — إلغاء البطاقة القديمة</Button>
            <Button variant="ghost" onClick={() => setConfirmReissue(false)} disabled={busy}>تراجع</Button>
          </>}
          <Button variant="ghost" onClick={onClose}>إغلاق</Button>
        </>}>
        {confirmReissue && (
          <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
            استخدم هذا عند فقدان البطاقة: سيتوقف الرمز القديم فورًا عن العمل في تطبيق السائق.
          </p>
        )}
        <div className="flex flex-wrap justify-center gap-4">{preview.map(card)}</div>
        {list.length > preview.length && (
          <p className="mt-3 text-center text-sm text-ink-muted">و{list.length - preview.length} بطاقة أخرى ستظهر عند الطباعة.</p>
        )}
      </Dialog>
      {/* Print-only sheet; globals.css hides the rest of the page while it exists. */}
      {mounted && createPortal(
        <div className="print-sheet" aria-hidden>{list.map(card)}</div>,
        document.body,
      )}
    </>
  );
}
