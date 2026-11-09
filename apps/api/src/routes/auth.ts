import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withAuthDb, one, many, type Db } from '../db/pool.js';
import { AppError, badRequest } from '../lib/errors.js';
import { hashPassword, verifyPassword, randomToken, sha256, isStrongPassword } from '../lib/crypto.js';
import { signAccessToken, type AccessClaims } from '../lib/tokens.js';
import { requireAuth } from '../lib/auth.js';
import { parse, email, phone, name } from '../lib/util.js';
import { config } from '../config.js';
import { randomUUID } from 'node:crypto';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

interface ContextRow {
  membershipId: string;
  role: string;
  tenantId: string;
  tenantName: string;
  tenantNameEn: string | null;
  tenantCode: string;
  logoUrl: string | null;
}

async function listContexts(c: Db, userId: string) {
  const memberships = await many<ContextRow>(
    c,
    `select m.id as "membershipId", m.role, t.id as "tenantId", t.name as "tenantName",
            t.name_en as "tenantNameEn", t.code::text as "tenantCode", t.logo_url as "logoUrl"
     from memberships m join tenants t on t.id = m.tenant_id
     where m.user_id = $1 and m.status = 'active' and t.status = 'active'
     order by t.name, m.role`,
    [userId],
  );
  const u = await one<{ platform_role: string | null }>(c, 'select platform_role from users where id = $1', [userId]);
  // وصول دعم استثنائي نشط (مؤقت، قراءة فقط) — يظهر كخيار سياق لفريق المنصة فقط
  const accessGrants = u?.platform_role
    ? await many(
        c,
        `select g.id as "grantId", t.id as "tenantId", t.name as "tenantName", t.code::text as "tenantCode", g.expires_at as "expiresAt"
         from platform_access_grants g join tenants t on t.id = g.tenant_id
         where g.user_id = $1 and g.revoked_at is null and g.expires_at > now() order by g.expires_at desc`,
        [userId],
      )
    : [];
  return { memberships, platformAdmin: !!u?.platform_role, platformRole: u?.platform_role ?? null, accessGrants };
}

async function issueRefresh(c: Db, userId: string, familyId: string, userAgent?: string) {
  const token = randomToken(32);
  const ttlDays = config().REFRESH_TOKEN_TTL_DAYS;
  const row = await one<{ id: string }>(
    c,
    `insert into refresh_tokens (user_id, token_hash, family_id, expires_at, user_agent)
     values ($1, $2, $3, now() + make_interval(days => $4), $5) returning id`,
    [userId, sha256(token), familyId, ttlDays, userAgent?.slice(0, 200) ?? null],
  );
  return { token, id: row!.id };
}

async function resolveCtx(
  c: Db,
  userId: string,
  want: { membershipId?: string; platform?: boolean; accessGrantId?: string },
): Promise<AccessClaims['ctx']> {
  if (want.platform) {
    const u = await one(c, `select 1 from users where id = $1 and platform_role is not null and status = 'active'`, [userId]);
    if (!u) throw new AppError(403, 'forbidden');
    return { kind: 'platform' };
  }
  if (want.accessGrantId) {
    const g = await one(
      c,
      `select 1 from platform_access_grants g join users u on u.id = g.user_id
       where g.id = $1 and g.user_id = $2 and g.revoked_at is null and g.expires_at > now() and u.platform_role is not null`,
      [want.accessGrantId, userId],
    );
    if (!g) throw new AppError(403, 'forbidden');
    return { kind: 'grant', gid: want.accessGrantId };
  }
  if (want.membershipId) {
    const m = await one(
      c,
      `select 1 from memberships m join tenants t on t.id = m.tenant_id
       where m.id = $1 and m.user_id = $2 and m.status = 'active' and t.status = 'active'`,
      [want.membershipId, userId],
    );
    if (!m) throw new AppError(403, 'forbidden');
    return { kind: 'membership', mid: want.membershipId };
  }
  return { kind: 'none' };
}

async function sessionPayload(c: Db, userId: string, ctx: AccessClaims['ctx'], refreshToken: string) {
  const user = await one(c, `select id, full_name as "fullName", email, phone, locale from users where id = $1`, [userId]);
  const contexts = await listContexts(c, userId);
  return {
    accessToken: await signAccessToken({ sub: userId, ctx }),
    accessTokenExpiresIn: config().ACCESS_TOKEN_TTL_SEC,
    refreshToken,
    user,
    context: ctx,
    contexts,
  };
}

const credsSchema = z.object({
  identifier: z.string().trim().min(3).max(200),
  password: z.string().min(1).max(200),
  membershipId: z.string().uuid().optional(),
});

function normalizeIdentifier(id: string) {
  return id.includes('@') ? { email: id.toLowerCase() } : { phone: id.replace(/[\s-]/g, '') };
}

async function checkCredentials(c: Db, identifier: string, password: string) {
  const ident = normalizeIdentifier(identifier);
  const user = await one<{ id: string; password_hash: string; status: string; locked_until: Date | null; failed_logins: number }>(
    c,
    `select id, password_hash, status, locked_until, failed_logins from users where ${ident.email ? 'email = $1' : 'phone = $1'} for update`,
    [ident.email ?? ident.phone],
  );
  if (user?.locked_until && user.locked_until > new Date()) throw new AppError(429, 'account_locked');
  const ok = await verifyPassword(password, user?.password_hash);
  if (!user || !ok || user.status !== 'active') {
    if (user) {
      const failed = user.failed_logins + 1;
      await c.query(
        `update users set failed_logins = $2, locked_until = case when $3::boolean then now() + make_interval(mins => $4) else null end where id = $1`,
        [user.id, failed >= MAX_FAILED ? 0 : failed, failed >= MAX_FAILED, LOCK_MINUTES],
      );
      if (failed >= MAX_FAILED) {
        await c.query(
          `insert into audit_logs (actor_user_id, action, entity, entity_id, details) values ($1::uuid, 'auth.locked', 'user', $1::text, '{}')`,
          [user.id],
        );
      }
    }
    return null;
  }
  await c.query(`update users set failed_logins = 0, locked_until = null, last_login_at = now() where id = $1`, [user.id]);
  return user.id;
}

export async function authRoutes(app: FastifyInstance) {
  const strict = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  /** يحدد الجهة من رمزها فقط — لا يكشف أي بيانات مستخدمين أو طلاب */
  app.post('/auth/tenant/resolve', strict, async (req) => {
    const { code } = parse(z.object({ code: z.string().trim().min(4).max(20).regex(/^[A-Za-z0-9-]+$/) }), req.body);
    const t = await withAuthDb((c) =>
      one(c, `select id, code::text as code, name, name_en as "nameEn", logo_url as "logoUrl", kind, status from tenants where code = $1`, [code]),
    );
    if (!t) throw new AppError(404, 'tenant_not_found');
    if (t.status !== 'active') throw new AppError(403, 'tenant_suspended');
    return { tenant: { code: t.code, name: t.name, nameEn: t.nameEn, logoUrl: t.logoUrl, kind: t.kind } };
  });

  app.post('/auth/login', strict, async (req) => {
    const body = parse(credsSchema, req.body);
    // الفشل يُعاد كقيمة (لا يُرمى داخل المعاملة) حتى يُحفظ عدّاد المحاولات الفاشلة
    const out = await withAuthDb(async (c) => {
      const userId = await checkCredentials(c, body.identifier, body.password);
      if (!userId) return { fail: new AppError(401, 'invalid_credentials') } as const;
      let ctx = await resolveCtx(c, userId, { membershipId: body.membershipId });
      const contexts = await listContexts(c, userId);
      // اختيار تلقائي عند وجود سياق واحد فقط
      if (ctx.kind === 'none' && contexts.memberships.length === 1 && !contexts.platformAdmin) {
        ctx = { kind: 'membership', mid: contexts.memberships[0].membershipId };
      } else if (ctx.kind === 'none' && contexts.memberships.length === 0 && contexts.platformAdmin) {
        ctx = { kind: 'platform' };
      }
      const r = await issueRefresh(c, userId, randomUUID(), req.headers['user-agent']);
      await c.query(`insert into audit_logs (actor_user_id, action, entity, entity_id, ip) values ($1::uuid, 'auth.login', 'user', $1::text, $2)`, [userId, req.ip]);
      return { ok: await sessionPayload(c, userId, ctx, r.token) } as const;
    });
    if ('fail' in out) throw out.fail;
    return out.ok;
  });

  app.post('/auth/refresh', strict, async (req) => {
    const body = parse(
      z.object({ refreshToken: z.string().min(20).max(200), membershipId: z.string().uuid().optional(), platform: z.boolean().optional(), accessGrantId: z.string().uuid().optional() }),
      req.body,
    );
    const out = await withAuthDb(async (c) => {
      const row = await one<{ id: string; user_id: string; family_id: string; revoked_at: Date | null; expired: boolean }>(
        c,
        `select id, user_id, family_id, revoked_at, expires_at < now() as expired from refresh_tokens where token_hash = $1 for update`,
        [sha256(body.refreshToken)],
      );
      if (!row || row.expired) throw new AppError(401, 'unauthorized');
      if (row.revoked_at) {
        // إعادة استخدام رمز مُدوّر = احتمال سرقة: إبطال العائلة كاملة
        await c.query(`update refresh_tokens set revoked_at = coalesce(revoked_at, now()) where family_id = $1`, [row.family_id]);
        await c.query(`insert into audit_logs (actor_user_id, action, entity, entity_id) values ($1::uuid, 'auth.refresh_reuse', 'user', $1::text)`, [row.user_id]);
        return { fail: new AppError(401, 'unauthorized') } as const; // تُحفظ عملية الإبطال قبل الرد بالخطأ
      }
      const active = await one(c, `select 1 from users where id = $1 and status = 'active'`, [row.user_id]);
      if (!active) throw new AppError(401, 'unauthorized');
      // وصول استثنائي منتهٍ: نعيد المستخدم لسياق المنصة بدل إنهاء الجلسة
      let ctx: AccessClaims['ctx'];
      try {
        ctx = await resolveCtx(c, row.user_id, { membershipId: body.membershipId, platform: body.platform, accessGrantId: body.accessGrantId });
      } catch (e) {
        if (!body.accessGrantId) throw e;
        ctx = await resolveCtx(c, row.user_id, { platform: true });
      }
      const next = await issueRefresh(c, row.user_id, row.family_id, req.headers['user-agent']);
      await c.query(`update refresh_tokens set revoked_at = now(), replaced_by = $2 where id = $1`, [row.id, next.id]);
      return { ok: await sessionPayload(c, row.user_id, ctx, next.token) } as const;
    });
    if ('fail' in out) throw out.fail;
    return out.ok;
  });

  app.post('/auth/logout', async (req) => {
    const body = parse(z.object({ refreshToken: z.string().min(20).max(200) }), req.body);
    await withAuthDb((c) =>
      c.query(
        `update refresh_tokens set revoked_at = now() where family_id = (select family_id from refresh_tokens where token_hash = $1) and revoked_at is null`,
        [sha256(body.refreshToken)],
      ),
    );
    return { ok: true };
  });

  /** قائمة الجهات/الأدوار المرتبطة بالمستخدم (بعد المصادقة فقط) */
  app.get('/auth/contexts', { preHandler: requireAuth() }, async (req) =>
    withAuthDb((c) => listContexts(c, req.ctx.userId)),
  );

  /** اختيار سياق (جهة + دور) — يتحقق الخادم من العضوية */
  app.post('/auth/context', { preHandler: requireAuth() }, async (req) => {
    const body = parse(z.object({ membershipId: z.string().uuid().optional(), platform: z.boolean().optional(), accessGrantId: z.string().uuid().optional() }), req.body);
    if (!body.membershipId && !body.platform && !body.accessGrantId) throw badRequest();
    return withAuthDb(async (c) => {
      const ctx = await resolveCtx(c, req.ctx.userId, body);
      return { accessToken: await signAccessToken({ sub: req.ctx.userId, ctx }), accessTokenExpiresIn: config().ACCESS_TOKEN_TTL_SEC, context: ctx };
    });
  });

  // ------------------------------------------------------------------
  // الدعوات: رمز لمرة واحدة، مخزّن كبصمة، له صلاحية زمنية.
  // المعاينة تعرض اسم الجهة والدور فقط.
  // ------------------------------------------------------------------
  async function loadInvite(c: Db, token: string, lock = false) {
    const inv = await one(
      c,
      `select i.*, t.name as tenant_name, t.name_en as tenant_name_en, t.logo_url, t.kind, t.status as tenant_status, t.code::text as tenant_code
       from invites i join tenants t on t.id = i.tenant_id
       where i.token_hash = $1 ${lock ? 'for update of i' : ''}`,
      [sha256(token)],
    );
    if (!inv) {
      // دعوة للانضمام لفريق المنصة (مدير/دعم)
      const p = await one(c, `select * from platform_invites where token_hash = $1 ${lock ? 'for update' : ''}`, [sha256(token)]);
      if (!p || p.accepted_at || p.revoked_at || new Date(p.expires_at) < new Date()) throw new AppError(404, 'invite_invalid');
      return {
        ...p, platform: true, platform_role: p.role, role: `platform_${p.role}`, phone: null, student_ids: [],
        tenant_name: 'منصة باصنا', tenant_name_en: 'Busna platform', logo_url: null, kind: 'platform', tenant_code: null,
      };
    }
    if (inv.accepted_at || inv.revoked_at || new Date(inv.expires_at) < new Date() || inv.tenant_status !== 'active') {
      throw new AppError(404, 'invite_invalid');
    }
    return inv;
  }

  app.get('/auth/invites/:token', strict, async (req) => {
    const { token } = parse(z.object({ token: z.string().min(20).max(100) }), req.params);
    const inv = await withAuthDb((c) => loadInvite(c, token));
    return {
      invite: {
        role: inv.role,
        expiresAt: inv.expires_at,
        requiresEmail: !!inv.email,
        requiresPhone: !inv.email && !!inv.phone,
        tenant: { code: inv.tenant_code, name: inv.tenant_name, nameEn: inv.tenant_name_en, logoUrl: inv.logo_url, kind: inv.kind },
      },
    };
  });

  const acceptSchema = z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('register'),
      fullName: name,
      email: email.optional(),
      phone: phone.optional(),
      password: z.string().min(1).max(128),
    }),
    z.object({ mode: z.literal('login'), identifier: z.string().trim().min(3).max(200), password: z.string().min(1).max(200) }),
  ]);

  app.post('/auth/invites/:token/accept', strict, async (req) => {
    const { token } = parse(z.object({ token: z.string().min(20).max(100) }), req.params);
    const body = parse(acceptSchema, req.body);
    const out = await withAuthDb(async (c) => {
      const inv = await loadInvite(c, token, true);
      let userId: string;
      if (body.mode === 'register') {
        if (!body.email && !body.phone) throw badRequest('validation_failed', [{ path: 'email', message: 'email or phone required' }]);
        if (!isStrongPassword(body.password)) throw badRequest('weak_password');
        // الدعوة المرتبطة ببريد/جوال لا تُقبل إلا بنفس القيمة
        if (inv.email && body.email?.toLowerCase() !== String(inv.email).toLowerCase()) throw new AppError(400, 'invite_email_mismatch');
        if (!inv.email && inv.phone && body.phone !== inv.phone) throw new AppError(400, 'invite_email_mismatch');
        const exists = await one(c, `select 1 from users where (email = $1 and $1 is not null) or (phone = $2 and $2 is not null)`, [body.email ?? null, body.phone ?? null]);
        if (exists) throw new AppError(409, 'account_exists');
        const u = await one<{ id: string }>(
          c,
          `insert into users (email, phone, password_hash, full_name) values ($1, $2, $3, $4) returning id`,
          [body.email ?? null, body.phone ?? null, await hashPassword(body.password), body.fullName],
        );
        userId = u!.id;
      } else {
        const id = await checkCredentials(c, body.identifier, body.password);
        if (!id) return { fail: new AppError(401, 'invalid_credentials') } as const;
        userId = id;
        if (inv.email || inv.phone) {
          const u = await one(c, `select email::text, phone from users where id = $1`, [userId]);
          const matches = (inv.email && u.email?.toLowerCase() === String(inv.email).toLowerCase()) || (inv.phone && u.phone === inv.phone);
          if (!matches) throw new AppError(400, 'invite_email_mismatch');
        }
      }
      if (inv.platform) {
        await c.query(`update users set platform_role = $2 where id = $1`, [userId, inv.platform_role]);
        await c.query(`update platform_invites set accepted_at = now(), accepted_by = $2 where id = $1`, [inv.id, userId]);
        await c.query(
          `insert into audit_logs (actor_user_id, actor_role, action, entity, entity_id, details, ip)
           values ($1, $2, 'platform_invite.accepted', 'platform_invite', $3, $4, $5)`,
          [userId, inv.role, inv.id, JSON.stringify({ mode: body.mode }), req.ip],
        );
        const pr = await issueRefresh(c, userId, randomUUID(), req.headers['user-agent']);
        return { ok: await sessionPayload(c, userId, { kind: 'platform' }, pr.token) } as const;
      }
      const m = await one<{ id: string }>(
        c,
        `insert into memberships (tenant_id, user_id, role) values ($1, $2, $3)
         on conflict (tenant_id, user_id, role) do update set status = 'active' returning id`,
        [inv.tenant_id, userId, inv.role],
      );
      if (inv.role === 'parent' && inv.student_ids?.length) {
        await c.query(
          `insert into guardian_students (tenant_id, guardian_user_id, student_id)
           select $1, $2, s.id from students s where s.id = any($3::uuid[]) and s.tenant_id = $1
           on conflict do nothing`,
          [inv.tenant_id, userId, inv.student_ids],
        );
      }
      await c.query(`update invites set accepted_at = now(), accepted_by = $2 where id = $1`, [inv.id, userId]);
      await c.query(
        `insert into audit_logs (tenant_id, actor_user_id, actor_role, action, entity, entity_id, details, ip)
         values ($1, $2, $3, 'invite.accepted', 'invite', $4, $5, $6)`,
        [inv.tenant_id, userId, inv.role, inv.id, JSON.stringify({ mode: body.mode }), req.ip],
      );
      const r = await issueRefresh(c, userId, randomUUID(), req.headers['user-agent']);
      return { ok: await sessionPayload(c, userId, { kind: 'membership', mid: m!.id }, r.token) } as const;
    });
    if ('fail' in out) throw out.fail;
    return out.ok;
  });
}
