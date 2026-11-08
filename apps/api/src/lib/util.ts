import { z } from 'zod';
import { badRequest } from './errors.js';
import type { Db, RequestContext } from '../db/pool.js';

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest(
      'validation_failed',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

export const uuid = z.string().uuid();
export const idParam = z.object({ id: z.string().uuid() });
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
export const phone = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^\+?\d{8,15}$/, 'invalid phone'));
export const email = z.string().trim().toLowerCase().email().max(200);
export const name = z.string().trim().min(2).max(120);

/** تاريخ اليوم في منطقة الجهة الزمنية بصيغة YYYY-MM-DD */
export function todayIn(timeZone: string, at = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

export function ageSeconds(ts: string | Date | null | undefined, now = Date.now()): number | null {
  if (!ts) return null;
  return Math.max(0, Math.round((now - new Date(ts).getTime()) / 1000));
}

/** تسجيل تدقيق — يُحفظ داخل نفس المعاملة */
export async function audit(
  c: Db,
  ctx: RequestContext,
  action: string,
  entity: string,
  entityId: string | null,
  details: Record<string, unknown> = {},
  tenantId: string | null = ctx.tenantId,
) {
  await c.query(
    `insert into audit_logs (tenant_id, actor_user_id, actor_role, action, entity, entity_id, details, ip)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tenantId, ctx.userId, ctx.role, action, entity, entityId, JSON.stringify(details), ctx.ip ?? null],
  );
}

export function firstName(fullName: string) {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}
