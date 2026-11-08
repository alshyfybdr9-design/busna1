/** إدارة المنصة: الجهات وحالتها وإحصاءات الاستخدام (أعداد فقط) وحالة النظام */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withCtx, one, many, withWorkerDb } from '../db/pool.js';
import { requireAuth } from '../lib/auth.js';
import { notFound } from '../lib/errors.js';
import { parse, idParam, audit, name, email, phone } from '../lib/util.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { config } from '../config.js';
import { inviteLinks } from './tenant-admin.js';
import { pushProvider } from '../integrations/push.js';
import { etaProvider } from '../integrations/routing.js';
import { workerStatus } from '../worker/dispatcher.js';

export async function platformRoutes(app: FastifyInstance) {
  const auth = { preHandler: requireAuth(['platform_admin']) };

  app.get('/platform/tenants', auth, async (req) =>
    withCtx(req.ctx, async (c) => {
      const tenants = await many(
        c,
        `select t.id, t.code::text as code, t.name, t.name_en as "nameEn", t.kind, t.status, t.is_demo as "isDemo", t.created_at as "createdAt",
                s.students, s.buses, s.drivers, s.parents, s.trips_today as "tripsToday", s.active_trips as "activeTrips"
         from tenants t left join app.tenant_usage_stats() s on s.tenant_id = t.id order by t.created_at desc`,
      );
      return { tenants };
    }),
  );

  app.post('/platform/tenants', auth, async (req) => {
    const body = parse(
      z.object({
        code: z.string().trim().regex(/^[A-Za-z0-9-]{4,20}$/),
        name,
        nameEn: z.string().trim().max(120).optional(),
        kind: z.enum(['school', 'transport_company']),
        contactPhone: phone.optional(),
        contactEmail: email.optional(),
        isDemo: z.boolean().default(false),
        admin: z.object({ fullName: name, email: email.optional(), phone: phone.optional() }),
      }),
      req.body,
    );
    return withCtx(req.ctx, async (c) => {
      const t = await one(
        c,
        `insert into tenants (code, name, name_en, kind, contact_phone, contact_email, is_demo) values ($1, $2, $3, $4, $5, $6, $7) returning id, code::text as code`,
        [body.code.toUpperCase(), body.name, body.nameEn ?? null, body.kind, body.contactPhone ?? null, body.contactEmail ?? null, body.isDemo],
      );
      const token = randomToken(24);
      const inv = await one(
        c,
        `insert into invites (tenant_id, token_hash, role, full_name, email, phone, expires_at, created_by)
         values ($1, $2, 'tenant_admin', $3, $4, $5, now() + make_interval(days => $6), $7) returning id, expires_at as "expiresAt"`,
        [t.id, sha256(token), body.admin.fullName, body.admin.email ?? null, body.admin.phone ?? null, config().INVITE_TTL_DAYS, req.ctx.userId],
      );
      await audit(c, req.ctx, 'platform.tenant_created', 'tenant', t.id, { code: t.code }, t.id);
      return { tenant: t, adminInvite: { id: inv.id, expiresAt: inv.expiresAt, ...inviteLinks(token) } };
    });
  });

  app.patch('/platform/tenants/:id', auth, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ status: z.enum(['active', 'suspended']) }), req.body);
    return withCtx(req.ctx, async (c) => {
      const r = await c.query(`update tenants set status = $2 where id = $1`, [id, body.status]);
      if (!r.rowCount) throw notFound();
      await audit(c, req.ctx, 'platform.tenant_status', 'tenant', id, { status: body.status }, id);
      return { ok: true };
    });
  });

  /** حالة النظام العامة — لا تحتوي بيانات شخصية */
  app.get('/platform/health', auth, async () => {
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
        email: { configured: false },
        sms: { configured: false },
        payments: { configured: false },
        ai: { configured: false },
      },
    };
  });
}
