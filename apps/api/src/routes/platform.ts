/**
 * إدارة المنصة: الجهات واشتراكاتها وحدودها، فريق المنصة، الوصول الاستثنائي المؤقت، وحالة النظام.
 * مدير المنصة: كل شيء. دعم المنصة: عرض الجهات + التذاكر + دليل التطبيق + طلب وصول مؤقت (قراءة فقط).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withCtx, withAuthDb, one, many, withWorkerDb } from '../db/pool.js';
import { requireAuth, PLATFORM } from '../lib/auth.js';
import { AppError, notFound } from '../lib/errors.js';
import { parse, idParam, audit, name, email, phone } from '../lib/util.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { config, tenantSettings } from '../config.js';
import { inviteLinks } from './tenant-admin.js';
import { pushProvider } from '../integrations/push.js';
import { etaProvider } from '../integrations/routing.js';
import { aiProvider } from '../integrations/ai.js';
import { workerStatus } from '../worker/dispatcher.js';

const planBody = z.object({
  code: z.string().trim().regex(/^[a-z0-9_-]{2,30}$/),
  name: z.string().trim().min(2).max(80),
  maxStudents: z.number().int().positive().nullable(),
  maxBuses: z.number().int().positive().nullable(),
  maxDrivers: z.number().int().positive().nullable(),
  assistantDailyLimit: z.number().int().min(0).nullable(),
  monthlyPrice: z.number().min(0).nullable(),
  currency: z.string().trim().length(3).default('SAR'),
  active: z.boolean().default(true),
});

export async function platformRoutes(app: FastifyInstance) {
  const admin = { preHandler: requireAuth(['platform_admin']) };
  const staff = { preHandler: requireAuth(PLATFORM) };

  // ---------------- الجهات ----------------
  app.get('/platform/tenants', staff, async (req) =>
    withCtx(req.ctx, async (c) => {
      const tenants = await many(
        c,
        `select t.id, t.code::text as code, t.name, t.name_en as "nameEn", t.kind, t.status, t.is_demo as "isDemo", t.created_at as "createdAt",
                coalesce((t.settings->>'allowPlatformSupportAccess')::boolean, true) as "allowsSupportAccess",
                s.students, s.buses, s.drivers, s.parents, s.trips_today as "tripsToday", s.active_trips as "activeTrips",
                sub.status as "subscriptionStatus", sub.current_period_end as "periodEnd", sub.notes as "subscriptionNotes",
                p.id as "planId", p.code as "planCode", p.name as "planName",
                p.max_students as "maxStudents", p.max_buses as "maxBuses", p.max_drivers as "maxDrivers"
         from tenants t left join app.tenant_usage_stats() s on s.tenant_id = t.id
         left join tenant_subscriptions sub on sub.tenant_id = t.id left join platform_plans p on p.id = sub.plan_id
         order by t.created_at desc`,
      );
      return { tenants, canManage: req.ctx.role === 'platform_admin' };
    }),
  );

  app.post('/platform/tenants', admin, async (req) => {
    const body = parse(
      z.object({
        code: z.string().trim().regex(/^[A-Za-z0-9-]{4,20}$/),
        name,
        nameEn: z.string().trim().max(120).optional(),
        kind: z.enum(['school', 'transport_company']),
        contactPhone: phone.optional(),
        contactEmail: email.optional(),
        isDemo: z.boolean().default(false),
        planCode: z.string().default('trial'),
        admin: z.object({ fullName: name, email: email.optional(), phone: phone.optional() }),
      }),
      req.body,
    );
    return withCtx(req.ctx, async (c) => {
      const plan = await one(c, `select id, code from platform_plans where code = $1 and active`, [body.planCode]);
      if (!plan) throw notFound();
      const t = await one(
        c,
        `insert into tenants (code, name, name_en, kind, contact_phone, contact_email, is_demo) values ($1, $2, $3, $4, $5, $6, $7) returning id, code::text as code`,
        [body.code.toUpperCase(), body.name, body.nameEn ?? null, body.kind, body.contactPhone ?? null, body.contactEmail ?? null, body.isDemo],
      );
      await c.query(
        `insert into tenant_subscriptions (tenant_id, plan_id, status, current_period_end, updated_by)
         values ($1, $2, $3, case when $3 = 'trial' then current_date + 30 else null end, $4)`,
        [t.id, plan.id, plan.code === 'trial' ? 'trial' : 'active', req.ctx.userId],
      );
      const token = randomToken(24);
      const inv = await one(
        c,
        `insert into invites (tenant_id, token_hash, role, full_name, email, phone, expires_at, created_by)
         values ($1, $2, 'tenant_admin', $3, $4, $5, now() + make_interval(days => $6), $7) returning id, expires_at as "expiresAt"`,
        [t.id, sha256(token), body.admin.fullName, body.admin.email ?? null, body.admin.phone ?? null, config().INVITE_TTL_DAYS, req.ctx.userId],
      );
      await audit(c, req.ctx, 'platform.tenant_created', 'tenant', t.id, { code: t.code, plan: plan.code }, t.id);
      return { tenant: t, adminInvite: { id: inv.id, expiresAt: inv.expiresAt, ...inviteLinks(token) } };
    });
  });

  app.patch('/platform/tenants/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ status: z.enum(['active', 'suspended']) }), req.body);
    return withCtx(req.ctx, async (c) => {
      const r = await c.query(`update tenants set status = $2 where id = $1`, [id, body.status]);
      if (!r.rowCount) throw notFound();
      await audit(c, req.ctx, 'platform.tenant_status', 'tenant', id, { status: body.status }, id);
      return { ok: true };
    });
  });

  app.put('/platform/tenants/:id/subscription', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        planId: z.string().uuid(),
        status: z.enum(['trial', 'active', 'past_due', 'cancelled']),
        currentPeriodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
        notes: z.string().trim().max(500).nullable().optional(),
      }),
      req.body,
    );
    return withCtx(req.ctx, async (c) => {
      const t = await one(c, `select id from tenants where id = $1`, [id]);
      const p = await one(c, `select id, code from platform_plans where id = $1`, [body.planId]);
      if (!t || !p) throw notFound();
      // الخفض لخطة أصغر من الاستهلاك الحالي مسموح، لكن الإضافات الجديدة تُمنع حتى يقل الاستهلاك
      await c.query(
        `insert into tenant_subscriptions (tenant_id, plan_id, status, current_period_end, notes, updated_by)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (tenant_id) do update set plan_id = excluded.plan_id, status = excluded.status,
           current_period_end = excluded.current_period_end, notes = excluded.notes, updated_by = excluded.updated_by`,
        [id, body.planId, body.status, body.currentPeriodEnd, body.notes ?? null, req.ctx.userId],
      );
      await audit(c, req.ctx, 'platform.subscription_updated', 'tenant', id, { plan: p.code, status: body.status, periodEnd: body.currentPeriodEnd }, id);
      return { ok: true };
    });
  });

  // ---------------- الخطط ----------------
  app.get('/platform/plans', staff, async (req) =>
    withCtx(req.ctx, async (c) => ({
      plans: await many(
        c,
        `select p.id, p.code, p.name, p.max_students as "maxStudents", p.max_buses as "maxBuses", p.max_drivers as "maxDrivers",
                p.assistant_daily_limit as "assistantDailyLimit", p.monthly_price::float as "monthlyPrice", p.currency, p.active,
                (select count(*) from tenant_subscriptions s where s.plan_id = p.id) as "tenantCount"
         from platform_plans p order by p.max_students nulls last, p.created_at`,
      ),
    })),
  );

  app.post('/platform/plans', admin, async (req) => {
    const b = parse(planBody, req.body);
    return withCtx(req.ctx, async (c) => {
      const r = await one(
        c,
        `insert into platform_plans (code, name, max_students, max_buses, max_drivers, assistant_daily_limit, monthly_price, currency, active)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [b.code, b.name, b.maxStudents, b.maxBuses, b.maxDrivers, b.assistantDailyLimit, b.monthlyPrice, b.currency.toUpperCase(), b.active],
      );
      await audit(c, req.ctx, 'platform.plan_created', 'platform_plan', r.id, { code: b.code });
      return { plan: r };
    });
  });

  app.patch('/platform/plans/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(planBody.omit({ code: true }), req.body);
    return withCtx(req.ctx, async (c) => {
      const r = await c.query(
        `update platform_plans set name = $2, max_students = $3, max_buses = $4, max_drivers = $5, assistant_daily_limit = $6,
           monthly_price = $7, currency = $8, active = $9 where id = $1`,
        [id, b.name, b.maxStudents, b.maxBuses, b.maxDrivers, b.assistantDailyLimit, b.monthlyPrice, b.currency.toUpperCase(), b.active],
      );
      if (!r.rowCount) throw notFound();
      await audit(c, req.ctx, 'platform.plan_updated', 'platform_plan', id, b);
      return { ok: true };
    });
  });

  // ---------------- فريق المنصة ----------------
  app.get('/platform/staff', admin, async (req) =>
    withCtx(req.ctx, async (c) => ({
      staff: await many(
        c,
        `select id, full_name as "fullName", email, platform_role as role, status, created_at as "createdAt"
         from users where platform_role is not null order by platform_role, full_name`,
      ),
      invites: await many(
        c,
        `select id, full_name as "fullName", email, role, expires_at as "expiresAt", accepted_at as "acceptedAt", revoked_at as "revokedAt", created_at as "createdAt"
         from platform_invites order by created_at desc limit 100`,
      ),
    })),
  );

  app.post('/platform/staff/invites', admin, async (req) => {
    const b = parse(z.object({ fullName: name, email, role: z.enum(['admin', 'support']) }), req.body);
    return withCtx(req.ctx, async (c) => {
      const token = randomToken(24);
      const inv = await one(
        c,
        `insert into platform_invites (token_hash, role, full_name, email, expires_at, created_by)
         values ($1, $2, $3, $4, now() + make_interval(days => $5), $6) returning id, expires_at as "expiresAt"`,
        [sha256(token), b.role, b.fullName, b.email, config().INVITE_TTL_DAYS, req.ctx.userId],
      );
      await audit(c, req.ctx, 'platform.staff_invited', 'platform_invite', inv.id, { role: b.role });
      return { invite: { id: inv.id, expiresAt: inv.expiresAt, ...inviteLinks(token) } };
    });
  });

  app.post('/platform/staff/invites/:id/revoke', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(req.ctx, async (c) => {
      const r = await c.query(`update platform_invites set revoked_at = now() where id = $1 and accepted_at is null and revoked_at is null`, [id]);
      if (!r.rowCount) throw notFound();
      await audit(c, req.ctx, 'platform.staff_invite_revoked', 'platform_invite', id);
      return { ok: true };
    });
  });

  /** تغيير دور عضو فريق المنصة أو إزالته (role = null) */
  app.patch('/platform/staff/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ role: z.enum(['admin', 'support']).nullable() }), req.body);
    if (id === req.ctx.userId) throw new AppError(400, 'forbidden');
    // تعديل دور المنصة يتم عبر دور المصادقة (busna_app لا يملك تعديل هذا العمود)
    await withAuthDb(async (c) => {
      const u = await one(c, `select platform_role from users where id = $1 and platform_role is not null for update`, [id]);
      if (!u) throw notFound();
      if (u.platform_role === 'admin' && b.role !== 'admin') {
        const admins = await one(c, `select count(*)::int as n from users where platform_role = 'admin' and status = 'active'`);
        if (admins.n <= 1) throw new AppError(409, 'last_platform_admin');
      }
      await c.query(`update users set platform_role = $2 where id = $1`, [id, b.role]);
      await c.query(
        `insert into audit_logs (actor_user_id, actor_role, action, entity, entity_id, details, ip)
         values ($1, 'platform_admin', 'platform.staff_role_changed', 'user', $2, $3, $4)`,
        [req.ctx.userId, id, JSON.stringify({ from: u.platform_role, to: b.role }), req.ip],
      );
    });
    return { ok: true };
  });

  // ---------------- الوصول الاستثنائي المؤقت ----------------
  app.post('/platform/access-grants', staff, async (req) => {
    const b = parse(
      z.object({
        tenantId: z.string().uuid(),
        reason: z.string().trim().min(15).max(500),
        durationMinutes: z.number().int().min(5).max(60).default(30),
        ticketRef: z.number().int().positive().optional(),
      }),
      req.body,
    );
    return withCtx(req.ctx, async (c) => {
      const t = await one(c, `select id, name, settings from tenants where id = $1 and status = 'active'`, [b.tenantId]);
      if (!t) throw notFound();
      if (!tenantSettings(t.settings).allowPlatformSupportAccess) throw new AppError(403, 'support_access_disabled');
      let ticketId: string | null = null;
      if (b.ticketRef) {
        const tk = await one(c, `select id from support_tickets where ref = $1 and tenant_id = $2`, [b.ticketRef, b.tenantId]);
        if (!tk) throw notFound();
        ticketId = tk.id;
      }
      const g = await one(
        c,
        `insert into platform_access_grants (tenant_id, user_id, reason, ticket_id, expires_at)
         values ($1, $2, $3, $4, now() + make_interval(mins => $5)) returning id, expires_at as "expiresAt"`,
        [b.tenantId, req.ctx.userId, b.reason, ticketId, b.durationMinutes],
      );
      // يُسجَّل في سجل تدقيق الجهة نفسها ويُبلَّغ مديروها فورًا
      await audit(c, req.ctx, 'platform_access.granted', 'platform_access_grant', g.id,
        { reason: b.reason, minutes: b.durationMinutes, ticketRef: b.ticketRef ?? null }, b.tenantId);
      await c.query(`insert into outbox_events (tenant_id, kind, payload) values ($1, 'support_access', $2)`, [b.tenantId, JSON.stringify({ grantId: g.id })]);
      return { grant: { id: g.id, expiresAt: g.expiresAt, tenantName: t.name } };
    });
  });

  app.get('/platform/access-grants', staff, async (req) =>
    withCtx(req.ctx, async (c) => ({
      grants: await many(
        c,
        `select g.id, g.reason, g.created_at as "createdAt", g.expires_at as "expiresAt", g.revoked_at as "revokedAt",
                (g.revoked_at is null and g.expires_at > now()) as active, t.name as "tenantName", u.full_name as "userName",
                st.ref as "ticketRef",
                (select count(*) from audit_logs a where a.action = 'platform_access.view' and a.details->>'grantId' = g.id::text) as "viewsLogged"
         from platform_access_grants g join tenants t on t.id = g.tenant_id left join users u on u.id = g.user_id
         left join support_tickets st on st.id = g.ticket_id
         order by g.created_at desc limit 200`,
      ),
    })),
  );

  app.post('/platform/access-grants/:id/revoke', staff, async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(req.ctx, async (c) => {
      const g = await one(c, `update platform_access_grants set revoked_at = now(), revoked_by = $2 where id = $1 and revoked_at is null returning tenant_id`, [id, req.ctx.userId]);
      if (!g) throw notFound();
      await audit(c, req.ctx, 'platform_access.revoked', 'platform_access_grant', id, {}, g.tenant_id);
      return { ok: true };
    });
  });

  // ---------------- حالة النظام ----------------
  app.get('/platform/health', staff, async () => {
    const backlog = await withWorkerDb((c) =>
      one(c, `select count(*) filter (where processed_at is null) as pending, count(*) filter (where processed_at is null and attempts >= 5) as failed from outbox_events`),
    );
    return {
      database: 'ok',
      outbox: backlog,
      worker: workerStatus,
      integrations: {
        push: { provider: pushProvider().name, configured: pushProvider().configured },
        eta: { provider: etaProvider().name, configured: etaProvider().name !== 'none' },
        ai: { provider: aiProvider().name, configured: aiProvider().configured },
        email: { configured: false },
        sms: { configured: false },
        payments: { configured: false },
      },
    };
  });
}
