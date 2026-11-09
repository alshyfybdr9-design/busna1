/** إدارة الجهة: الملف والإعدادات، الأعضاء والدعوات، الطلاب، الباصات، المسارات */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withCtx, one, many } from '../db/pool.js';
import { requireAuth, STAFF } from '../lib/auth.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { parse, idParam, audit, name, email, phone } from '../lib/util.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { config, tenantSettings, tenantSettingsSchema } from '../config.js';

const timeStr = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/);

export function inviteLinks(token: string) {
  const c = config();
  return { inviteUrl: `${c.APP_PUBLIC_URL}/invite/${token}`, appUrl: `${c.APP_SCHEME}://invite/${token}` };
}

export async function tenantAdminRoutes(app: FastifyInstance) {
  const staff = { preHandler: requireAuth(STAFF) };
  const admin = { preHandler: requireAuth(['tenant_admin']) };

  // ---------------- الملف والإعدادات ----------------
  app.get('/tenant/profile', staff, async (req) =>
    withCtx(req.ctx, async (c) => {
      const t = await one(
        c,
        `select id, code::text as code, name, name_en as "nameEn", kind, logo_url as "logoUrl", contact_phone as "contactPhone",
                contact_email as "contactEmail", timezone, settings, is_demo as "isDemo" from tenants where id = $1`,
        [req.ctx.tenantId],
      );
      return { tenant: { ...t, settings: tenantSettings(t.settings) } };
    }),
  );

  app.patch('/tenant/profile', admin, async (req) => {
    const body = parse(
      z.object({
        name: name.optional(),
        nameEn: z.string().trim().max(120).nullish(),
        logoUrl: z.string().url().startsWith('https://').max(500).nullish(),
        contactPhone: phone.nullish(),
        contactEmail: email.nullish(),
        settings: tenantSettingsSchema.partial().optional(),
      }),
      req.body,
    );
    return withCtx(req.ctx, async (c) => {
      const cur = await one(c, `select settings from tenants where id = $1`, [req.ctx.tenantId]);
      const settings = body.settings ? { ...tenantSettings(cur.settings), ...body.settings } : undefined;
      await c.query(
        `update tenants set
           name = coalesce($2, name),
           name_en = case when $3::boolean then $4 else name_en end,
           logo_url = case when $5::boolean then $6 else logo_url end,
           contact_phone = case when $7::boolean then $8 else contact_phone end,
           contact_email = case when $9::boolean then $10 else contact_email end,
           settings = coalesce($11::jsonb, settings)
         where id = $1`,
        [req.ctx.tenantId, body.name ?? null, body.nameEn !== undefined, body.nameEn ?? null, body.logoUrl !== undefined, body.logoUrl ?? null,
          body.contactPhone !== undefined, body.contactPhone ?? null, body.contactEmail !== undefined, body.contactEmail ?? null,
          settings ? JSON.stringify(settings) : null],
      );
      await audit(c, req.ctx, 'tenant.profile_updated', 'tenant', req.ctx.tenantId, { fields: Object.keys(body) });
      return { ok: true };
    });
  });

  // ---------------- الاشتراك ووصول دعم المنصة ----------------
  app.get('/tenant/subscription', staff, async (req) =>
    withCtx(req.ctx, async (c) => ({ subscription: await one(c, `select * from app.tenant_plan()`) })),
  );

  app.get('/tenant/support-access', admin, async (req) =>
    withCtx(req.ctx, async (c) => ({
      grants: await many(
        c,
        `select g.id, g.reason, g.created_at as "createdAt", g.expires_at as "expiresAt", g.revoked_at as "revokedAt",
                (g.revoked_at is null and g.expires_at > now()) as active,
                (select count(*) from audit_logs a where a.tenant_id = g.tenant_id and a.action = 'platform_access.view' and a.details->>'grantId' = g.id::text) as "viewsLogged"
         from platform_access_grants g where g.tenant_id = $1 order by g.created_at desc limit 100`,
        [req.ctx.tenantId],
      ),
    })),
  );

  app.post('/tenant/support-access/:id/revoke', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(req.ctx, async (c) => {
      const r = await c.query(`update platform_access_grants set revoked_at = now(), revoked_by = $2 where id = $1 and tenant_id = $3 and revoked_at is null`, [id, req.ctx.userId, req.ctx.tenantId]);
      if (!r.rowCount) throw notFound();
      await audit(c, req.ctx, 'platform_access.revoked_by_tenant', 'platform_access_grant', id);
      return { ok: true };
    });
  });

  // ---------------- الأعضاء والدعوات ----------------
  app.get('/tenant/members', staff, async (req) => {
    const q = parse(z.object({ role: z.enum(['tenant_admin', 'supervisor', 'driver', 'parent']).optional() }), req.query);
    return withCtx(req.ctx, async (c) => ({
      members: await many(
        c,
        `select m.id, m.role, m.status, m.user_id as "userId", u.full_name as "fullName", u.email, u.phone, m.created_at as "createdAt",
                (select count(*) from guardian_students gs where gs.guardian_user_id = m.user_id and gs.tenant_id = m.tenant_id) as "childrenCount"
         from memberships m join users u on u.id = m.user_id
         where m.tenant_id = $1 and ($2::text is null or m.role = $2) order by m.role, u.full_name`,
        [req.ctx.tenantId, q.role ?? null],
      ),
    }));
  });

  app.patch('/tenant/members/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ status: z.enum(['active', 'disabled']) }), req.body);
    if (id === req.ctx.membershipId) throw new AppError(400, 'forbidden');
    return withCtx(req.ctx, async (c) => {
      const r = await c.query(`update memberships set status = $2 where id = $1 and tenant_id = $3`, [id, body.status, req.ctx.tenantId]);
      if (!r.rowCount) throw notFound();
      await audit(c, req.ctx, 'membership.status_changed', 'membership', id, { status: body.status });
      return { ok: true };
    });
  });

  app.get('/tenant/invites', staff, async (req) =>
    withCtx(req.ctx, async (c) => ({
      invites: await many(
        c,
        `select id, role, full_name as "fullName", email, phone, expires_at as "expiresAt", created_at as "createdAt",
                accepted_at as "acceptedAt", revoked_at as "revokedAt", cardinality(student_ids) as "studentCount"
         from invites where tenant_id = $1 order by created_at desc limit 200`,
        [req.ctx.tenantId],
      ),
    })),
  );

  app.post('/tenant/invites', staff, async (req) => {
    const body = parse(
      z.object({
        role: z.enum(['tenant_admin', 'supervisor', 'driver', 'parent']),
        fullName: name,
        email: email.optional(),
        phone: phone.optional(),
        studentIds: z.array(z.string().uuid()).max(10).default([]),
      }),
      req.body,
    );
    if (req.ctx.role === 'supervisor' && !['parent', 'driver'].includes(body.role)) throw new AppError(403, 'forbidden');
    if (body.studentIds.length && body.role !== 'parent') throw badRequest();
    return withCtx(req.ctx, async (c) => {
      if (body.role === 'driver') {
        // حد السائقين في الخطة: نمنع الدعوة مبكرًا بدل فشل قبولها لاحقًا
        const plan = await one(c, `select max_drivers, drivers from app.tenant_plan()`);
        if (plan?.max_drivers != null && plan.drivers >= plan.max_drivers) throw new AppError(409, 'plan_limit_reached', { kind: 'drivers' });
      }
      if (body.studentIds.length) {
        const found = await one<{ n: number }>(c, `select count(*) as n from students where id = any($1::uuid[])`, [body.studentIds]);
        if (found!.n !== body.studentIds.length) throw notFound();
      }
      const token = randomToken(24);
      const inv = await one(
        c,
        `insert into invites (tenant_id, token_hash, role, full_name, email, phone, student_ids, expires_at, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(days => $8), $9) returning id, expires_at as "expiresAt"`,
        [req.ctx.tenantId, sha256(token), body.role, body.fullName, body.email ?? null, body.phone ?? null, body.studentIds,
          config().INVITE_TTL_DAYS, req.ctx.userId],
      );
      await audit(c, req.ctx, 'invite.created', 'invite', inv.id, { role: body.role, students: body.studentIds.length });
      // الرمز يُعرض مرة واحدة فقط؛ يُخزن كبصمة. الإرسال بالبريد/SMS يتطلب مزودًا خارجيًا (غير مُعدّ).
      return { invite: { id: inv.id, expiresAt: inv.expiresAt, ...inviteLinks(token) }, delivery: 'manual' };
    });
  });

  app.post('/tenant/invites/:id/revoke', staff, async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(req.ctx, async (c) => {
      const r = await c.query(`update invites set revoked_at = now() where id = $1 and accepted_at is null and revoked_at is null`, [id]);
      if (!r.rowCount) throw notFound();
      await audit(c, req.ctx, 'invite.revoked', 'invite', id);
      return { ok: true };
    });
  });

  // ---------------- الطلاب ----------------
  const studentBody = z.object({
    fullName: name,
    grade: z.string().trim().max(40).nullish(),
    schoolName: z.string().trim().max(120).nullish(),
    studentCode: z.string().trim().max(40).nullish(),
    notes: z.string().trim().max(500).nullish(),
    status: z.enum(['active', 'inactive']).optional(),
  });

  app.get('/tenant/students', staff, async (req) => {
    const q = parse(z.object({ q: z.string().trim().max(100).optional(), status: z.enum(['active', 'inactive']).optional() }), req.query);
    return withCtx(req.ctx, async (c) => ({
      students: await many(
        c,
        `select s.id, s.full_name as "fullName", s.grade, s.school_name as "schoolName", s.student_code as "studentCode", s.status,
                (select count(*) from guardian_students gs where gs.student_id = s.id) as "guardianCount",
                (select json_agg(json_build_object('routeId', r.id, 'routeName', r.name, 'direction', r.direction, 'stopName', st.name))
                   from route_riders rr join routes r on r.id = rr.route_id join route_stops st on st.id = rr.stop_id
                   where rr.student_id = s.id) as routes
         from students s
         where ($1::text is null or s.full_name ilike '%' || $1 || '%' or s.student_code = $1)
           and ($2::text is null or s.status = $2)
         order by s.full_name limit 500`,
        [q.q ?? null, q.status ?? null],
      ),
    }));
  });

  app.post('/tenant/students', staff, async (req) => {
    const body = parse(studentBody, req.body);
    return withCtx(req.ctx, async (c) => {
      const s = await one(
        c,
        `insert into students (tenant_id, full_name, grade, school_name, student_code, notes)
         values ($1, $2, $3, $4, $5, $6) returning id, full_name as "fullName"`,
        [req.ctx.tenantId, body.fullName, body.grade ?? null, body.schoolName ?? null, body.studentCode ?? null, body.notes ?? null],
      );
      await audit(c, req.ctx, 'student.created', 'student', s.id);
      return { student: s };
    });
  });

  app.get('/tenant/students/:id', staff, async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(req.ctx, async (c) => {
      const s = await one(
        c,
        `select id, full_name as "fullName", grade, school_name as "schoolName", student_code as "studentCode", notes, status,
                qr_token as "qrToken", created_at as "createdAt" from students where id = $1`,
        [id],
      );
      if (!s) throw notFound();
      const guardians = await many(
        c,
        `select u.id as "userId", u.full_name as "fullName", u.phone, u.email, gs.relationship
         from guardian_students gs join users u on u.id = gs.guardian_user_id where gs.student_id = $1`,
        [id],
      );
      const routes = await many(
        c,
        `select rr.id, r.id as "routeId", r.name as "routeName", r.direction, st.id as "stopId", st.name as "stopName"
         from route_riders rr join routes r on r.id = rr.route_id join route_stops st on st.id = rr.stop_id where rr.student_id = $1`,
        [id],
      );
      const pendingInvites = await many(
        c,
        `select id, full_name as "fullName", expires_at as "expiresAt" from invites
         where $1::uuid = any(student_ids) and accepted_at is null and revoked_at is null and expires_at > now()`,
        [id],
      );
      return { student: s, guardians, routes, pendingInvites };
    });
  });

  app.patch('/tenant/students/:id', staff, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(studentBody.partial(), req.body);
    return withCtx(req.ctx, async (c) => {
      const r = await c.query(
        `update students set full_name = coalesce($2, full_name), grade = coalesce($3, grade), school_name = coalesce($4, school_name),
           student_code = coalesce($5, student_code), notes = coalesce($6, notes), status = coalesce($7, status) where id = $1`,
        [id, body.fullName ?? null, body.grade ?? null, body.schoolName ?? null, body.studentCode ?? null, body.notes ?? null, body.status ?? null],
      );
      if (!r.rowCount) throw notFound();
      await audit(c, req.ctx, 'student.updated', 'student', id, { fields: Object.keys(body) });
      return { ok: true };
    });
  });

  app.post('/tenant/students/:id/rotate-qr', staff, async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(req.ctx, async (c) => {
      const r = await one(c, `update students set qr_token = encode(gen_random_bytes(16), 'hex') where id = $1 returning qr_token as "qrToken"`, [id]);
      if (!r) throw notFound();
      await audit(c, req.ctx, 'student.qr_rotated', 'student', id);
      return r;
    });
  });

  app.post('/tenant/students/:id/guardians', staff, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ userId: z.string().uuid(), relationship: z.string().trim().max(40).optional() }), req.body);
    return withCtx(req.ctx, async (c) => {
      const m = await one(c, `select 1 from memberships where tenant_id = $1 and user_id = $2 and role = 'parent'`, [req.ctx.tenantId, body.userId]);
      const s = await one(c, `select 1 from students where id = $1`, [id]);
      if (!m || !s) throw notFound();
      await c.query(
        `insert into guardian_students (tenant_id, guardian_user_id, student_id, relationship) values ($1, $2, $3, $4) on conflict do nothing`,
        [req.ctx.tenantId, body.userId, id, body.relationship ?? null],
      );
      await audit(c, req.ctx, 'guardian.linked', 'student', id, { guardianUserId: body.userId });
      return { ok: true };
    });
  });

  app.delete('/tenant/students/:id/guardians/:userId', staff, async (req) => {
    const p = parse(z.object({ id: z.string().uuid(), userId: z.string().uuid() }), req.params);
    return withCtx(req.ctx, async (c) => {
      const r = await c.query(`delete from guardian_students where student_id = $1 and guardian_user_id = $2`, [p.id, p.userId]);
      if (!r.rowCount) throw notFound();
      await audit(c, req.ctx, 'guardian.unlinked', 'student', p.id, { guardianUserId: p.userId });
      return { ok: true };
    });
  });

  // ---------------- الباصات ----------------
  const busBody = z.object({
    plateNumber: z.string().trim().min(2).max(20),
    label: z.string().trim().max(60).nullish(),
    capacity: z.number().int().min(1).max(120).nullish(),
    status: z.enum(['active', 'maintenance', 'retired']).optional(),
  });

  app.get('/tenant/buses', staff, async (req) =>
    withCtx(req.ctx, async (c) => ({
      buses: await many(
        c,
        `select id, plate_number as "plateNumber", label, capacity, status, rear_qr_token as "rearQrToken" from buses order by label nulls last, plate_number`,
      ),
    })),
  );

  app.post('/tenant/buses', admin, async (req) => {
    const body = parse(busBody, req.body);
    return withCtx(req.ctx, async (c) => {
      const b = await one(
        c,
        `insert into buses (tenant_id, plate_number, label, capacity) values ($1, $2, $3, $4) returning id`,
        [req.ctx.tenantId, body.plateNumber, body.label ?? null, body.capacity ?? null],
      );
      await audit(c, req.ctx, 'bus.created', 'bus', b.id);
      return { bus: b };
    });
  });

  app.patch('/tenant/buses/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(busBody.partial(), req.body);
    return withCtx(req.ctx, async (c) => {
      const r = await c.query(
        `update buses set plate_number = coalesce($2, plate_number), label = coalesce($3, label), capacity = coalesce($4, capacity),
           status = coalesce($5, status) where id = $1`,
        [id, body.plateNumber ?? null, body.label ?? null, body.capacity ?? null, body.status ?? null],
      );
      if (!r.rowCount) throw notFound();
      await audit(c, req.ctx, 'bus.updated', 'bus', id, { fields: Object.keys(body) });
      return { ok: true };
    });
  });

  // ---------------- المسارات والنقاط والجداول ----------------
  async function assertDriver(c: Parameters<typeof one>[0], tenantId: string, userId: string | null | undefined) {
    if (!userId) return;
    const m = await one(c, `select 1 from memberships where tenant_id = $1 and user_id = $2 and role = 'driver' and status = 'active'`, [tenantId, userId]);
    if (!m) throw badRequest('invalid_driver');
  }

  app.get('/tenant/routes', staff, async (req) =>
    withCtx(req.ctx, async (c) => ({
      routes: await many(
        c,
        `select r.id, r.name, r.direction, r.status, r.bus_id as "busId", b.label as "busLabel", b.plate_number as "busPlate",
                r.driver_user_id as "driverUserId", u.full_name as "driverName",
                (select count(*) from route_stops s where s.route_id = r.id) as "stopCount",
                (select count(*) from route_riders rr where rr.route_id = r.id) as "riderCount"
         from routes r left join buses b on b.id = r.bus_id left join users u on u.id = r.driver_user_id
         order by r.name`,
      ),
    })),
  );

  const routeBody = z.object({
    name: z.string().trim().min(2).max(100),
    direction: z.enum(['to_school', 'from_school']),
    busId: z.string().uuid().nullish(),
    driverUserId: z.string().uuid().nullish(),
    status: z.enum(['active', 'inactive']).optional(),
  });

  app.post('/tenant/routes', admin, async (req) => {
    const body = parse(routeBody, req.body);
    return withCtx(req.ctx, async (c) => {
      await assertDriver(c, req.ctx.tenantId!, body.driverUserId);
      const r = await one(
        c,
        `insert into routes (tenant_id, name, direction, bus_id, driver_user_id) values ($1, $2, $3, $4, $5) returning id`,
        [req.ctx.tenantId, body.name, body.direction, body.busId ?? null, body.driverUserId ?? null],
      );
      await audit(c, req.ctx, 'route.created', 'route', r.id);
      return { route: r };
    });
  });

  app.patch('/tenant/routes/:id', staff, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(routeBody.partial(), req.body);
    // تغيير السائق/الباص مسموح للمشرف (تغييرات تعيين)، أما الاسم والاتجاه والحالة فلمدير الجهة
    if (req.ctx.role !== 'tenant_admin' && (body.name || body.direction || body.status)) throw new AppError(403, 'forbidden');
    return withCtx(req.ctx, async (c) => {
      await assertDriver(c, req.ctx.tenantId!, body.driverUserId);
      const r = await c.query(
        `update routes set name = coalesce($2, name), direction = coalesce($3, direction),
           bus_id = case when $4::boolean then $5::uuid else bus_id end,
           driver_user_id = case when $6::boolean then $7::uuid else driver_user_id end,
           status = coalesce($8, status) where id = $1`,
        [id, body.name ?? null, body.direction ?? null, body.busId !== undefined, body.busId ?? null,
          body.driverUserId !== undefined, body.driverUserId ?? null, body.status ?? null],
      );
      if (!r.rowCount) throw notFound();
      await audit(c, req.ctx, 'route.updated', 'route', id, body);
      return { ok: true };
    });
  });

  app.get('/tenant/routes/:id', staff, async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(req.ctx, async (c) => {
      const route = await one(
        c,
        `select r.id, r.name, r.direction, r.status, r.bus_id as "busId", r.driver_user_id as "driverUserId" from routes r where r.id = $1`,
        [id],
      );
      if (!route) throw notFound();
      const stops = await many(c, `select id, seq, name, kind, lat, lng, planned_time as "plannedTime" from route_stops where route_id = $1 order by seq`, [id]);
      const riders = await many(
        c,
        `select rr.id, rr.student_id as "studentId", s.full_name as "fullName", s.grade, rr.stop_id as "stopId"
         from route_riders rr join students s on s.id = rr.student_id where rr.route_id = $1 order by s.full_name`,
        [id],
      );
      const schedules = await many(c, `select id, days_of_week as "daysOfWeek", departure_time as "departureTime", status from schedules where route_id = $1`, [id]);
      return { route, stops, riders, schedules };
    });
  });

  /** استبدال قائمة نقاط التوقف بالترتيب (النقاط الموجودة تُحدَّث بالمعرف) */
  app.put('/tenant/routes/:id/stops', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        stops: z.array(z.object({
          id: z.string().uuid().optional(),
          name: z.string().trim().min(1).max(100),
          kind: z.enum(['stop', 'school']).default('stop'),
          lat: z.number().min(-90).max(90),
          lng: z.number().min(-180).max(180),
          plannedTime: timeStr.nullish(),
        })).max(100),
      }),
      req.body,
    );
    return withCtx(req.ctx, async (c) => {
      const route = await one(c, `select id from routes where id = $1`, [id]);
      if (!route) throw notFound();
      const keep = body.stops.filter((s) => s.id).map((s) => s.id!);
      const inUse = await one(
        c,
        `select count(*) as n from route_riders where route_id = $1 and not (stop_id = any($2::uuid[]))`,
        [id, keep],
      );
      if (inUse.n > 0) throw new AppError(409, 'conflict', { reason: 'stop_has_riders' });
      await c.query(`delete from route_stops where route_id = $1 and not (id = any($2::uuid[]))`, [id, keep]);
      for (const [i, s] of body.stops.entries()) {
        if (s.id) {
          const r = await c.query(
            `update route_stops set seq = $3, name = $4, kind = $5, lat = $6, lng = $7, planned_time = $8 where id = $1 and route_id = $2`,
            [s.id, id, i + 1, s.name, s.kind, s.lat, s.lng, s.plannedTime ?? null],
          );
          if (!r.rowCount) throw notFound();
        } else {
          await c.query(
            `insert into route_stops (tenant_id, route_id, seq, name, kind, lat, lng, planned_time) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [req.ctx.tenantId, id, i + 1, s.name, s.kind, s.lat, s.lng, s.plannedTime ?? null],
          );
        }
      }
      await audit(c, req.ctx, 'route.stops_updated', 'route', id, { count: body.stops.length });
      return { stops: await many(c, `select id, seq, name, kind, lat, lng, planned_time as "plannedTime" from route_stops where route_id = $1 order by seq`, [id]) };
    });
  });

  /** تعيين طالب لمسار ونقطة توقف */
  app.put('/tenant/routes/:id/riders/:studentId', staff, async (req) => {
    const p = parse(z.object({ id: z.string().uuid(), studentId: z.string().uuid() }), req.params);
    const body = parse(z.object({ stopId: z.string().uuid() }), req.body);
    return withCtx(req.ctx, async (c) => {
      const stop = await one(c, `select id from route_stops where id = $1 and route_id = $2 and kind = 'stop'`, [body.stopId, p.id]);
      const student = await one(c, `select id from students where id = $1 and status = 'active'`, [p.studentId]);
      if (!stop || !student) throw notFound();
      await c.query(
        `insert into route_riders (tenant_id, route_id, student_id, stop_id) values ($1, $2, $3, $4)
         on conflict (route_id, student_id) do update set stop_id = excluded.stop_id`,
        [req.ctx.tenantId, p.id, p.studentId, body.stopId],
      );
      await audit(c, req.ctx, 'route.rider_assigned', 'route', p.id, { studentId: p.studentId, stopId: body.stopId });
      return { ok: true };
    });
  });

  app.delete('/tenant/routes/:id/riders/:studentId', staff, async (req) => {
    const p = parse(z.object({ id: z.string().uuid(), studentId: z.string().uuid() }), req.params);
    return withCtx(req.ctx, async (c) => {
      const r = await c.query(`delete from route_riders where route_id = $1 and student_id = $2`, [p.id, p.studentId]);
      if (!r.rowCount) throw notFound();
      await audit(c, req.ctx, 'route.rider_removed', 'route', p.id, { studentId: p.studentId });
      return { ok: true };
    });
  });

  app.post('/tenant/routes/:id/schedules', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7), departureTime: timeStr }), req.body);
    return withCtx(req.ctx, async (c) => {
      const route = await one(c, `select id from routes where id = $1`, [id]);
      if (!route) throw notFound();
      const s = await one(
        c,
        `insert into schedules (tenant_id, route_id, days_of_week, departure_time) values ($1, $2, $3, $4) returning id`,
        [req.ctx.tenantId, id, [...new Set(body.daysOfWeek)], body.departureTime],
      );
      await audit(c, req.ctx, 'schedule.created', 'route', id, body);
      return { schedule: s };
    });
  });

  app.delete('/tenant/schedules/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(req.ctx, async (c) => {
      const r = await c.query(`update schedules set status = 'inactive' where id = $1`, [id]);
      if (!r.rowCount) throw notFound();
      await audit(c, req.ctx, 'schedule.deactivated', 'schedule', id);
      return { ok: true };
    });
  });
}
