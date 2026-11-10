import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withCtx, one, many } from '../db/pool.js';
import { requireAuth } from '../lib/auth.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { parse, idParam, isoDate, todayIn, audit } from '../lib/util.js';
import { applyRiderEvents, ingestLocations, loadTenant, riderCounts } from '../services/trips.js';
import { enqueue } from '../services/outbox.js';

const eventSchema = z.object({
  clientEventId: z.string().uuid(),
  studentId: z.string().uuid(),
  type: z.enum(['boarded', 'alighted', 'absent', 'no_show']),
  recordedAt: z.string().datetime({ offset: true }),
  source: z.enum(['manual', 'qr']).default('manual'),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  handover: z.object({ kind: z.enum(['guardian', 'authorized']), refId: z.string().uuid() }).nullish(),
});

const pointSchema = z.object({
  recordedAt: z.string().datetime({ offset: true }),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(100000).nullish(),
  speedMps: z.number().min(-1).max(100).nullish(),
  heading: z.number().min(-1).max(360).nullish(),
});

/** بنود فحص خلو الباص — كلها مطلوبة لنتيجة "الباص خالٍ" */
export const INSPECTION_ITEMS = ['walkedToRear', 'checkedSeats', 'checkedUnderSeats', 'checkedBackRow', 'noBelongingsLeft'] as const;

/** رسائل الإدارة الجماعية خلال آخر 24 ساعة (من إشعارات المستخدم نفسه) */
export async function recentMessages(c: Parameters<typeof one>[0]) {
  return many(
    c,
    `select id, title, body, created_at as "createdAt", read_at as "readAt" from notifications
     where kind = 'broadcast' and created_at > now() - interval '24 hours' order by created_at desc limit 5`,
  );
}

async function ownTrip(c: Parameters<typeof one>[0], tripId: string) {
  // RLS يعيد رحلات السائق فقط؛ أي رحلة أخرى تظهر كغير موجودة
  const trip = await one(c, `select * from trips where id = $1`, [tripId]);
  if (!trip) throw notFound();
  return trip;
}

export async function driverRoutes(app: FastifyInstance) {
  const auth = { preHandler: requireAuth(['driver']) };

  app.get('/driver/trips', auth, async (req) => {
    const q = parse(z.object({ date: isoDate.optional() }), req.query);
    return withCtx(req.ctx, async (c) => {
      const tenant = await loadTenant(c, req.ctx.tenantId!);
      const date = q.date ?? todayIn(tenant.timezone);
      const trips = await many(
        c,
        `select t.id, t.status, t.direction, t.service_date as "serviceDate", t.planned_start as "plannedStart",
                t.started_at as "startedAt", t.ended_at as "endedAt", t.inspection_status as "inspectionStatus",
                r.name as "routeName", b.plate_number as "busPlate", b.label as "busLabel",
                (select count(*) from trip_riders tr where tr.trip_id = t.id and tr.status not in ('absent')) as "riderCount"
         from trips t join routes r on r.id = t.route_id left join buses b on b.id = t.bus_id
         where t.driver_user_id = $1 and (t.service_date = $2 or t.status = 'in_progress'
               or (t.status = 'completed' and t.inspection_status = 'pending'))
         order by t.planned_start nulls last, t.created_at`,
        [req.ctx.userId, date],
      );
      return { date, trips, messages: await recentMessages(c) };
    });
  });

  app.get('/driver/trips/:id', auth, async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(req.ctx, async (c) => {
      const trip = await ownTrip(c, id);
      const tenant = await loadTenant(c, req.ctx.tenantId!);
      const route = await one(c, `select id, name from routes where id = $1`, [trip.route_id]);
      const bus = trip.bus_id ? await one(c, `select id, plate_number as "plate", label from buses where id = $1`, [trip.bus_id]) : null;
      const stops = await many(
        c,
        `select id, seq, name, kind, lat, lng, planned_time as "plannedTime" from route_stops where route_id = $1 order by seq`,
        [trip.route_id],
      );
      // السائق يرى الاسم والصف ونقطة التوقف فقط — بدون ملاحظات أو بيانات أولياء الأمور
      const riders = await many(
        c,
        `select tr.id, tr.student_id as "studentId", s.full_name as "fullName", s.grade, tr.stop_id as "stopId",
                tr.status, tr.boarded_at as "boardedAt", tr.alighted_at as "alightedAt",
                (s.requires_handover and $2 = 'from_school' and coalesce(st.kind, 'stop') <> 'school') as "requiresHandover"
         from trip_riders tr join students s on s.id = tr.student_id left join route_stops st on st.id = tr.stop_id
         where tr.trip_id = $1 order by s.full_name`,
        [id, trip.direction],
      );
      // المستلمون المصرّح لهم: الاسم والقرابة فقط — لطلاب التسليم الآمن في رحلة العودة
      const receivers = trip.direction === 'from_school' && riders.some((r) => r.requiresHandover)
        ? await many(c, `select student_id as "studentId", kind, ref_id as "refId", full_name as "fullName", relationship from app.trip_receivers($1) order by kind, full_name`, [id])
        : [];
      const inspection = await one(c, `select result, completed_at as "completedAt" from trip_inspections where trip_id = $1`, [id]);
      return {
        trip: {
          id: trip.id, status: trip.status, direction: trip.direction, serviceDate: trip.service_date,
          plannedStart: trip.planned_start, startedAt: trip.started_at, endedAt: trip.ended_at,
          inspectionStatus: trip.inspection_status, route, bus,
        },
        stops,
        riders: riders.map((r) => ({ ...r, receivers: r.requiresHandover ? receivers.filter((x) => x.studentId === r.studentId) : undefined })),
        counts: await riderCounts(c, id),
        inspection,
        inspectionItems: INSPECTION_ITEMS,
        tracking: { intervalSec: tenant.cfg.locationIntervalSec },
        safety: {
          emergencyNumber: tenant.cfg.emergencyNumber,
          supervisorPhone: tenant.contact_phone,
          requireRearQrScan: tenant.cfg.requireRearQrScan,
        },
      };
    });
  });

  app.post('/driver/trips/:id/start', auth, async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(req.ctx, async (c) => {
      const trip = await ownTrip(c, id);
      const tenant = await loadTenant(c, req.ctx.tenantId!);
      if (trip.status === 'in_progress') return { status: 'in_progress', alreadyStarted: true, tracking: { intervalSec: tenant.cfg.locationIntervalSec } };
      if (trip.status !== 'scheduled' || trip.service_date !== todayIn(tenant.timezone)) throw new AppError(409, 'trip_not_startable');
      // رحلة جارية أخرى لنفس السائق تمنع البدء
      const other = await one(c, `select id from trips where driver_user_id = $1 and status = 'in_progress' and id <> $2`, [req.ctx.userId, id]);
      if (other) throw new AppError(409, 'trip_not_startable', { activeTripId: other.id });
      await c.query(`update trips set status = 'in_progress', started_at = now() where id = $1`, [id]);
      await enqueue(c, trip.tenant_id, 'trip_started', { tripId: id });
      await audit(c, req.ctx, 'trip.started', 'trip', id);
      return { status: 'in_progress', tracking: { intervalSec: tenant.cfg.locationIntervalSec } };
    });
  });

  app.post('/driver/trips/:id/events', { ...auth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ events: z.array(eventSchema).min(1).max(200) }), req.body);
    return withCtx(req.ctx, async (c) => {
      await ownTrip(c, id);
      const results = await applyRiderEvents(c, req.ctx, id, body.events);
      return { results, counts: await riderCounts(c, id) };
    });
  });

  app.post('/driver/trips/:id/locations', { ...auth, config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ points: z.array(pointSchema).min(1).max(500) }), req.body);
    return withCtx(req.ctx, async (c) => {
      await ownTrip(c, id);
      return ingestLocations(c, id, body.points);
    });
  });

  /** QR معرّف مساعد فقط: يعيد الطالب إن كان في هذه الرحلة، والتسجيل يتطلب تأكيد السائق */
  app.post('/driver/trips/:id/qr', auth, async (req) => {
    const { id } = parse(idParam, req.params);
    const { qrToken } = parse(z.object({ qrToken: z.string().trim().min(8).max(64).regex(/^[a-zA-Z0-9]+$/) }), req.body);
    return withCtx(req.ctx, async (c) => {
      await ownTrip(c, id);
      const r = await one(
        c,
        `select tr.id, tr.student_id as "studentId", s.full_name as "fullName", s.grade, tr.status, tr.stop_id as "stopId"
         from trip_riders tr join students s on s.id = tr.student_id where tr.trip_id = $1 and s.qr_token = $2`,
        [id, qrToken.toLowerCase()],
      );
      if (!r) throw new AppError(404, 'qr_not_on_trip');
      return { rider: r, requiresConfirmation: true };
    });
  });

  app.post('/driver/trips/:id/end', auth, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ acknowledgeUnresolved: z.boolean().default(false) }), req.body ?? {});
    return withCtx(req.ctx, async (c) => {
      const trip = await ownTrip(c, id);
      if (trip.status !== 'in_progress') throw new AppError(409, 'trip_not_active');
      const riders = await many(
        c,
        `select tr.id, tr.student_id as "studentId", s.full_name as "fullName", tr.status
         from trip_riders tr join students s on s.id = tr.student_id
         where tr.trip_id = $1 and tr.status in ('boarded', 'expected') order by s.full_name`,
        [id],
      );
      const onboard = riders.filter((r) => r.status === 'boarded');
      const unrecorded = riders.filter((r) => r.status === 'expected');
      if ((onboard.length || unrecorded.length) && !body.acknowledgeUnresolved) {
        throw new AppError(409, 'unresolved_riders', { onboard, unrecorded });
      }
      await c.query(`update trips set status = 'completed', ended_at = now(), inspection_status = 'pending' where id = $1`, [id]);
      // طلاب صعدوا ولم يُسجل نزولهم: تنبيه حرج للمشرف — لا تُغيّر حالتهم تلقائيًا
      if (onboard.length) {
        const a = await one(
          c,
          `insert into safety_alerts (tenant_id, trip_id, kind, severity, details, created_by, dedupe_key)
           values ($1, $2, 'unresolved_riders', 'critical', $3, $4, $5) returning id`,
          [trip.tenant_id, id, JSON.stringify({ students: onboard.map((r) => ({ studentId: r.studentId, fullName: r.fullName })) }), req.ctx.userId, `unresolved:${id}`],
        );
        await enqueue(c, trip.tenant_id, 'safety_alert', { alertId: a!.id });
      }
      // طلاب لم يُسجل لهم أي حدث: يحتاج المشرف للتحقق منهم
      if (unrecorded.length) {
        const a = await one(
          c,
          `insert into safety_alerts (tenant_id, trip_id, kind, severity, details, created_by, dedupe_key)
           values ($1, $2, 'unrecorded_riders', 'high', $3, $4, $5) returning id`,
          [trip.tenant_id, id, JSON.stringify({ students: unrecorded.map((r) => ({ studentId: r.studentId, fullName: r.fullName })) }), req.ctx.userId, `unrecorded:${id}`],
        );
        await enqueue(c, trip.tenant_id, 'safety_alert', { alertId: a!.id });
      }
      await audit(c, req.ctx, 'trip.completed', 'trip', id, { onboard: onboard.length, unrecorded: unrecorded.length });
      return { status: 'completed', inspectionRequired: true, escalated: onboard.length + unrecorded.length > 0, onboard, unrecorded };
    });
  });

  app.post('/driver/trips/:id/inspection', auth, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        clientEventId: z.string().uuid(),
        startedAt: z.string().datetime({ offset: true }),
        checklist: z.record(z.enum(INSPECTION_ITEMS), z.boolean()),
        result: z.enum(['bus_empty', 'child_found', 'issue']),
        rearQrToken: z.string().trim().max(64).optional(),
        issueCategory: z.enum(['damage', 'cleanliness', 'lost_item', 'other']).optional(),
      }),
      req.body,
    );
    return withCtx(req.ctx, async (c) => {
      const trip = await ownTrip(c, id);
      const existing = await one(c, `select result, client_event_id from trip_inspections where trip_id = $1`, [id]);
      if (existing) {
        if (existing.client_event_id === body.clientEventId) return { status: 'duplicate', result: existing.result };
        throw new AppError(409, 'inspection_not_pending');
      }
      if (trip.status !== 'completed' || trip.inspection_status !== 'pending') throw new AppError(409, 'inspection_not_pending');
      if (body.result === 'bus_empty') {
        const missing = INSPECTION_ITEMS.filter((k) => body.checklist[k] !== true);
        if (missing.length) throw badRequest('inspection_incomplete', { missing });
      }
      const tenant = await loadTenant(c, req.ctx.tenantId!);
      let rearScanVerified = false;
      if (body.rearQrToken) {
        const bus = await one(c, `select rear_qr_token from buses where id = $1`, [trip.bus_id]);
        if (!bus || bus.rear_qr_token !== body.rearQrToken.toLowerCase()) throw badRequest('rear_qr_mismatch');
        rearScanVerified = true;
      } else if (tenant.cfg.requireRearQrScan && body.result === 'bus_empty') {
        throw badRequest('inspection_incomplete', { missing: ['rearQrToken'] });
      }
      await c.query(
        `insert into trip_inspections (tenant_id, trip_id, driver_user_id, checklist, result, started_at, completed_at, client_event_id, notes)
         values ($1, $2, $3, $4, $5, $6, now(), $7, $8)`,
        [trip.tenant_id, id, req.ctx.userId, JSON.stringify({ ...body.checklist, rearScanVerified }), body.result, body.startedAt,
          body.clientEventId, body.issueCategory ?? null],
      );
      await c.query(`update trips set inspection_status = $2 where id = $1`, [id, body.result === 'bus_empty' ? 'completed' : 'issue_reported']);
      if (body.result !== 'bus_empty') {
        const a = await one(
          c,
          `insert into safety_alerts (tenant_id, trip_id, kind, severity, details, created_by, dedupe_key)
           values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [trip.tenant_id, id, body.result === 'child_found' ? 'child_found' : 'issue', body.result === 'child_found' ? 'critical' : 'medium',
            JSON.stringify({ source: 'inspection', category: body.issueCategory ?? null }), req.ctx.userId, `inspection:${id}`],
        );
        await enqueue(c, trip.tenant_id, 'safety_alert', { alertId: a!.id });
      }
      await audit(c, req.ctx, 'trip.inspection', 'trip', id, { result: body.result, rearScanVerified });
      return { status: 'recorded', result: body.result, rearScanVerified, selfDeclared: true };
    });
  });

  /**
   * لا يوجد مستلم مصرّح له عند نقطة التوقف: يبقى الطالب في الباص،
   * ويصل تنبيه للإدارة وإشعار لأولياء الأمور. لا يُسجّل نزول.
   */
  app.post('/driver/trips/:id/riders/:studentId/no-receiver', auth, async (req) => {
    const p = parse(z.object({ id: z.string().uuid(), studentId: z.string().uuid() }), req.params);
    const body = parse(z.object({ lat: z.number().min(-90).max(90).nullish(), lng: z.number().min(-180).max(180).nullish() }), req.body ?? {});
    return withCtx(req.ctx, async (c) => {
      const trip = await ownTrip(c, p.id);
      if (trip.status !== 'in_progress') throw new AppError(409, 'trip_not_active');
      const rider = await one(
        c,
        `select tr.id, tr.status, s.full_name from trip_riders tr join students s on s.id = tr.student_id where tr.trip_id = $1 and tr.student_id = $2`,
        [p.id, p.studentId],
      );
      if (!rider) throw notFound();
      if (rider.status !== 'boarded') throw new AppError(409, 'invalid_transition');
      const tenant = await loadTenant(c, req.ctx.tenantId!);
      const call = { emergencyNumber: tenant.cfg.emergencyNumber, supervisorPhone: tenant.contact_phone };
      const a = await one(
        c,
        `insert into safety_alerts (tenant_id, trip_id, kind, severity, details, created_by, dedupe_key)
         values ($1, $2, 'no_receiver', 'high', $3, $4, $5)
         on conflict (tenant_id, dedupe_key) do nothing returning id`,
        [trip.tenant_id, p.id, JSON.stringify({ studentId: p.studentId, fullName: rider.full_name, lat: body.lat ?? null, lng: body.lng ?? null }),
          req.ctx.userId, `no_receiver:${p.id}:${p.studentId}`],
      );
      if (!a) return { duplicate: true, call };
      await enqueue(c, trip.tenant_id, 'safety_alert', { alertId: a.id });
      await enqueue(c, trip.tenant_id, 'no_receiver', { tripId: p.id, studentId: p.studentId });
      await audit(c, req.ctx, 'trip.no_receiver', 'trip', p.id, { studentId: p.studentId });
      return { alertId: a.id, call };
    });
  });

  /** بلاغ مشكلة/طوارئ بخيارات جاهزة — بدون كتابة أثناء القيادة */
  app.post('/driver/report', auth, async (req) => {
    const body = parse(
      z.object({
        tripId: z.string().uuid().nullish(),
        kind: z.enum(['emergency', 'issue']),
        category: z.enum(['accident', 'medical', 'breakdown', 'traffic', 'student_behavior', 'child_left_on_bus', 'other']),
        lat: z.number().min(-90).max(90).nullish(),
        lng: z.number().min(-180).max(180).nullish(),
        clientEventId: z.string().uuid(),
      }),
      req.body,
    );
    return withCtx(req.ctx, async (c) => {
      if (body.tripId) await ownTrip(c, body.tripId);
      const tenant = await loadTenant(c, req.ctx.tenantId!);
      const critical = body.kind === 'emergency' || body.category === 'child_left_on_bus';
      const call = { emergencyNumber: tenant.cfg.emergencyNumber, supervisorPhone: tenant.contact_phone };
      // إعادة إرسال نفس البلاغ (بعد انقطاع) لا تُنشئ تنبيهًا مكررًا
      const dup = await one(c, `select id from safety_alerts where tenant_id = $1 and dedupe_key = $2`, [req.ctx.tenantId, `report:${body.clientEventId}`]);
      if (dup) return { alertId: dup.id, duplicate: true, call };
      const a = await one(
        c,
        `insert into safety_alerts (tenant_id, trip_id, kind, severity, details, created_by, dedupe_key)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [req.ctx.tenantId, body.tripId ?? null, body.kind, critical ? 'critical' : body.category === 'breakdown' ? 'high' : 'medium',
          JSON.stringify({ category: body.category, lat: body.lat ?? null, lng: body.lng ?? null }), req.ctx.userId, `report:${body.clientEventId}`],
      );
      await enqueue(c, req.ctx.tenantId!, 'safety_alert', { alertId: a!.id });
      await audit(c, req.ctx, `driver.report.${body.kind}`, 'safety_alert', a!.id, { category: body.category });
      // التطبيق يعرض أزرار الاتصال المباشر فورًا — البلاغ لا يغني عن الاتصال في الطوارئ
      return { alertId: a!.id, call };
    });
  });
}
