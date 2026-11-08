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
      app: new pg.Pool({ connectionString: c.DATABASE_APP_URL, max: 20, application_name: 'busna-api' }),
      auth: new pg.Pool({ connectionString: c.DATABASE_AUTH_URL, max: 5, application_name: 'busna-auth' }),
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
  role: 'platform_admin' | 'tenant_admin' | 'supervisor' | 'driver' | 'parent' | 'none';
  tenantId: string | null;
  membershipId: string | null;
  ip?: string;
}

async function inTx<T>(pool: pg.Pool, setup: ((c: Db) => Promise<void>) | null, fn: (c: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (setup) await setup(client);
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
  return inTx(
    getPools().app,
    async (c) => {
      await c.query(
        `select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.role', $3, true)`,
        [ctx.tenantId ?? '', ctx.userId, ctx.role],
      );
    },
    fn,
  );
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
  const r = await c.query(sql, params);
  return (r.rows[0] as T) ?? null;
}

export async function many<T = any>(c: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await c.query(sql, params);
  return r.rows as T[];
}
