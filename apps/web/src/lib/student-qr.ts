"use client";
// Student card QR. The code carries ONLY an opaque per-student token
// (students.qr_token) behind a versioned prefix — no name, school or ids —
// so a lost card reveals nothing. Scanning is resolved server-side by
// public.record_attendance_by_qr() inside the trip's own school.

export const STUDENT_QR_PREFIX = "busna:s1:";

export function studentQrPayload(token: string): string {
  return STUDENT_QR_PREFIX + token;
}

/** SVG markup for the student's QR (generated locally, nothing is sent anywhere). */
export async function studentQrSvg(token: string): Promise<string> {
  const QRCode = (await import("qrcode")).default;
  return QRCode.toString(studentQrPayload(token), { type: "svg", errorCorrectionLevel: "M", margin: 0 });
}
