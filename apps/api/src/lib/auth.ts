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

// تسجيل كل صفحة يطّلع عليها فريق المنصة أثناء الوصول الاستثنائي (مع تقليل التكرار للتحديث الدوري)
const lastLogged = new Map<string, number>();
function shouldLog(key: string) {
  const now = Date.now();
  const prev = lastLogged.get(key) ?? 0;
  if (now - prev < 60_000) return false;
  lastLogged.set(key, now);
  if (lastLogged.size > 5000) lastLogged.clear();
  return true;
}

/**
 * يتحقق من رمز الوصول ثم يعيد التحقق من العضوية/الدور في الخادم في كل طلب
 * (حتى يسري إيقاف العضوية أو الجهة أو انتهاء الوصول الاستثنائي فورًا). الدور والجهة من قاعدة البيانات، لا من العميل.
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
        one<{ platform_role: string | null; ok: boolean }>(c, `select platform_role, status = 'active' as ok from users where id = $1`, [claims.sub]),
      );
      if (!u?.ok || !u.platform_role) throw new AppError(401, 'unauthorized');
      ctx = { userId: claims.sub, role: u.platform_role === 'admin' ? 'platform_admin' : 'platform_support', tenantId: null, membershipId: null, ip };
    } else if (claims.ctx.kind === 'grant') {
      const gid = claims.ctx.gid;
      const g = await withAuthDb((c) =>
        one<{ id: string; tenant_id: string; ok: boolean }>(
          c,
          `select g.id, g.tenant_id,
                  (g.revoked_at is null and g.expires_at > now() and t.status = 'active' and u.status = 'active' and u.platform_role is not null) as ok
           from platform_access_grants g join tenants t on t.id = g.tenant_id join users u on u.id = g.user_id
           where g.id = $1 and g.user_id = $2`,
          [gid, claims.sub],
        ),
      );
      if (!g || !g.ok) throw new AppError(401, 'unauthorized');
      ctx = { userId: claims.sub, role: 'platform_readonly', tenantId: g.tenant_id, membershipId: null, grantId: g.id, ip };
      const path = req.routeOptions?.url ?? req.url.split('?')[0];
      if (shouldLog(`${g.id}:${req.method}:${path}`)) {
        await withAuthDb((c) =>
          c.query(
            `insert into audit_logs (tenant_id, actor_user_id, actor_role, action, entity, entity_id, details, ip)
             values ($1, $2, 'platform_readonly', 'platform_access.view', 'route', $3, $4, $5)`,
            [g.tenant_id, claims.sub, `${req.method} ${path}`.slice(0, 200), JSON.stringify({ grantId: g.id }), ip],
          ),
        );
      }
    } else {
      const u = await withAuthDb((c) => one<{ ok: boolean }>(c, `select status = 'active' as ok from users where id = $1`, [claims.sub]));
      if (!u?.ok) throw new AppError(401, 'unauthorized');
      ctx = { userId: claims.sub, role: 'none', tenantId: null, membershipId: null, ip };
    }
    if (roles && !roles.includes(ctx.role)) {
      // الوصول الاستثنائي: قراءة صفحات الإدارة فقط (والمعاملة نفسها read-only في قاعدة البيانات)
      const readonlyOk = ctx.role === 'platform_readonly' && req.method === 'GET' && roles.some((r) => r === 'tenant_admin' || r === 'supervisor');
      if (!readonlyOk) throw new AppError(403, ctx.role === 'none' ? 'context_required' : ctx.role === 'platform_readonly' ? 'read_only_access' : 'forbidden');
    }
    req.ctx = ctx;
  };
}

export const STAFF: Role[] = ['tenant_admin', 'supervisor'];
export const PLATFORM: Role[] = ['platform_admin', 'platform_support'];
