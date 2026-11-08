import { one, many, type Db, type RequestContext } from '../db/pool.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { ageSeconds } from '../lib/util.js';
import { tenantSettings, type TenantSettings } from '../config.js';
import { enqueue } from './outbox.js';

export type RiderStatus = 'expected' | 'boarded' | 'alighted' | 'absent' | 'no_show';
export type DriverEventType = 'boarded' | 'alighted' | 'absent' | 'no_show';

/** الانتقالات المسموحة للسائق. أي انتقال آخر يتطلب تصحيحًا من المشرف مع سبب. */
const TRANSITIONS: Record<DriverEventType, RiderStatus[]> = {
  boarded: ['expected', 'no_show', 'absent'],
  alighted: ['boarded'],
  no_show: ['expected'],
  absent: ['expected', 'no_show'],
};

export async function loadTenant(c: Db, tenantId: string) {
  const t = await one<{ id: string; name: string; timezone: string; settings: unknown; contact_phone: string | null }>(
    c,
    'select id, name, timezone, settings, contact_phone from tenants where id = $1',
    [tenantId],
  );
  if (!t) throw notFound();
  return { ...t, cfg: tenantSettings(t.settings) };
}

export function formatLocation(
  row: { lat: number; lng: number; recorded_at: string | Date; accuracy_m: number | null } | null,
  cfg: Pick<TenantSettings, 'staleAfterSec'>,
) {
  if (!row) return null;
  const age = ageSeconds(row.recorded_at)!;
  return {
    lat: row.lat,
    lng: row.lng,
    accuracyM: row.accuracy_m,
    recordedAt: new Date(row.recorded_at).toISOString(),
    ageSeconds: age,
    // "مباشر" فقط إن كان التحديث حديثًا؛ غير ذلك تعرض الواجهة "آخر تحديث منذ…"
    isStale: age > cfg.staleAfterSec,
  };
}

export async function latestLocation(c: Db, tripId: string) {
  return one(c, `select lat, lng, recorded_at, accuracy_m from bus_locations where trip_id = $1 order by recorded_at desc limit 1`, [tripId]);
}

// ---------------------------------------------------------------------------
// إنشاء الرحلات
// ---------------------------------------------------------------------------
export async function createTripFromRoute(
  c: Db,
  ctx: RequestContext,
  input: { routeId: string; serviceDate: string; scheduleId?: string | null; departureTime?: string | null },
) {
  const route = await one(
    c,
    `select r.*, t.timezone from routes r join tenants t on t.id = r.tenant_id where r.id = $1 and r.status = 'active'`,
    [input.routeId],
  );
  if (!route) throw notFound();
  const riderCount = await one<{ n: number }>(c, 'select count(*) as n from route_riders where route_id = $1', [route.id]);
  if (!route.bus_id || !route.driver_user_id || !riderCount?.n) throw badRequest('route_incomplete');
  const driverOk = await one(
    c,
    `select 1 from memberships where tenant_id = $1 and user_id = $2 and role = 'driver' and status = 'active'`,
    [route.tenant_id, route.driver_user_id],
  );
  if (!driverOk) throw badRequest('invalid_driver');
  if (!input.scheduleId) {
    const dup = await one(
      c,
      `select id from trips where route_id = $1 and service_date = $2 and status <> 'cancelled' and schedule_id is null`,
      [route.id, input.serviceDate],
    );
    if (dup) throw conflict('trip_exists', { tripId: dup.id });
  }
  const trip = await one(
    c,
    `insert into trips (tenant_id, route_id, schedule_id, service_date, direction, bus_id, driver_user_id, planned_start)
     values ($1, $2, $3, $4, $5, $6, $7, case when $8::time is null then null else ($4::date + $8::time) at time zone $9 end)
     on conflict (schedule_id, service_date) do nothing
     returning *`,
    [route.tenant_id, route.id, input.scheduleId ?? null, input.serviceDate, route.direction, route.bus_id,
      route.driver_user_id, input.departureTime ?? null, route.timezone],
  );
  if (!trip) return null; // موجودة مسبقًا لهذا الجدول
  const riders = await many(
    c,
    `insert into trip_riders (tenant_id, trip_id, student_id, stop_id, status)
     select $1, $2, rr.student_id, rr.stop_id,
            case when exists (select 1 from absences a where a.student_id = rr.student_id and a.absence_date = $3
                               and a.status = 'approved' and (a.direction = 'both' or a.direction = $4))
                 then 'absent' else 'expected' end
     from route_riders rr join students s on s.id = rr.student_id
     where rr.route_id = $5 and s.status = 'active'
     returning id, student_id, status`,
    [route.tenant_id, trip.id, input.serviceDate, route.direction, route.id],
  );
  for (const r of riders.filter((x) => x.status === 'absent')) {
    await c.query(
      `insert into boarding_events (tenant_id, trip_id, trip_rider_id, student_id, type, new_status, source, client_event_id, recorded_at, recorded_by, reason)
       values ($1, $2, $3, $4, 'absent', 'absent', 'system', gen_random_uuid(), now(), $5, 'approved_absence')`,
      [route.tenant_id, trip.id, r.id, r.student_id, ctx.userId],
    );
  }
  return trip;
}

// ---------------------------------------------------------------------------
// أحداث الصعود والنزول — idempotent عبر client_event_id
// ---------------------------------------------------------------------------
export interface RiderEventInput {
  clientEventId: string;
  studentId: string;
  type: DriverEventType;
  recordedAt: string;
  source: 'manual' | 'qr';
  lat?: number | null;
  lng?: number | null;
}

export interface RiderEventResult {
  clientEventId: string;
  result: 'applied' | 'duplicate' | 'already' | 'rejected';
  code?: string;
  riderStatus?: RiderStatus;
}

export async function applyRiderEvents(c: Db, ctx: RequestContext, tripId: string, events: RiderEventInput[]) {
  const trip = await one(c, `select id, tenant_id, status, started_at from trips where id = $1 for update`, [tripId]);
  if (!trip) throw notFound();
  const sorted = [...events].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  const results: RiderEventResult[] = [];
  const now = Date.now();
  for (const e of sorted) {
    const dup = await one(c, `select new_status from boarding_events where tenant_id = $1 and client_event_id = $2`, [trip.tenant_id, e.clientEventId]);
    if (dup) {
      results.push({ clientEventId: e.clientEventId, result: 'duplicate', riderStatus: dup.new_status });
      continue;
    }
    if (trip.status !== 'in_progress') {
      results.push({ clientEventId: e.clientEventId, result: 'rejected', code: 'trip_not_active' });
      continue;
    }
    const recordedAtMs = Date.parse(e.recordedAt);
    if (Number.isNaN(recordedAtMs) || recordedAtMs > now + 5 * 60_000) {
      results.push({ clientEventId: e.clientEventId, result: 'rejected', code: 'invalid_time' });
      continue;
    }
    const rider = await one(c, `select id, status from trip_riders where trip_id = $1 and student_id = $2 for update`, [tripId, e.studentId]);
    if (!rider) {
      results.push({ clientEventId: e.clientEventId, result: 'rejected', code: 'not_on_trip' });
      continue;
    }
    const target: RiderStatus = e.type;
    if (rider.status === target) {
      results.push({ clientEventId: e.clientEventId, result: 'already', riderStatus: rider.status });
      continue;
    }
    if (!TRANSITIONS[e.type].includes(rider.status)) {
      // مثال: نزول طالب لم يُسجّل صعوده — مرفوض إلا بتصحيح من المشرف مع سبب
      results.push({
        clientEventId: e.clientEventId,
        result: 'rejected',
        code: e.type === 'alighted' ? 'not_boarded' : 'invalid_transition',
        riderStatus: rider.status,
      });
      continue;
    }
    const ins = await one(
      c,
      `insert into boarding_events (tenant_id, trip_id, trip_rider_id, student_id, type, new_status, source,
                                    client_event_id, recorded_at, recorded_by, lat, lng)
       values ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $10, $11)
       on conflict (tenant_id, client_event_id) do nothing returning id`,
      [trip.tenant_id, tripId, rider.id, e.studentId, e.type, e.source, e.clientEventId, e.recordedAt, ctx.userId, e.lat ?? null, e.lng ?? null],
    );
    if (!ins) {
      results.push({ clientEventId: e.clientEventId, result: 'duplicate' });
      continue;
    }
    await c.query(
      `update trip_riders set status = $2,
         boarded_at = case when $2 = 'boarded' then $3::timestamptz else boarded_at end,
         alighted_at = case when $2 = 'alighted' then $3::timestamptz else alighted_at end
       where id = $1`,
      [rider.id, target, e.recordedAt],
    );
    await enqueue(c, trip.tenant_id, 'rider_event', { tripId, tripRiderId: rider.id, studentId: e.studentId, type: e.type, eventId: ins.id });
    results.push({ clientEventId: e.clientEventId, result: 'applied', riderStatus: target });
  }
  return results;
}

/** تصحيح حالة طالب — للمشرف/المدير فقط، مع سبب محفوظ وسجل تدقيق */
export async function correctRider(
  c: Db,
  ctx: RequestContext,
  tripId: string,
  riderId: string,
  newStatus: RiderStatus,
  reason: string,
) {
  const rider = await one(c, `select tr.*, t.tenant_id as t_tenant from trip_riders tr join trips t on t.id = tr.trip_id where tr.id = $1 and tr.trip_id = $2 for update of tr`, [riderId, tripId]);
  if (!rider) throw notFound();
  const ev = await one(
    c,
    `insert into boarding_events (tenant_id, trip_id, trip_rider_id, student_id, type, new_status, source, client_event_id, recorded_at, recorded_by, reason)
     values ($1, $2, $3, $4, 'correction', $5, 'correction', gen_random_uuid(), now(), $6, $7) returning id`,
    [rider.tenant_id, tripId, riderId, rider.student_id, newStatus, ctx.userId, reason],
  );
  await c.query(
    `update trip_riders set status = $2,
       boarded_at = case when $2 in ('boarded', 'alighted') then coalesce(boarded_at, now()) else boarded_at end,
       alighted_at = case when $2 = 'alighted' then coalesce(alighted_at, now()) else alighted_at end
     where id = $1`,
    [riderId, newStatus],
  );
  await enqueue(c, rider.tenant_id, 'rider_event', { tripId, tripRiderId: riderId, studentId: rider.student_id, type: 'correction', eventId: ev!.id, newStatus });
  return { previousStatus: rider.status as RiderStatus, newStatus, eventId: ev!.id };
}

// ---------------------------------------------------------------------------
// المواقع
// ---------------------------------------------------------------------------
export interface LocationPoint {
  recordedAt: string;
  lat: number;
  lng: number;
  accuracyM?: number | null;
  speedMps?: number | null;
  heading?: number | null;
}

export async function ingestLocations(c: Db, tripId: string, points: LocationPoint[]) {
  const trip = await one(c, `select id, tenant_id, status, started_at from trips where id = $1`, [tripId]);
  if (!trip) throw notFound();
  // لا يُخزن أي موقع خارج رحلة جارية — العميل يتوقف عن التتبع عند هذا الرد
  if (trip.status !== 'in_progress') throw new AppError(409, 'trip_not_active');
  const minTs = new Date(trip.started_at).getTime() - 2 * 60_000;
  const maxTs = Date.now() + 60_000;
  const valid = points.filter((p) => {
    const t = Date.parse(p.recordedAt);
    return !Number.isNaN(t) && t >= minTs && t <= maxTs;
  });
  if (!valid.length) return { accepted: 0, ignored: points.length };
  const r = await c.query(
    `insert into bus_locations (tenant_id, trip_id, recorded_at, lat, lng, accuracy_m, speed_mps, heading)
     select $1, $2, x.ts, x.lat, x.lng, x.acc, x.spd, x.hdg
     from unnest($3::timestamptz[], $4::float8[], $5::float8[], $6::real[], $7::real[], $8::real[]) as x(ts, lat, lng, acc, spd, hdg)
     on conflict (trip_id, recorded_at) do nothing`,
    [trip.tenant_id, tripId, valid.map((p) => p.recordedAt), valid.map((p) => p.lat), valid.map((p) => p.lng),
      valid.map((p) => p.accuracyM ?? null), valid.map((p) => p.speedMps ?? null), valid.map((p) => p.heading ?? null)],
  );
  const maxRecorded = valid.reduce((m, p) => (p.recordedAt > m ? p.recordedAt : m), valid[0].recordedAt);
  await c.query(
    `update trips set last_location_at = greatest(coalesce(last_location_at, '-infinity'::timestamptz), $2::timestamptz) where id = $1`,
    [tripId, maxRecorded],
  );
  return { accepted: r.rowCount ?? 0, ignored: points.length - valid.length };
}

export async function riderCounts(c: Db, tripId: string) {
  const rows = await many<{ status: RiderStatus; n: number }>(c, `select status, count(*) as n from trip_riders where trip_id = $1 group by status`, [tripId]);
  const counts: Record<RiderStatus, number> = { expected: 0, boarded: 0, alighted: 0, absent: 0, no_show: 0 };
  for (const r of rows) counts[r.status] = r.n;
  return counts;
}
