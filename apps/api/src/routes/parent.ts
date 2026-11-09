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

export async function parentRoutes(app: FastifyInstance) {
  const auth = { preHandler: requireAuth(['parent']) };

  /** بطاقات الأبناء: RLS تعيد الأبناء المرتبطين بولي الأمر فقط */
  app.get('/parent/children', auth, async (req) =>
    withCtx(req.ctx, async (c) => {
      const tenant = await loadTenant(c, req.ctx.tenantId!);
      const today = todayIn(tenant.timezone);
      const children = await many(c, `select id, full_name as "fullName", grade from students where status = 'active' order by full_name`);
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
        `select type, new_status as "newStatus", recorded_at as "recordedAt", source from boarding_events
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
        if (loc && stop && trip.riderStatus === 'expected') {
          eta = await etaProvider().estimate({ from: loc, to: stop, locationAgeSec: loc.ageSeconds });
        }
      }
      return {
        child,
        trip: {
          id: trip.id, status: trip.status, direction: trip.direction, plannedStart: trip.plannedStart,
          startedAt: trip.startedAt, endedAt: trip.endedAt, riderStatus: trip.riderStatus,
          boardedAt: trip.boardedAt, alightedAt: trip.alightedAt, bus, stop, events,
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
}
