import { fmtTime } from "@/lib/format";
import type { ParentChild, ParentChildTrip } from "@/lib/types";

export interface ChildStatus {
  tone: "brand" | "blue" | "amber" | "red" | "neutral";
  headline: string;
  detail?: string;
  trip: ParentChildTrip | null;
}

/** The trip that matters right now: active > next upcoming > latest finished. */
export function currentTrip(c: ParentChild): ParentChildTrip | null {
  const active = c.trips.find((t) => t.status === "started" || t.status === "in_progress");
  if (active) return active;
  const upcoming = c.trips.find((t) => t.status === "scheduled");
  const done = [...c.trips].reverse().find((t) => t.status === "completed" || t.status === "cancelled");
  // After the morning trip completes, show its result until the afternoon trip is near.
  if (upcoming && done) {
    const startsIn = new Date(upcoming.scheduled_start).getTime() - Date.now();
    return startsIn < 60 * 60 * 1000 ? upcoming : done;
  }
  return upcoming ?? done ?? null;
}

export function childStatus(c: ParentChild): ChildStatus {
  const first = c.full_name.split(" ")[0];
  if (c.transport_status !== "active") {
    return { tone: "neutral", headline: "الاشتراك في النقل غير مفعّل", detail: "للاستفسار تواصل مع إدارة المدرسة", trip: null };
  }
  const t = currentTrip(c);
  if (!t) return { tone: "neutral", headline: "لا توجد رحلات اليوم", trip: null };
  const tz = c.school.timezone;
  const label = t.period === "morning" ? "الرحلة الصباحية" : "رحلة العودة";

  if (t.status === "cancelled") return { tone: "red", headline: `تم إلغاء ${label}`, detail: t.cancel_reason ?? undefined, trip: t };
  if (t.emergency_active && t.attendance === "boarded")
    return { tone: "red", headline: "تنبيه: مشكلة أثناء الرحلة", detail: "المدرسة تتابع الوضع الآن", trip: t };

  switch (t.attendance) {
    case "boarded":
      return { tone: "brand", headline: `${first} في الباص الآن`, detail: `صعد ${fmtTime(t.boarded_at, tz)}${t.delay_minutes ? ` · الرحلة متأخرة ${t.delay_minutes} دقيقة` : ""}`, trip: t };
    case "dropped":
      return t.drop_place === "school"
        ? { tone: "blue", headline: `وصل ${first} إلى المدرسة بسلام`, detail: fmtTime(t.dropped_at, tz), trip: t }
        : { tone: "blue", headline: t.period === "afternoon" ? `وصل ${first} إلى المنزل` : `نزل ${first} من الباص`, detail: fmtTime(t.dropped_at, tz), trip: t };
    case "absent":
      return { tone: "neutral", headline: `تم تسجيل ${first} غائبًا عن ${label}`, trip: t };
    default:
      if (t.status === "scheduled")
        return { tone: "neutral", headline: `${label} تبدأ ${fmtTime(t.scheduled_start, tz)}`,
          detail: t.stop_planned_at ? `الموعد المتوقع عند ${t.stop_name ?? "نقطة الصعود"}: ${fmtTime(t.stop_planned_at, tz)}` : undefined, trip: t };
      if (t.status === "completed") return { tone: "neutral", headline: `انتهت ${label}`, trip: t };
      return { tone: t.delay_minutes ? "amber" : "brand",
        headline: t.period === "morning" ? `الباص في الطريق إلى ${first}` : `${label} بدأت`,
        detail: t.delay_minutes ? `متأخرة حوالي ${t.delay_minutes} دقيقة: ${t.delay_reason ?? ""}` : t.stop_planned_at ? `الموعد المتوقع: ${fmtTime(t.stop_planned_at, tz)}` : undefined,
        trip: t };
  }
}

export const lockedReason: Record<string, string> = {
  no_trip_today: "لا توجد رحلة اليوم.",
  tracking_disabled: "التتبع غير مفعّل لحسابك. تواصل مع المدرسة.",
  trip_not_started: "تظهر الخريطة عند صعود ابنك إلى الباص.",
  not_boarded: "تظهر الخريطة عند صعود ابنك إلى الباص.",
  absent: "تم تسجيل الغياب، لذلك لا يتوفر تتبع.",
  dropped: "انتهى التتبع بعد نزول ابنك من الباص.",
  trip_ended: "انتهت الرحلة وتوقف التتبع.",
  trip_cancelled: "الرحلة ملغاة.",
};
