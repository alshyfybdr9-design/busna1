import type { AttendanceStatus, BusStatus, IncidentCategory, IncidentSeverity, TripPeriod, TripStatus } from "./types";

// Latin digits read better for plates, phone numbers and times.
const LOCALE = "ar-SA-u-nu-latn-ca-gregory";
export const DEFAULT_TZ = "Asia/Riyadh";

export function fmtTime(iso: string | null | undefined, tz = DEFAULT_TZ): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(LOCALE, { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(iso));
}

export function fmtDate(iso: string | null | undefined, tz = DEFAULT_TZ): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(LOCALE, { weekday: "long", day: "numeric", month: "long", timeZone: tz }).format(
    new Date(iso.length === 10 ? iso + "T12:00:00Z" : iso),
  );
}

export function fmtDateTime(iso: string | null | undefined, tz = DEFAULT_TZ): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(LOCALE, {
    day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: tz,
  }).format(new Date(iso));
}

/** "منذ ٣ دقائق" style relative time. */
export function fmtAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 15) return "الآن";
  if (s < 60) return `قبل ${s} ثانية`;
  const m = Math.round(s / 60);
  if (m < 60) return m === 1 ? "قبل دقيقة" : m === 2 ? "قبل دقيقتين" : `قبل ${m} دقائق`;
  const h = Math.round(m / 60);
  return h === 1 ? "قبل ساعة" : `قبل ${h} ساعات`;
}

export function todayIn(tz = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
}

export function fmtPhone(p: string | null | undefined): string {
  if (!p) return "—";
  const m = p.match(/^\+9665(\d{8})$/);
  return m ? `05${m[1].slice(0, 1)} ${m[1].slice(1, 4)} ${m[1].slice(4)}` : p;
}

export const periodLabel: Record<TripPeriod, string> = { morning: "صباحية", afternoon: "مسائية" };

export const tripStatusLabel: Record<TripStatus, string> = {
  scheduled: "مجدولة",
  started: "بدأت",
  in_progress: "جارية",
  completed: "مكتملة",
  cancelled: "ملغاة",
};

export const attendanceLabel: Record<AttendanceStatus, string> = {
  pending: "لم يصعد",
  boarded: "في الباص",
  absent: "غائب",
  dropped: "نزل",
};

export const busStatusLabel: Record<BusStatus, string> = {
  active: "في الخدمة",
  maintenance: "صيانة",
  out_of_service: "متوقف",
};

export const incidentCategoryLabel: Record<IncidentCategory, string> = {
  breakdown: "عطل في الباص",
  accident: "حادث",
  traffic: "ازدحام مروري",
  student_behavior: "سلوك طالب",
  medical: "حالة صحية",
  other: "أخرى",
};

export const severityLabel: Record<IncidentSeverity, string> = {
  low: "منخفضة",
  medium: "متوسطة",
  high: "عالية",
  critical: "طارئة",
};

export const weekdayLabels = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

export type Tone = "neutral" | "brand" | "blue" | "amber" | "red" | "gray";

export function tripTone(status: TripStatus, delayed = false, emergency = false): Tone {
  if (emergency) return "red";
  if (status === "cancelled") return "gray";
  if (delayed) return "amber";
  if (status === "in_progress" || status === "started") return "brand";
  if (status === "completed") return "blue";
  return "neutral";
}

export function attendanceTone(s: AttendanceStatus): Tone {
  return s === "boarded" ? "brand" : s === "dropped" ? "blue" : s === "absent" ? "red" : "neutral";
}

export const gpsStateLabel: Record<"none" | "live" | "stale" | "offline", string> = {
  none: "لا توجد إشارة",
  live: "مباشر",
  stale: "متأخر",
  offline: "منقطع",
};
export const gpsStateTone = { none: "gray", live: "brand", stale: "amber", offline: "red" } as const;

export const complianceKindLabel: Record<"registration" | "insurance" | "inspection" | "driver_license", string> = {
  registration: "استمارة المركبة",
  insurance: "تأمين المركبة",
  inspection: "الفحص الدوري",
  driver_license: "رخصة القيادة",
};

/** "تنتهي خلال 10 أيام" / "منتهية منذ 3 أيام". */
export function fmtExpiry(daysLeft: number): string {
  if (daysLeft < 0) { const d = -daysLeft; return d === 1 ? "منتهية منذ يوم" : `منتهية منذ ${d} يومًا`; }
  if (daysLeft === 0) return "تنتهي اليوم";
  return daysLeft === 1 ? "تنتهي غدًا" : `تنتهي خلال ${daysLeft} يومًا`;
}
