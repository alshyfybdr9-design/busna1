/**
 * طابور محلي (SQLite) لأحداث الحضور ونقاط الموقع عند ضعف الاتصال.
 * كل حدث يحمل client_event_id ثابتًا، وكل نقطة موقع مفتاحها (trip, recordedAt)،
 * والخادم يتجاهل المكرر — فإعادة الإرسال آمنة ولا تُنتج تكرارًا.
 */
import * as SQLite from 'expo-sqlite';
import { api, ApiError } from './session';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

function db() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const d = await SQLite.openDatabaseAsync('busna-queue.db');
      await d.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS pending_events (
          client_event_id TEXT PRIMARY KEY NOT NULL,
          trip_id TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pending_locations (
          trip_id TEXT NOT NULL,
          recorded_at TEXT NOT NULL,
          payload TEXT NOT NULL,
          PRIMARY KEY (trip_id, recorded_at)
        );
        CREATE TABLE IF NOT EXISTS rejected_events (
          client_event_id TEXT PRIMARY KEY NOT NULL,
          trip_id TEXT NOT NULL,
          student_id TEXT NOT NULL,
          code TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );`);
      return d;
    })();
  }
  return dbPromise;
}

export interface QueuedEvent {
  clientEventId: string;
  studentId: string;
  type: 'boarded' | 'alighted' | 'absent' | 'no_show';
  recordedAt: string;
  source: 'manual' | 'qr';
  lat?: number | null;
  lng?: number | null;
  handover?: { kind: 'guardian' | 'authorized'; refId: string } | null;
}

export async function enqueueEvent(tripId: string, e: QueuedEvent) {
  const d = await db();
  await d.runAsync('INSERT OR IGNORE INTO pending_events (client_event_id, trip_id, payload, created_at) VALUES (?, ?, ?, ?)',
    e.clientEventId, tripId, JSON.stringify(e), Date.now());
}

export async function enqueueLocations(tripId: string, points: Array<{ recordedAt: string; lat: number; lng: number; accuracyM?: number | null; speedMps?: number | null; heading?: number | null }>) {
  const d = await db();
  for (const p of points) {
    await d.runAsync('INSERT OR IGNORE INTO pending_locations (trip_id, recorded_at, payload) VALUES (?, ?, ?)', tripId, p.recordedAt, JSON.stringify(p));
  }
}

export async function pendingCounts(tripId?: string) {
  const d = await db();
  const ev = await d.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM pending_events ${tripId ? 'WHERE trip_id = ?' : ''}`, ...(tripId ? [tripId] : []));
  const loc = await d.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM pending_locations ${tripId ? 'WHERE trip_id = ?' : ''}`, ...(tripId ? [tripId] : []));
  return { events: ev?.n ?? 0, locations: loc?.n ?? 0 };
}

export async function rejectedEvents(tripId: string) {
  const d = await db();
  return d.getAllAsync<{ client_event_id: string; student_id: string; code: string }>('SELECT * FROM rejected_events WHERE trip_id = ? ORDER BY created_at', tripId);
}

export async function clearRejected(tripId: string) {
  const d = await db();
  await d.runAsync('DELETE FROM rejected_events WHERE trip_id = ?', tripId);
}

let flushingEvents: Promise<void> | null = null;

/** يرسل الأحداث المعلقة بالترتيب. لا يحذف حدثًا إلا بعد رد صريح من الخادم. */
export function flushEvents(): Promise<void> {
  if (flushingEvents) return flushingEvents;
  flushingEvents = (async () => {
    const d = await db();
    const rows = await d.getAllAsync<{ client_event_id: string; trip_id: string; payload: string }>('SELECT * FROM pending_events ORDER BY created_at LIMIT 200');
    const byTrip = new Map<string, QueuedEvent[]>();
    for (const r of rows) byTrip.set(r.trip_id, [...(byTrip.get(r.trip_id) ?? []), JSON.parse(r.payload)]);
    for (const [tripId, events] of byTrip) {
      let res: { results: Array<{ clientEventId: string; result: string; code?: string }> };
      try {
        res = await api('POST', `/driver/trips/${tripId}/events`, { events });
      } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 403)) {
          // الرحلة لم تعد متاحة لهذا السائق: لا جدوى من إعادة المحاولة
          await d.runAsync('DELETE FROM pending_events WHERE trip_id = ?', tripId);
          continue;
        }
        throw e; // شبكة/خادم: نحتفظ بها للمحاولة لاحقًا
      }
      for (const r of res.results) {
        if (r.result === 'rejected') {
          const ev = events.find((x) => x.clientEventId === r.clientEventId);
          await d.runAsync('INSERT OR IGNORE INTO rejected_events (client_event_id, trip_id, student_id, code, created_at) VALUES (?, ?, ?, ?, ?)',
            r.clientEventId, tripId, ev?.studentId ?? '', r.code ?? 'rejected', Date.now());
        }
        await d.runAsync('DELETE FROM pending_events WHERE client_event_id = ?', r.clientEventId);
      }
    }
  })().finally(() => {
    flushingEvents = null;
  });
  return flushingEvents;
}

let flushingLocations: Promise<'ok' | 'trip_not_active'> | null = null;

/** يرسل نقاط الموقع على دفعات. عند رد "الرحلة ليست جارية" تُحذف النقاط ويُطلب إيقاف التتبع. */
export function flushLocations(): Promise<'ok' | 'trip_not_active'> {
  if (flushingLocations) return flushingLocations;
  flushingLocations = (async () => {
    const d = await db();
    let outcome: 'ok' | 'trip_not_active' = 'ok';
    for (let i = 0; i < 20; i++) {
      const rows = await d.getAllAsync<{ trip_id: string; recorded_at: string; payload: string }>('SELECT * FROM pending_locations ORDER BY recorded_at LIMIT 300');
      if (!rows.length) break;
      const tripId = rows[0].trip_id;
      const batch = rows.filter((r) => r.trip_id === tripId);
      try {
        await api('POST', `/driver/trips/${tripId}/locations`, { points: batch.map((r) => JSON.parse(r.payload)) });
      } catch (e) {
        if (e instanceof ApiError && (e.code === 'trip_not_active' || e.status === 404 || e.status === 403)) {
          await d.runAsync('DELETE FROM pending_locations WHERE trip_id = ?', tripId);
          outcome = 'trip_not_active';
          continue;
        }
        throw e;
      }
      for (const r of batch) await d.runAsync('DELETE FROM pending_locations WHERE trip_id = ? AND recorded_at = ?', r.trip_id, r.recorded_at);
    }
    return outcome;
  })().finally(() => {
    flushingLocations = null;
  });
  return flushingLocations;
}

export async function dropTripLocations(tripId: string) {
  const d = await db();
  await d.runAsync('DELETE FROM pending_locations WHERE trip_id = ?', tripId);
}
