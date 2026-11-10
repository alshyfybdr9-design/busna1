/** تواصل الإدارة مع أولياء الأمور: الرسائل الجماعية، طلبات تغيير العنوان، المستلمون المصرّح لهم */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withCtx, one, many, type Db, type RequestContext } from '../db/pool.js';
import { requireAuth, STAFF } from '../lib/auth.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { parse, idParam, audit, todayIn, phone } from '../lib/util.js';
import { enqueue } from '../services/outbox.js';
import { loadTenant } from '../services/trips.js';

const WRITERS = ['tenant_admin', 'supervisor'] as const;

const broadcastBody = z
  .object({
    audience: z.enum(['all_parents', 'routes', 'trips', 'drivers', 'everyone']),
    routeIds: z.array(z.string().uuid()).max(50).default([]),
    tripIds: z.array(z.string().uuid()).max(50).default([]),
    category: z.enum(['delay', 'breakdown', 'route_change', 'weather', 'early_dismissal', 'general']),
    title: z.string().trim().min(2).max(120),
    body: z.string().trim().min(2).max(1000),
    delayMinutes: z.number().int().min(1).max(240).nullish(),
  })
  .refine((b) => b.audience !== 'routes' || b.routeIds.length > 0, { message: 'routeIds required', path: ['routeIds'] })
  .refine((b) => b.audience !== 'trips' || b.tripIds.length > 0, { message: 'tripIds required', path: ['tripIds'] });

const assignment = z.object({
  direction: z.enum(['to_school', 'from_school']),
  routeId: z.string().uuid(),
  stopId: z.string().uuid(),
});

/**
 * تطبيق طلب تغيير عنوان معتمد:
 *  - دائم: يُحدّث التعيين في route_riders (ويُزال من مسارات نفس الاتجاه الأخرى).
 *  - مؤقت: يُسجّل تعيين مؤقت للفترة ويُستخدم عند إنشاء رحلاتها.
 * في الحالتين تُحدّث الرحلات المجدولة (التي لم تبدأ) ضمن الفترة.
 */
async function applyStopChange(c: Db, ctx: RequestContext, r: any, assignments: z.infer<typeof assignment>[], today: string) {
  const from = r.start_date > today ? r.start_date : today;
  const to: string | null = r.kind === 'temporary' ? r.end_date : null;
  for (const a of assignments) {
    if (r.direction !== 'both' && r.direction !== a.direction) throw badRequest('direction_mismatch');
    const ok = await one(
      c,
      `select 1 from routes ro join route_stops st on st.route_id = ro.id
       where ro.id = $1 and st.id = $2 and ro.direction = $3 and ro.status = 'active' and st.kind = 'stop'`,
      [a.routeId, a.stopId, a.direction],
    );
    if (!ok) throw badRequest('invalid_route_or_stop');
    if (r.kind === 'permanent') {
      await c.query(
        `delete from route_riders rr using routes ro where rr.route_id = ro.id and ro.direction = $1 and rr.student_id = $2 and rr.route_id <> $3`,
        [a.direction, r.student_id, a.routeId],
      );
      await c.query(
        `insert into route_riders (tenant_id, route_id, student_id, stop_id) values ($1, $2, $3, $4)
         on conflict (route_id, student_id) do update set stop_id = excluded.stop_id`,
        [ctx.tenantId, a.routeId, r.student_id, a.stopId],
      );
    } else {
      await c.query(
        `insert into rider_overrides (tenant_id, request_id, student_id, direction, route_id, stop_id, start_date, end_date, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [ctx.tenantId, r.id, r.student_id, a.direction, a.routeId, a.stopId, r.start_date, r.end_date, ctx.userId],
      );
    }
    // الرحلات المجدولة التي لم تبدأ ضمن الفترة
    const range = `t.status = 'scheduled' and t.direction = $2 and t.service_date >= $3::date and ($4::date is null or t.service_date <= $4::date)`;
    await c.query(
      `delete from trip_riders tr using trips t where tr.trip_id = t.id and ${range} and tr.student_id = $1 and t.route_id <> $5
         and tr.status in ('expected', 'absent')`,
      [r.student_id, a.direction, from, to, a.routeId],
    );
    await c.query(
      `update trip_riders tr set stop_id = $6 from trips t where tr.trip_id = t.id and ${range} and tr.student_id = $1 and t.route_id = $5`,
      [r.student_id, a.direction, from, to, a.routeId, a.stopId],
    );
    await c.query(
      `insert into trip_riders (tenant_id, trip_id, student_id, stop_id, status)
       select t.tenant_id, t.id, $1, $6,
              case when exists (select 1 from absences ab where ab.student_id = $1 and ab.absence_date = t.service_date
                                and ab.status = 'approved' and (ab.direction = 'both' or ab.direction = t.direction))
                   then 'absent' else 'expected' end
       from trips t where ${range} and t.route_id = $5
       on conflict (trip_id, student_id) do nothing`,
      [r.student_id, a.direction, from, to, a.routeId, a.stopId],
    );
  }
}

export async function tenantCommsRoutes(app: FastifyInstance) {
  const staff = { preHandler: requireAuth(STAFF) };
  const writers = { preHandler: requireAuth([...WRITERS]) };

  // ---------------- الرسائل الجماعية ----------------
  app.get('/tenant/broadcasts', staff, async (req) =>
    withCtx(req.ctx, async (c) => ({
      broadcasts: await many(
        c,
        `select b.id, b.audience, b.route_ids as "routeIds", b.trip_ids as "tripIds", b.category, b.title, b.body,
                b.delay_minutes as "delayMinutes", b.recipient_count as "recipientCount", b.created_at as "createdAt",
                u.full_name as "createdBy"
         from broadcasts b left join users u on u.id = b.created_by
         order by b.created_at desc limit 100`,
      ),
    })),
  );

  app.post('/tenant/broadcasts', { ...writers, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const body = parse(broadcastBody, req.body);
    return withCtx(req.ctx, async (c) => {
      const routeIds = body.audience === 'routes' ? [...new Set(body.routeIds)] : [];
      const tripIds = body.audience === 'trips' ? [...new Set(body.tripIds)] : [];
      // RLS تعيد مسارات/رحلات الجهة فقط — أي معرّف من جهة أخرى يظهر كغير موجود
      if (routeIds.length) {
        const n = await one<{ n: number }>(c, `select count(*)::int as n from routes where id = any($1::uuid[])`, [routeIds]);
        if (n?.n !== routeIds.length) throw notFound();
      }
      if (tripIds.length) {
        const n = await one<{ n: number }>(c, `select count(*)::int as n from trips where id = any($1::uuid[])`, [tripIds]);
        if (n?.n !== tripIds.length) throw notFound();
      }
      const b = await one(
        c,
        `insert into broadcasts (tenant_id, created_by, audience, route_ids, trip_ids, category, title, body, delay_minutes)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id, created_at as "createdAt"`,
        [req.ctx.tenantId, req.ctx.userId, body.audience, routeIds, tripIds, body.category, body.title, body.body, body.delayMinutes ?? null],
      );
      await enqueue(c, req.ctx.tenantId!, 'broadcast', { broadcastId: b.id });
      await audit(c, req.ctx, 'broadcast.sent', 'broadcast', b.id, { audience: body.audience, category: body.category, routes: routeIds.length, trips: tripIds.length });
      return { broadcast: b };
    });
  });

  // ---------------- طلبات تغيير العنوان ----------------
  app.get('/tenant/stop-changes', staff, async (req) => {
    const q = parse(z.object({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional() }), req.query);
    return withCtx(req.ctx, async (c) => ({
      requests: await many(
        c,
        `select r.id, r.student_id as "studentId", s.full_name as "studentName", s.grade, r.kind, r.direction,
                r.start_date as "startDate", r.end_date as "endDate", r.address, r.lat, r.lng, r.note, r.status,
                r.review_note as "reviewNote", r.reviewed_at as "reviewedAt", r.created_at as "createdAt",
                u.full_name as "requestedBy", u.phone as "requesterPhone",
                (select json_agg(json_build_object('routeId', ro.id, 'routeName', ro.name, 'direction', ro.direction, 'stopId', st.id, 'stopName', st.name))
                   from route_riders rr join routes ro on ro.id = rr.route_id join route_stops st on st.id = rr.stop_id
                   where rr.student_id = r.student_id) as "currentRoutes"
         from stop_change_requests r join students s on s.id = r.student_id left join users u on u.id = r.requested_by
         where ($1::text is null or r.status = $1)
         order by (r.status = 'pending') desc, r.created_at desc limit 200`,
        [q.status ?? null],
      ),
    }));
  });

  app.post('/tenant/stop-changes/:id/review', writers, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        decision: z.enum(['approved', 'rejected']),
        note: z.string().trim().max(300).nullish(),
        assignments: z.array(assignment).max(2).default([]),
      }),
      req.body,
    );
    return withCtx(req.ctx, async (c) => {
      const r = await one(c, `select * from stop_change_requests where id = $1 for update`, [id]);
      if (!r) throw notFound();
      if (r.status !== 'pending') throw new AppError(409, 'request_not_pending');
      if (body.decision === 'approved') {
        if (!body.assignments.length) throw badRequest('assignment_required');
        if (new Set(body.assignments.map((a) => a.direction)).size !== body.assignments.length) throw badRequest('duplicate_direction');
        const tenant = await loadTenant(c, req.ctx.tenantId!);
        const today = todayIn(tenant.timezone);
        if (r.kind === 'temporary' && r.end_date < today) throw new AppError(409, 'request_expired');
        await applyStopChange(c, req.ctx, r, body.assignments, today);
      }
      await c.query(
        `update stop_change_requests set status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4 where id = $1`,
        [id, body.decision, req.ctx.userId, body.note ?? null],
      );
      await enqueue(c, req.ctx.tenantId!, 'stop_change_updated', { requestId: id });
      await audit(c, req.ctx, `stop_change.${body.decision}`, 'stop_change', id, { assignments: body.assignments });
      return { ok: true };
    });
  });

  // ---------------- المستلمون المصرّح لهم (من جهة الإدارة) ----------------
  app.post('/tenant/students/:id/pickups', writers, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({ fullName: z.string().trim().min(2).max(120), relationship: z.string().trim().max(40).nullish(), phone: phone.nullish() }),
      req.body,
    );
    return withCtx(req.ctx, async (c) => {
      const s = await one(c, `select id from students where id = $1`, [id]);
      if (!s) throw notFound();
      const n = await one<{ n: number }>(c, `select count(*)::int as n from authorized_pickups where student_id = $1 and status = 'active'`, [id]);
      if ((n?.n ?? 0) >= 6) throw new AppError(409, 'too_many_pickups');
      const p = await one(
        c,
        `insert into authorized_pickups (tenant_id, student_id, full_name, relationship, phone, added_by)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [req.ctx.tenantId, id, body.fullName, body.relationship ?? null, body.phone ?? null, req.ctx.userId],
      );
      await audit(c, req.ctx, 'pickup.added', 'student', id, { pickupId: p.id });
      return { pickup: p };
    });
  });

  app.post('/tenant/pickups/:id/revoke', writers, async (req) => {
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
}
