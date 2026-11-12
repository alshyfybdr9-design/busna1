/** التشغيل اليومي: الرحلات، لوحة المتابعة، الخريطة الحية، التنبيهات، الغياب، التصحيحات */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withCtx, one, many } from '../db/pool.js';
import { requireAuth, STAFF } from '../lib/auth.js';
import { AppError, notFound } from '../lib/errors.js';
import { parse, idParam, isoDate, todayIn, audit } from '../lib/util.js';
import { correctRider, createTripFromRoute, formatLocation, latestLocation, loadTenant, riderCounts } from '../services/trips.js';
import { enqueue } from '../services/outbox.js';

export async function tenantOpsRoutes(app: FastifyInstance) {
  const staff = { preHandler: requireAuth(STAFF) };

  // ---------------- الرحلات ----------------
  app.get('/tenant/trips', staff, async (req) => {
    const q = parse(z.object({ date: isoDate.optional() }), req.query);
    return withCtx(req.ctx, async (c) => {
      const tenant = await loadTenant(c, req.ctx.tenantId!);
      const date = q.date ?? todayIn(tenant.timezone);
      const trips = await many(
        c,
        `select t.id, t.status, t.direction, t.service_date as "serviceDate", t.planned_start as "plannedStart",
                t.started_at as "startedAt", t.ended_at as "endedAt", t.inspection_status as "inspectionStatus",
                t.last_location_at as "lastLocationAt", r.name as "routeName", b.label as "busLabel", b.plate_number as "busPlate",
                u.full_name as "driverName", (select full_name from users where id = t.attendant_user_id) as "attendantName",
                (select json_object_agg(x.status, x.n) from (select status, count(*) n from trip_riders where trip_id = t.id group by status) x) as counts
         from trips t join routes r on r.id = t.route_id left join buses b on b.id = t.bus_id left join users u on u.id = t.driver_user_id
         where t.service_date = $1 order by t.planned_start nulls last, r.name`,
        [date],
      );
      return { date, trips };
    });
  });

  app.post('/tenant/trips', staff, async (req) => {
    const body = parse(z.object({ routeId: z.string().uuid(), date: isoDate, departureTime: z.string().regex(/^\d{2}:\d{2}$/).optional() }), req.body);
    return withCtx(req.ctx, async (c) => {
      const trip = await createTripFromRoute(c, req.ctx, { routeId: body.routeId, serviceDate: body.date, departureTime: body.departureTime });
      await audit(c, req.ctx, 'trip.created', 'trip', trip!.id, { routeId: body.routeId, date: body.date });
      return { trip: { id: trip!.id, status: trip!.status } };
    });
  });

  /** توليد رحلات يوم من الجداول النشطة (آمن للتكرار: لا يكرر رحلة لنفس الجدول والتاريخ) */
  app.post('/tenant/trips/generate', staff, async (req) => {
    const body = parse(z.object({ date: isoDate }), req.body);
    return withCtx(req.ctx, async (c) => {
      const dow = new Date(`${body.date}T12:00:00Z`).getUTCDay();
      const schedules = await many(
        c,
        `select s.id, s.route_id, to_char(s.departure_time, 'HH24:MI') as dep from schedules s join routes r on r.id = s.route_id
         where s.status = 'active' and r.status = 'active' and $1 = any(s.days_of_week)`,
        [dow],
      );
      const created: string[] = [];
      const skipped: Array<{ scheduleId: string; reason: string }> = [];
      for (const s of schedules) {
        await c.query('savepoint gen');
        try {
          const t = await createTripFromRoute(c, req.ctx, { routeId: s.route_id, serviceDate: body.date, scheduleId: s.id, departureTime: s.dep });
          if (t) created.push(t.id);
          else skipped.push({ scheduleId: s.id, reason: 'exists' });
          await c.query('release savepoint gen');
        } catch (e) {
          await c.query('rollback to savepoint gen');
          skipped.push({ scheduleId: s.id, reason: e instanceof AppError ? e.code : 'error' });
        }
      }
      await audit(c, req.ctx, 'trips.generated', 'trip', null, { date: body.date, created: created.length });
      return { created, skipped };
    });
  });

  app.get('/tenant/trips/:id', staff, async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(req.ctx, async (c) => {
      const tenant = await loadTenant(c, req.ctx.tenantId!);
      const trip = await one(
        c,
        `select t.id, t.status, t.direction, t.service_date as "serviceDate", t.planned_start as "plannedStart",
                t.started_at as "startedAt", t.ended_at as "endedAt", t.inspection_status as "inspectionStatus",
                t.cancelled_reason as "cancelledReason", t.route_id as "routeId", r.name as "routeName",
                b.label as "busLabel", b.plate_number as "busPlate", u.full_name as "driverName", u.phone as "driverPhone",
                au.full_name as "attendantName", au.phone as "attendantPhone"
         from trips t join routes r on r.id = t.route_id left join buses b on b.id = t.bus_id left join users u on u.id = t.driver_user_id
         left join users au on au.id = t.attendant_user_id
         where t.id = $1`,
        [id],
      );
      if (!trip) throw notFound();
      const stops = await many(c, `select id, seq, name, kind, lat, lng, planned_time as "plannedTime" from route_stops where route_id = $1 order by seq`, [trip.routeId]);
      const riders = await many(
        c,
        `select tr.id, tr.student_id as "studentId", s.full_name as "fullName", s.grade, tr.stop_id as "stopId", tr.status,
                tr.boarded_at as "boardedAt", tr.alighted_at as "alightedAt"
         from trip_riders tr join students s on s.id = tr.student_id where tr.trip_id = $1 order by s.full_name`,
        [id],
      );
      const events = await many(
        c,
        `select e.id, e.student_id as "studentId", s.full_name as "studentName", e.type, e.new_status as "newStatus", e.source,
                e.recorded_at as "recordedAt", e.received_at as "receivedAt", e.reason, e.handover_to as "handoverTo", u.full_name as "recordedBy"
         from boarding_events e join students s on s.id = e.student_id left join users u on u.id = e.recorded_by
         where e.trip_id = $1 order by e.recorded_at`,
        [id],
      );
      const trail = await many(
        c,
        `select lat, lng, recorded_at as "recordedAt" from (select * from bus_locations where trip_id = $1 order by recorded_at desc limit 500) x order by recorded_at`,
        [id],
      );
      const inspection = await one(
        c,
        `select i.result, i.checklist, i.started_at as "startedAt", i.completed_at as "completedAt", i.notes,
                i.verified_at as "verifiedAt", v.full_name as "verifiedBy", i.verification_note as "verificationNote"
         from trip_inspections i left join users v on v.id = i.verified_by where i.trip_id = $1`,
        [id],
      );
      const alerts = await many(c, `select id, kind, severity, status, details, created_at as "createdAt" from safety_alerts where trip_id = $1 order by created_at`, [id]);
      return {
        trip, stops, riders, events, trail, inspection, alerts,
        counts: await riderCounts(c, id),
        location: formatLocation(await latestLocation(c, id), tenant.cfg),
      };
    });
  });

  app.post('/tenant/trips/:id/cancel', staff, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
    return withCtx(req.ctx, async (c) => {
      const trip = await one(c, `select id, status, tenant_id from trips where id = $1 for update`, [id]);
      if (!trip) throw notFound();
      if (trip.status !== 'scheduled') throw new AppError(409, 'trip_not_cancellable');
      await c.query(`update trips set status = 'cancelled', cancelled_reason = $2 where id = $1`, [id, body.reason]);
      await enqueue(c, trip.tenant_id, 'trip_cancelled', { tripId: id, reason: body.reason });
      await audit(c, req.ctx, 'trip.cancelled', 'trip', id, { reason: body.reason });
      return { ok: true };
    });
  });

  /** تصحيح حالة طالب بسبب محفوظ (مثل نزول بلا صعود مسجل) */
  app.post('/tenant/trips/:id/riders/:riderId/correct', staff, async (req) => {
    const p = parse(z.object({ id: z.string().uuid(), riderId: z.string().uuid() }), req.params);
    const body = parse(
      z.object({ status: z.enum(['expected', 'boarded', 'alighted', 'absent', 'no_show']), reason: z.string().trim().min(5).max(500) }),
      req.body,
    );
    return withCtx(req.ctx, async (c) => {
      const r = await correctRider(c, req.ctx, p.id, p.riderId, body.status, body.reason);
      await audit(c, req.ctx, 'rider.corrected', 'trip_rider', p.riderId, { tripId: p.id, from: r.previousStatus, to: r.newStatus, reason: body.reason });
      return r;
    });
  });

  /** تحقق مستقل (موظف ثانٍ) من فحص خلو الباص */
  app.post('/tenant/trips/:id/inspection/verify', staff, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ note: z.string().trim().max(300).optional() }), req.body ?? {});
    return withCtx(req.ctx, async (c) => {
      const r = await c.query(
        `update trip_inspections set verified_by = $2, verified_at = now(), verification_note = $3 where trip_id = $1 and verified_at is null`,
        [id, req.ctx.userId, body.note ?? null],
      );
      if (!r.rowCount) throw notFound();
      await audit(c, req.ctx, 'inspection.verified', 'trip', id);
      return { ok: true };
    });
  });

  // ---------------- لوحة المتابعة والخريطة ----------------
  app.get('/tenant/live', staff, async (req) =>
    withCtx(req.ctx, async (c) => {
      const tenant = await loadTenant(c, req.ctx.tenantId!);
      const trips = await many(
        c,
        `select t.id, t.direction, t.started_at as "startedAt", r.name as "routeName", b.label as "busLabel", b.plate_number as "busPlate",
                u.full_name as "driverName", l.lat, l.lng, l.recorded_at, l.accuracy_m
         from trips t join routes r on r.id = t.route_id left join buses b on b.id = t.bus_id left join users u on u.id = t.driver_user_id
         left join lateral (select lat, lng, recorded_at, accuracy_m from bus_locations bl where bl.trip_id = t.id order by recorded_at desc limit 1) l on true
         where t.status = 'in_progress' order by r.name`,
      );
      return {
        staleAfterSec: tenant.cfg.staleAfterSec,
        trips: trips.map(({ lat, lng, recorded_at, accuracy_m, ...t }) => ({
          ...t,
          location: lat == null ? null : formatLocation({ lat, lng, recorded_at, accuracy_m }, tenant.cfg),
        })),
      };
    }),
  );

  app.get('/tenant/dashboard', staff, async (req) =>
    withCtx(req.ctx, async (c) => {
      const tenant = await loadTenant(c, req.ctx.tenantId!);
      const today = todayIn(tenant.timezone);
      const tripCounts = await many(c, `select status, count(*) as n from trips where service_date = $1 group by status`, [today]);
      // تأخر البدء: رحلة مجدولة تجاوزت وقتها المخطط بأكثر من الحد المحدد
      const delayed = await many(
        c,
        `select t.id, r.name as "routeName", t.planned_start as "plannedStart", b.label as "busLabel", u.full_name as "driverName",
                round(extract(epoch from (now() - t.planned_start)) / 60) as "minutesLate"
         from trips t join routes r on r.id = t.route_id left join buses b on b.id = t.bus_id left join users u on u.id = t.driver_user_id
         where t.status = 'scheduled' and t.planned_start is not null and t.planned_start < now() - make_interval(mins => $1)
           and t.service_date >= $2::date - 1
         order by t.planned_start`,
        [tenant.cfg.delayThresholdMin, today],
      );
      const attendance = await many(
        c,
        `select tr.status, count(*) as n from trip_riders tr join trips t on t.id = tr.trip_id where t.service_date = $1 and t.status <> 'cancelled' group by tr.status`,
        [today],
      );
      const alerts = await many(
        c,
        `select a.id, a.kind, a.severity, a.status, a.details, a.created_at as "createdAt", a.trip_id as "tripId", r.name as "routeName"
         from safety_alerts a left join trips t on t.id = a.trip_id left join routes r on r.id = t.route_id
         where a.status <> 'resolved'
         order by case a.severity when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end, a.created_at desc limit 50`,
      );
      const pendingAbsences = await one(c, `select count(*) as n from absences where status = 'pending' and absence_date >= $1`, [today]);
      const pendingInspections = await one(c, `select count(*) as n from trips where status = 'completed' and inspection_status = 'pending'`);
      return {
        date: today,
        trips: Object.fromEntries(tripCounts.map((r) => [r.status, r.n])),
        attendance: Object.fromEntries(attendance.map((r) => [r.status, r.n])),
        delayed,
        alerts,
        pendingAbsences: pendingAbsences.n,
        pendingInspections: pendingInspections.n,
        delayThresholdMin: tenant.cfg.delayThresholdMin,
      };
    }),
  );

  // ---------------- التنبيهات ----------------
  app.get('/tenant/alerts', staff, async (req) => {
    const q = parse(z.object({ status: z.enum(['open', 'acknowledged', 'resolved']).optional() }), req.query);
    return withCtx(req.ctx, async (c) => ({
      alerts: await many(
        c,
        `select a.id, a.kind, a.severity, a.status, a.details, a.created_at as "createdAt", a.trip_id as "tripId", r.name as "routeName",
                a.resolution_note as "resolutionNote", a.resolved_at as "resolvedAt"
         from safety_alerts a left join trips t on t.id = a.trip_id left join routes r on r.id = t.route_id
         where ($1::text is null or a.status = $1) order by a.created_at desc limit 200`,
        [q.status ?? null],
      ),
    }));
  });

  app.post('/tenant/alerts/:id/ack', staff, async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(req.ctx, async (c) => {
      const r = await c.query(`update safety_alerts set status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now() where id = $1 and status = 'open'`, [id, req.ctx.userId]);
      if (!r.rowCount) throw notFound();
      await audit(c, req.ctx, 'alert.acknowledged', 'safety_alert', id);
      return { ok: true };
    });
  });

  app.post('/tenant/alerts/:id/resolve', staff, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ note: z.string().trim().min(5).max(1000) }), req.body);
    return withCtx(req.ctx, async (c) => {
      const r = await c.query(
        `update safety_alerts set status = 'resolved', resolved_by = $2, resolved_at = now(), resolution_note = $3 where id = $1 and status <> 'resolved'`,
        [id, req.ctx.userId, body.note],
      );
      if (!r.rowCount) throw notFound();
      await audit(c, req.ctx, 'alert.resolved', 'safety_alert', id, { note: body.note });
      return { ok: true };
    });
  });

  // ---------------- الغياب ----------------
  app.get('/tenant/absences', staff, async (req) => {
    const q = parse(z.object({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(), from: isoDate.optional() }), req.query);
    return withCtx(req.ctx, async (c) => ({
      absences: await many(
        c,
        `select a.id, a.student_id as "studentId", s.full_name as "studentName", a.absence_date as "date", a.direction, a.reason, a.status,
                u.full_name as "requestedBy", a.created_at as "createdAt"
         from absences a join students s on s.id = a.student_id join users u on u.id = a.requested_by
         where ($1::text is null or a.status = $1) and ($2::date is null or a.absence_date >= $2)
         order by a.absence_date, a.created_at limit 300`,
        [q.status ?? null, q.from ?? null],
      ),
    }));
  });

  app.post('/tenant/absences/:id/review', staff, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ decision: z.enum(['approved', 'rejected']) }), req.body);
    return withCtx(req.ctx, async (c) => {
      const a = await one(c, `update absences set status = $2, reviewed_by = $3, reviewed_at = now() where id = $1 and status = 'pending' returning tenant_id`, [id, body.decision, req.ctx.userId]);
      if (!a) throw notFound();
      await c.query(`select app.apply_absence($1)`, [id]);
      await enqueue(c, a.tenant_id, 'absence_updated', { absenceId: id });
      await audit(c, req.ctx, `absence.${body.decision}`, 'absence', id);
      return { ok: true };
    });
  });

  app.get('/tenant/audit', { preHandler: requireAuth(['tenant_admin']) }, async (req) =>
    withCtx(req.ctx, async (c) => ({
      entries: await many(
        c,
        `select l.id, l.action, l.entity, l.entity_id as "entityId", l.details, l.created_at as "createdAt", l.actor_role as "actorRole",
                u.full_name as "actorName"
         from audit_logs l left join users u on u.id = l.actor_user_id where l.tenant_id = $1 order by l.id desc limit 300`,
        [req.ctx.tenantId],
      ),
    })),
  );
}
