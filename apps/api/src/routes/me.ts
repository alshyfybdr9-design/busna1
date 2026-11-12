/** بيانات المستخدم الحالي، الإشعارات، رموز إشعارات الجوال */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withCtx, one, many } from '../db/pool.js';
import { requireAuth } from '../lib/auth.js';
import { notFound } from '../lib/errors.js';
import { parse, idParam } from '../lib/util.js';
import { tenantSettings } from '../config.js';

export async function meRoutes(app: FastifyInstance) {
  const auth = { preHandler: requireAuth(['tenant_admin', 'supervisor', 'driver', 'attendant', 'parent', 'platform_admin', 'platform_support', 'platform_readonly']) };

  app.get('/me', auth, async (req) =>
    withCtx(req.ctx, async (c) => {
      const user = await one(c, `select id, full_name as "fullName", email, phone, locale from users where id = $1`, [req.ctx.userId]);
      let tenant = null;
      if (req.ctx.tenantId) {
        const t = await one(
          c,
          `select id, code::text as code, name, name_en as "nameEn", kind, logo_url as "logoUrl", contact_phone as "contactPhone",
                  contact_email as "contactEmail", timezone, settings, is_demo as "isDemo" from tenants where id = $1`,
          [req.ctx.tenantId],
        );
        const s = tenantSettings(t.settings);
        // يُعرض للمستخدم ما يحتاجه فقط من الإعدادات
        tenant = { ...t, settings: undefined, emergencyNumber: s.emergencyNumber, supportHours: s.supportHours, staleAfterSec: s.staleAfterSec };
      }
      const unread = await one(c, `select count(*) as n from notifications where read_at is null`);
      let supportAccess = null;
      if (req.ctx.grantId) {
        supportAccess = await one(c, `select id, expires_at as "expiresAt", reason from platform_access_grants where id = $1`, [req.ctx.grantId]);
      }
      return { user, role: req.ctx.role, membershipId: req.ctx.membershipId, tenant, unreadNotifications: unread.n, supportAccess };
    }),
  );

  app.patch('/me', auth, async (req) => {
    const body = parse(z.object({ locale: z.enum(['ar', 'en']).optional(), fullName: z.string().trim().min(2).max(120).optional() }), req.body);
    return withCtx(req.ctx, async (c) => {
      await c.query(`update users set locale = coalesce($2, locale), full_name = coalesce($3, full_name) where id = $1`, [req.ctx.userId, body.locale ?? null, body.fullName ?? null]);
      return { ok: true };
    });
  });

  app.get('/me/notifications', auth, async (req) => {
    const q = parse(z.object({ before: z.string().datetime({ offset: true }).optional() }), req.query);
    return withCtx(req.ctx, async (c) => ({
      notifications: await many(
        c,
        `select id, kind, title, body, data, read_at as "readAt", created_at as "createdAt" from notifications
         where ($1::timestamptz is null or created_at < $1) order by created_at desc limit 50`,
        [q.before ?? null],
      ),
    }));
  });

  app.post('/me/notifications/:id/read', auth, async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(req.ctx, async (c) => {
      const r = await c.query(`update notifications set read_at = coalesce(read_at, now()) where id = $1`, [id]);
      if (!r.rowCount) throw notFound();
      return { ok: true };
    });
  });

  app.post('/me/notifications/read-all', auth, async (req) =>
    withCtx(req.ctx, async (c) => {
      await c.query(`update notifications set read_at = now() where read_at is null`);
      return { ok: true };
    }),
  );

  app.post('/me/push-tokens', auth, async (req) => {
    const body = parse(z.object({ token: z.string().trim().min(10).max(300), platform: z.enum(['ios', 'android', 'web']) }), req.body);
    return withCtx(req.ctx, async (c) => {
      if (!req.ctx.userId) throw notFound();
      // الرمز ينتقل للمستخدم الحالي عند تبديل الحساب على نفس الجهاز
      await c.query(`select app.claim_push_token($1, $2)`, [body.token, body.platform]);
      return { ok: true };
    });
  });

  app.delete('/me/push-tokens', auth, async (req) => {
    const body = parse(z.object({ token: z.string().trim().min(10).max(300) }), req.body);
    return withCtx(req.ctx, async (c) => {
      await c.query(`delete from push_tokens where token = $1`, [body.token]);
      return { ok: true };
    });
  });
}
