"use client";
// Excel import/export (SheetJS is loaded on demand to keep pages light).

export async function exportXlsx(rows: Record<string, unknown>[], sheet: string, filename: string) {
  const XLSX = await import("xlsx");
  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = Object.keys(rows[0] ?? {}).map((k) => ({ wch: Math.max(12, k.length + 4) }));
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  XLSX.utils.book_append_sheet(wb, ws, sheet.slice(0, 31));
  XLSX.writeFile(wb, filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`);
}

export async function readXlsx(file: File): Promise<Record<string, unknown>[]> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "", raw: false });
}

/** Maps Arabic (or English) template headers to import field names. */
export const STUDENT_COLUMNS: { key: string; ar: string; aliases: string[]; required?: boolean }[] = [
  { key: "student_number", ar: "الرقم المدرسي", aliases: ["student_number", "رقم الطالب"], required: true },
  { key: "full_name", ar: "اسم الطالب", aliases: ["full_name", "الاسم", "الاسم الكامل"], required: true },
  { key: "grade", ar: "الصف", aliases: ["grade", "الصف الدراسي"] },
  { key: "section", ar: "الفصل", aliases: ["section", "الشعبة"] },
  { key: "guardian_name", ar: "اسم ولي الأمر", aliases: ["guardian_name", "ولي الأمر"] },
  { key: "guardian_phone", ar: "جوال ولي الأمر", aliases: ["guardian_phone", "رقم ولي الأمر", "الجوال"] },
  { key: "relation", ar: "صلة القرابة", aliases: ["relation", "الصلة"] },
  { key: "home_address", ar: "العنوان", aliases: ["home_address", "عنوان المنزل"] },
  { key: "pickup_label", ar: "نقطة الصعود", aliases: ["pickup_label"] },
  { key: "pickup_lat", ar: "خط العرض", aliases: ["pickup_lat", "lat", "latitude"] },
  { key: "pickup_lng", ar: "خط الطول", aliases: ["pickup_lng", "lng", "longitude"] },
  { key: "bus_code", ar: "رقم الباص", aliases: ["bus_code", "الباص"] },
];

export function mapStudentRows(raw: Record<string, unknown>[]): Record<string, string | null>[] {
  return raw.map((r) => {
    const out: Record<string, string | null> = {};
    for (const col of STUDENT_COLUMNS) {
      const header = Object.keys(r).find((h) => {
        const n = h.trim();
        return n === col.ar || col.aliases.includes(n);
      });
      const v = header != null ? String(r[header] ?? "").trim() : "";
      out[col.key] = v === "" ? null : v;
    }
    return out;
  }).filter((r) => Object.values(r).some((v) => v != null));
}

export async function downloadStudentTemplate() {
  await exportXlsx([Object.fromEntries(STUDENT_COLUMNS.map((c) => [c.ar, c.key === "student_number" ? "24001" : c.key === "full_name" ? "محمد عبدالله الحربي" : c.key === "guardian_phone" ? "0551234567" : ""]))],
    "الطلاب", "قالب-استيراد-الطلاب");
}
