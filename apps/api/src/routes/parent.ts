import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withCtx, one, many } from '../db/pool.js';
import { requireAuth } from '../lib/auth.js';
import { AppError, notFound } from '../lib/errors.js';
import { parse, idParam, isoDate, todayIn, audit } from '../lib/util.js';
import { formatLocation, latestLocation, loadTenant } from '../services/trips.js';
import { enqueue } from '../services/outbox.js';
import { etaProvider, type EtaResult } from '../integrations/routing.js';
import { submitAbsence } from '../services/absences.js';
import { phone } from '../lib/util.js';
import { recentMessages } from './driver.js';

export async function parentRoutes(app: FastifyInstance) {
  const auth = { preHandler: requireAuth(['parent']) };

  /** بطاقات الأبناء: RLS تعيد الأبناء المرتبطين بولي الأمر فقط */
  app.get('/parent/children', auth, async (req) =>
    withCtx(req.ctx, async (c) => {
      const tenant = await loadTenant(c, req.ctx.tenantId!);
      const today = todayIn(tenant.timezone);
      const children = await many(c, `select id, full_name as "fullName", grade, requires_handover as "requiresHandover" from students where status = 'active' order by full_name`);
      const trips = children.length
        ? await many(
            c,
            `select tr.student_id as "studentId", t.id as "tripId", t.direction, t.status as "tripStatus",
                    tr.status as "riderStatus", tr.boarded_at as "boardedAt", tr.alighted_at as "alightedAt",
                    t.planned_start as "plannedStart", t.started_at as "startedAt", t.ended_at as "endedAt",
                    t.last_location_at as "lastLocationAt", b.label as "busLabel", b.plate_number as "busPlate"
             from trip_riders tr join trips t on t.id = tr.trip_id left join buses b on b.id = t.bus_id
             where tr.student_id = any($1::uuid[]) and t.service_date = $2 and t.status <> 'cancelled'
             order by t.planned_start nulls last, t.created_at`,
            [children.map((ch) => ch.id), today],
          )
        : [];
      return {
        date: today,
        staleAfterSec: tenant.cfg.staleAfterSec,
        children: children.map((ch) => ({ ...ch, today: trips.filter((t) => t.studentId === ch.id) })),
        messages: await recentMessages(c),
      };
    }),
  );

  /** حالة رحلة الطفل الحالية + آخر موقع مسموح (أثناء رحلة جارية فقط) */
  app.get('/parent/children/:id/status', auth, async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(req.ctx, async (c) => {
      const child = await one(c, `select id, full_name as "fullName", grade from students where id = $1`, [id]);
      if (!child) throw notFound(); // غير مرتبط = غير موجود
      const tenant = await loadTenant(c, req.ctx.tenantId!);
      const today = todayIn(tenant.timezone);
      const trip = await one(
        c,
        `select t.id, t.status, t.direction, t.planned_start as "plannedStart", t.started_at as "startedAt",
                t.ended_at as "endedAt", t.route_id, t.bus_id,
                tr.id as rider_id, tr.status as "riderStatus", tr.stop_id, tr.boarded_at as "boardedAt", tr.alighted_at as "alightedAt"
         from trip_riders tr join trips t on t.id = tr.trip_id
         where tr.student_id = $1 and (t.status = 'in_progress' or (t.service_date = $2 and t.status <> 'cancelled'))
         order by (t.status = 'in_progress') desc, t.planned_start desc nulls last, t.created_at desc limit 1`,
        [id, today],
      );
      if (!trip) return { child, trip: null, tracking: { available: false, reason: 'no_trip_today' }, eta: null };
      const bus = trip.bus_id ? await one(c, `select label, plate_number as plate from buses where id = $1`, [trip.bus_id]) : null;
      // نقطة توقف هذا الطفل فقط
      const stop = trip.stop_id ? await one(c, `select name, lat, lng, planned_time as "plannedTime" from route_stops where id = $1`, [trip.stop_id]) : null;
      const events = await many(
        c,
        `select type, new_status as "newStatus", recorded_at as "recordedAt", source, handover_to as "handoverTo" from boarding_events
         where trip_id = $1 and student_id = $2 order by recorded_at`,
        [trip.id, id],
      );
      let tracking: Record<string, unknown>;
      let eta: EtaResult | null = null;
      if (trip.status !== 'in_progress') {
        tracking = { available: false, reason: 'trip_not_active' };
      } else if (!tenant.cfg.parentTrackingEnabled) {
        tracking = { available: false, reason: 'disabled_by_tenant' };
      } else {
        const loc = formatLocation(await latestLocation(c, trip.id), tenant.cfg);
        tracking = loc ? { available: true, location: loc } : { available: false, reason: 'no_location_yet' };
        // الذهاب: حتى يصل الباص لنقطة الصعود. العودة: حتى يصل لنقطة النزول (المنزل)
        const awaiting = (trip.direction === 'to_school' && trip.riderStatus === 'expected')
          || (trip.direction === 'from_school' && trip.riderStatus === 'boarded');
        if (loc && stop && awaiting) {
          const sp = await one<{ v: number | null }>(
            c,
            `select avg(speed_mps)::float8 as v from bus_locations where trip_id = $1 and recorded_at > now() - interval '3 minutes' and speed_mps > 0.5`,
            [trip.id],
          );
          eta = await etaProvider().estimate({ from: loc, to: stop, locationAgeSec: loc.ageSeconds, staleAfterSec: tenant.cfg.staleAfterSec, recentSpeedMps: sp?.v ?? null });
        }
      }
      return {
        child,
        trip: {
          id: trip.id, status: trip.status, direction: trip.direction, plannedStart: trip.plannedStart,
          startedAt: trip.startedAt, endedAt: trip.endedAt, riderStatus: trip.riderStatus,
          boardedAt: trip.boardedAt, alightedAt: trip.alightedAt, bus, stop, events,
          handoverTo: [...events].reverse().find((e) => e.type === 'alighted')?.handoverTo ?? null,
        },
        tracking,
        eta: eta ?? { available: false, reason: 'no_provider' },
        staleAfterSec: tenant.cfg.staleAfterSec,
      };
    });
  });

  app.get('/parent/children/:id/history', auth, async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(req.ctx, async (c) => {
      const child = await one(c, `select id from students where id = $1`, [id]);
      if (!child) throw notFound();
      const rows = await many(
        c,
        `select t.id as "tripId", t.service_date as "serviceDate", t.direction, t.status as "tripStatus",
                tr.status as "riderStatus", tr.boarded_at as "boardedAt", tr.alighted_at as "alightedAt"
         from trip_riders tr join trips t on t.id = tr.trip_id
         where tr.student_id = $1 and t.service_date >= current_date - 60
         order by t.service_date desc, t.planned_start desc nulls last limit 120`,
        [id],
      );
      return { history: rows };
    });
  });

  app.get('/parent/absences', auth, async (req) =>
    withCtx(req.ctx, async (c) => ({
      absences: await many(
        c,
        `select a.id, a.student_id as "studentId", s.full_name as "studentName", a.absence_date as "date", a.direction,
                a.reason, a.status, a.created_at as "createdAt"
         from absences a join students s on s.id = a.student_id
         order by a.absence_date desc, a.created_at desc limit 100`,
      ),
    })),
  );

  app.post('/parent/absences', auth, async (req) => {
    const body = parse(
      z.object({
        studentId: z.string().uuid(),
        date: isoDate,
        direction: z.enum(['to_school', 'from_school', 'both']),
        reason: z.string().trim().max(300).optional(),
      }),
      req.body,
    );
    return withCtx(req.ctx, async (c) => submitAbsence(c, req.ctx, body));
  });

  app.post('/parent/absences/:id/cancel', auth, async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(req.ctx, async (c) => {
      const a = await one(c, `select id from absences where id = $1`, [id]);
      if (!a) throw notFound();
      const r = await one<{ ok: boolean }>(c, `select app.cancel_own_absence($1) as ok`, [id]);
      if (!r?.ok) throw new AppError(409, 'absence_not_editable');
      await audit(c, req.ctx, 'absence.cancelled', 'absence', id);
      await enqueue(c, req.ctx.tenantId!, 'absence_updated', { absenceId: id });
      return { ok: true };
    });
  });

  // ---------------- إعدادات الطفل: تنبيه الاقتراب + المستلمون المصرّح لهم ----------------
  app.get('/parent/children/:id/settings', auth, async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(req.ctx, async (c) => {
      const child = await one(c, `select id, full_name as "fullName", requires_handover as "requiresHandover" from students where id = $1`, [id]);
      if (!child) throw notFound();
      const tenant = await loadTenant(c, req.ctx.tenantId!);
      const pref = await one(c, `select approach_meters from guardian_alert_prefs where student_id = $1 and guardian_user_id = $2`, [id, req.ctx.userId]);
      const pickups = await many(
        c,
        `select id, full_name as "fullName", relationship, phone, created_at as "createdAt" from authorized_pickups
         where student_id = $1 and status = 'active' order by created_at`,
        [id],
      );
      const tenantDefault = tenant.cfg.approachAlertDefaultM || null;
      return {
        child,
        approach: { meters: pref ? pref.approach_meters : tenantDefault, custom: !!pref, tenantDefault },
        pickups,
      };
    });
  });

  app.put('/parent/children/:id/approach', auth, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ meters: z.number().int().min(200).max(5000).nullable() }), req.body);
    return withCtx(req.ctx, async (c) => {
      const child = await one(c, `select id from students where id = $1`, [id]);
      if (!child) throw notFound();
      await c.query(
        `insert into guardian_alert_prefs (tenant_id, guardian_user_id, student_id, approach_meters) values ($1, $2, $3, $4)
         on conflict (student_id, guardian_user_id) do update set approach_meters = excluded.approach_meters, updated_at = now()`,
        [req.ctx.tenantId, req.ctx.userId, id, body.meters],
      );
      return { ok: true, meters: body.meters };
    });
  });

  app.post('/parent/children/:id/pickups', auth, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({ fullName: z.string().trim().min(2).max(120), relationship: z.string().trim().max(40).nullish(), phone: phone.nullish() }),
      req.body,
    );
    return withCtx(req.ctx, async (c) => {
      const child = await one(c, `select id from students where id = $1`, [id]);
      if (!child) throw notFound();
      const n = await one<{ n: number }>(c, `select count(*)::int as n from authorized_pickups where student_id = $1 and status = 'active'`, [id]);
      if ((n?.n ?? 0) >= 6) throw new AppError(409, 'too_many_pickups');
      const r = await one(
        c,
        `insert into authorized_pickups (tenant_id, student_id, full_name, relationship, phone, added_by)
         values ($1, $2, $3, $4, $5, $6) returning id, full_name as "fullName", relationship, phone`,
        [req.ctx.tenantId, id, body.fullName, body.relationship ?? null, body.phone ?? null, req.ctx.userId],
      );
      await audit(c, req.ctx, 'pickup.added', 'student', id, { pickupId: r.id });
      return { pickup: r };
    });
  });

  app.post('/parent/pickups/:id/revoke', auth, async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(req.ctx, async (c) => {
      const r = await one(
        c,
        `update authorized_pickups set status = 'revoked', revoked_by = $2, revoked_at = now() where id = $1 and status = 'active' returning student_id`,
        [id, req.ctx.userId],
      );
      if (!r) throw notFound();
      await audit(c, req.ctx, 'pickup.revoked', 'student', r.student_id, { pickupId: id });
      return { ok: true };
    });
  });

  // ---------------- طلبات تغيير العنوان / نقطة التوقف ----------------
  app.get('/parent/stop-changes', auth, async (req) =>
    withCtx(req.ctx, async (c) => ({
      requests: await many(
        c,
        `select r.id, r.student_id as "studentId", s.full_name as "studentName", r.kind, r.direction,
                r.start_date as "startDate", r.end_date as "endDate", r.address, r.status, r.review_note as "reviewNote",
                r.created_at as "createdAt"
         from stop_change_requests r join students s on s.id = r.student_id
         order by r.created_at desc limit 50`,
      ),
    })),
  );

  app.post('/parent/stop-changes', auth, async (req) => {
    const body = parse(
      z.object({
        studentId: z.string().uuid(),
        kind: z.enum(['permanent', 'temporary']),
        direction: z.enum(['to_school', 'from_school', 'both']),
        startDate: isoDate,
        endDate: isoDate.nullish(),
        address: z.string().trim().min(3).max(300),
        lat: z.number().min(-90).max(90).nullish(),
        lng: z.number().min(-180).max(180).nullish(),
        note: z.string().trim().max(300).nullish(),
      }).refine((b) => (b.lat == null) === (b.lng == null), { message: 'lat and lng go together' }),
      req.body,
    );
    return withCtx(req.ctx, async (c) => {
      const child = await one(c, `select id from students where id = $1`, [body.studentId]);
      if (!child) throw notFound();
      const tenant = await loadTenant(c, req.ctx.tenantId!);
      const today = todayIn(tenant.timezone);
      if (body.startDate < today) throw new AppError(400, 'date_in_past');
      if (body.kind === 'temporary') {
        if (!body.endDate || body.endDate < body.startDate) throw new AppError(400, 'invalid_date_range');
        const days = (Date.parse(body.endDate) - Date.parse(body.startDate)) / 86_400_000;
        if (days > 60) throw new AppError(400, 'range_too_long');
      }
      const pending = await one<{ n: number }>(c, `select count(*)::int as n from stop_change_requests where student_id = $1 and status = 'pending'`, [body.studentId]);
      if ((pending?.n ?? 0) >= 3) throw new AppError(409, 'too_many_pending');
      const r = await one(
        c,
        `insert into stop_change_requests (tenant_id, student_id, requested_by, kind, direction, start_date, end_date, address, lat, lng, note)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id, status`,
        [req.ctx.tenantId, body.studentId, req.ctx.userId, body.kind, body.direction, body.startDate,
          body.kind === 'temporary' ? body.endDate : null, body.address, body.lat ?? null, body.lng ?? null, body.note ?? null],
      );
      await audit(c, req.ctx, 'stop_change.requested', 'student', body.studentId, { requestId: r.id, kind: body.kind });
      return { request: r };
    });
  });

  app.post('/parent/stop-changes/:id/cancel', auth, async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(req.ctx, async (c) => {
      const r = await one(c, `update stop_change_requests set status = 'cancelled' where id = $1 and requested_by = $2 and status = 'pending' returning id`, [id, req.ctx.userId]);
      if (!r) throw new AppError(409, 'request_not_editable');
      await audit(c, req.ctx, 'stop_change.cancelled', 'stop_change', id);
      return { ok: true };
    });
  });
}
