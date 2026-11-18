import { createHash } from 'node:crypto';
import pg from 'pg';
import { config } from '../config.js';

// تواريخ DATE تُعاد كنص YYYY-MM-DD بدل تحويلها لتوقيت محلي
pg.types.setTypeParser(1082, (v) => v);
// bigint count -> number
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = pg.PoolClient;

let pools: { app: pg.Pool; auth: pg.Pool; worker: pg.Pool } | null = null;

export function getPools() {
  if (!pools) {
    const c = config();
    pools = {
      app: new pg.Pool({ connectionString: c.DATABASE_APP_URL, max: c.DB_POOL_APP, application_name: 'busna-api' }),
      auth: new pg.Pool({ connectionString: c.DATABASE_AUTH_URL, max: c.DB_POOL_AUTH, application_name: 'busna-auth' }),
      worker: new pg.Pool({ connectionString: c.DATABASE_WORKER_URL, max: 3, application_name: 'busna-worker' }),
    };
  }
  return pools;
}

export async function closePools() {
  if (pools) {
    await Promise.all([pools.app.end(), pools.auth.end(), pools.worker.end()]);
    pools = null;
  }
}

/** سياق الطلب الموثّق — يُستخرج من الخادم فقط، لا من مدخلات المستخدم */
export interface RequestContext {
  userId: string;
  role: 'platform_admin' | 'platform_support' | 'platform_readonly' | 'tenant_admin' | 'supervisor' | 'driver' | 'attendant' | 'parent' | 'none';
  tenantId: string | null;
  membershipId: string | null;
  /** وصول دعم استثنائي (قراءة فقط) */
  grantId?: string | null;
  ip?: string;
  /** لقطة من بيانات الجهة قُرئت مع فحص العضوية في نفس الطلب */
  tenant?: { id: string; name: string; timezone: string; settings: unknown; contact_phone: string | null };
}

// أسماء ثابتة للاستعلامات المتكررة: قاعدة البيانات تحلّلها مرة لكل اتصال وتعيد استخدام الخطة
const stmtNames = new Map<string, string>();
function stmtName(sql: string) {
  let n = stmtNames.get(sql);
  if (!n) {
    n = 'b' + createHash('sha1').update(sql).digest('hex').slice(0, 20);
    stmtNames.set(sql, n);
  }
  return n;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function inTx<T>(pool: pg.Pool, setup: string | null, fn: (c: Db) => Promise<T>, readOnly = false, tenant?: RequestContext['tenant']): Promise<T> {
  const client = await pool.connect();
  try {
    // بدء المعاملة وضبط سياق الجلسة في ذهاب وعودة واحد
    await client.query(`${readOnly ? 'begin read only' : 'begin'};${setup ?? ''}`);
    (client as any).__tenant = tenant ?? null;
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * يشغّل الدالة داخل معاملة باتصال busna_app بعد ضبط متغيرات الجلسة،
 * فتُطبّق سياسات RLS بحسب الجهة والمستخدم والدور.
 */
export function withCtx<T>(ctx: RequestContext, fn: (c: Db) => Promise<T>): Promise<T> {
  // القيم من الخادم فقط (معرّفات UUID ودور من قائمة ثابتة) — نتحقق من شكلها قبل وضعها في نص الأمر
  if (!UUID.test(ctx.userId) || (ctx.tenantId && !UUID.test(ctx.tenantId)) || !/^[a-z_]+$/.test(ctx.role)) {
    throw new Error('invalid request context');
  }
  return inTx(
    getPools().app,
    `select set_config('app.tenant_id', '${ctx.tenantId ?? ''}', true), set_config('app.user_id', '${ctx.userId}', true), set_config('app.role', '${ctx.role}', true)`,
    fn,
    // وصول الدعم الاستثنائي: المعاملة نفسها للقراءة فقط — أي كتابة ترفضها قاعدة البيانات
    ctx.role === 'platform_readonly',
    ctx.tenant,
  );
}

/** استعلام قراءة واحد لوحدة المصادقة بدون معاملة (ذهاب وعودة واحد بدل ثلاثة) — يُستخدم في فحص كل طلب */
export async function authQueryOne<T = any>(sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await getPools().auth.query(sql, params);
  return (r.rows[0] as T) ?? null;
}

/** وحدة المصادقة فقط */
export function withAuthDb<T>(fn: (c: Db) => Promise<T>): Promise<T> {
  return inTx(getPools().auth, null, fn);
}

/** المهام الخلفية فقط */
export function withWorkerDb<T>(fn: (c: Db) => Promise<T>): Promise<T> {
  return inTx(getPools().worker, null, fn);
}

export async function one<T = any>(c: Db, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await c.query({ name: stmtName(sql), text: sql, values: params });
  return (r.rows[0] as T) ?? null;
}

export async function many<T = any>(c: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await c.query({ name: stmtName(sql), text: sql, values: params });
  return r.rows as T[];
}
