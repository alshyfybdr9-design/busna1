import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from './errors.js';
import { verifyAccessToken } from './tokens.js';
import { withAuthDb, one, type RequestContext } from '../db/pool.js';

export type Role = RequestContext['role'];

declare module 'fastify' {
  interface FastifyRequest {
    ctx: RequestContext;
  }
}

/**
 * يتحقق من رمز الوصول ثم يعيد التحقق من العضوية في الخادم في كل طلب
 * (حتى يسري إيقاف العضوية أو الجهة فورًا). الدور والجهة يأتيان من قاعدة البيانات، لا من العميل.
 */
export function requireAuth(roles?: Role[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw new AppError(401, 'unauthorized');
    let claims;
    try {
      claims = await verifyAccessToken(h.slice(7));
    } catch {
      throw new AppError(401, 'unauthorized');
    }
    const ip = req.ip;
    let ctx: RequestContext;
    if (claims.ctx.kind === 'membership') {
      const mid = claims.ctx.mid;
      const m = await withAuthDb((c) =>
        one<{ id: string; tenant_id: string; role: Role; ok: boolean }>(
          c,
          `select m.id, m.tenant_id, m.role,
                  (m.status = 'active' and t.status = 'active' and u.status = 'active') as ok
           from memberships m join tenants t on t.id = m.tenant_id join users u on u.id = m.user_id
           where m.id = $1 and m.user_id = $2`,
          [mid, claims.sub],
        ),
      );
      if (!m || !m.ok) throw new AppError(401, 'unauthorized');
      ctx = { userId: claims.sub, role: m.role, tenantId: m.tenant_id, membershipId: m.id, ip };
    } else if (claims.ctx.kind === 'platform') {
      const u = await withAuthDb((c) =>
        one<{ ok: boolean }>(c, `select (is_platform_admin and status = 'active') as ok from users where id = $1`, [claims.sub]),
      );
      if (!u?.ok) throw new AppError(401, 'unauthorized');
      ctx = { userId: claims.sub, role: 'platform_admin', tenantId: null, membershipId: null, ip };
    } else {
      const u = await withAuthDb((c) => one<{ ok: boolean }>(c, `select status = 'active' as ok from users where id = $1`, [claims.sub]));
      if (!u?.ok) throw new AppError(401, 'unauthorized');
      ctx = { userId: claims.sub, role: 'none', tenantId: null, membershipId: null, ip };
    }
    if (roles && !roles.includes(ctx.role)) {
      throw new AppError(ctx.role === 'none' ? 403 : 403, ctx.role === 'none' ? 'context_required' : 'forbidden');
    }
    req.ctx = ctx;
  };
}

export const STAFF: Role[] = ['tenant_admin', 'supervisor'];
