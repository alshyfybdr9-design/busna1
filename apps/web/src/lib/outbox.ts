"use client";
// Offline outbox for attendance taps. record_attendance is idempotent and
// accepts the device time (p_at), so replaying after reconnecting is safe and
// keeps the real time of each boarding/drop-off.
import { supabaseBrowser } from "./supabase/client";
import { isNetworkError, toAppError, type AppError } from "./errors";
import type { AttendanceStatus } from "./types";

export interface PendingAttendance {
  key: string;            // trip_student id (latest action wins)
  tripId: string;
  status: AttendanceStatus;
  lat: number | null;
  lng: number | null;
  at: string;
}

const KEY = "busna:outbox:attendance";

function read(): PendingAttendance[] {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; }
}
function write(items: PendingAttendance[]) {
  try { localStorage.setItem(KEY, JSON.stringify(items)); } catch { /* ignore */ }
}

export function pendingFor(tripId: string): PendingAttendance[] {
  return read().filter((p) => p.tripId === tripId);
}

export type SendResult = { ok: true; queued: boolean } | { ok: false; error: AppError };

export async function sendAttendance(item: Omit<PendingAttendance, "at"> & { at?: string }): Promise<SendResult> {
  const full: PendingAttendance = { ...item, at: item.at ?? new Date().toISOString() };
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    enqueue(full);
    return { ok: true, queued: true };
  }
  try {
    const { error } = await supabaseBrowser().rpc("record_attendance", {
      p_trip_student: full.key, p_status: full.status, p_lat: full.lat, p_lng: full.lng, p_at: full.at,
    });
    if (error) throw error;
    return { ok: true, queued: false };
  } catch (err) {
    if (isNetworkError(err)) { enqueue(full); return { ok: true, queued: true }; }
    return { ok: false, error: toAppError(err) };
  }
}

function enqueue(item: PendingAttendance) {
  write([...read().filter((p) => p.key !== item.key), item]);
}

/** Replays queued taps. Returns server-side rejections so the UI can report them. */
export async function flushOutbox(): Promise<{ sent: number; failed: AppError[] }> {
  const items = read();
  let sent = 0;
  const failed: AppError[] = [];
  for (const it of items) {
    try {
      const { error } = await supabaseBrowser().rpc("record_attendance", {
        p_trip_student: it.key, p_status: it.status, p_lat: it.lat, p_lng: it.lng, p_at: it.at,
      });
      if (error) throw error;
      sent++;
      write(read().filter((p) => !(p.key === it.key && p.at === it.at)));
    } catch (err) {
      if (isNetworkError(err)) break; // still offline: keep the rest
      failed.push(toAppError(err));
      write(read().filter((p) => !(p.key === it.key && p.at === it.at)));
    }
  }
  return { sent, failed };
}
