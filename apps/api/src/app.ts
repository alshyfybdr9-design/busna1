import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { config } from './config.js';
import { AppError, messageFor } from './lib/errors.js';
import { authRoutes } from './routes/auth.js';
import { meRoutes } from './routes/me.js';
import { driverRoutes } from './routes/driver.js';
import { parentRoutes } from './routes/parent.js';
import { tenantAdminRoutes } from './routes/tenant-admin.js';
import { tenantOpsRoutes } from './routes/tenant-ops.js';
import { platformRoutes } from './routes/platform.js';
import { supportRoutes } from './routes/support.js';
import { assistantRoutes } from './routes/assistant.js';
import { getPools } from './db/pool.js';

/** تحويل أخطاء قاعدة البيانات إلى رموز آمنة للعرض (بدون تفاصيل تقنية للمستخدم) */
function mapDbError(e: any): AppError | null {
  if (!e || typeof e.code !== 'string') return null;
  switch (e.code) {
    case '42501': // insufficient_privilege / RLS
      return new AppError(403, 'forbidden');
    case 'P0001': // raise exception من المحفزات
      return new AppError(409, e.message && /^[a-z_]+$/.test(e.message) ? e.message : 'conflict');
    case 'P0002':
      return new AppError(404, 'not_found');
    case '23505':
      return new AppError(409, 'conflict');
    case '23503':
    case '23514':
    case '22P02':
      return new AppError(400, 'validation_failed');
    default:
      return null;
  }
}

export async function buildApp(opts: { logger?: boolean } = {}) {
  const cfg = config();
  const app = Fastify({
    logger: opts.logger ?? cfg.NODE_ENV !== 'test'
      ? { level: 'info', redact: ['req.headers.authorization', 'req.body.password', 'req.body.refreshToken'] }
      : false,
    trustProxy: cfg.TRUST_PROXY,
    bodyLimit: 512 * 1024,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: cfg.CORS_ORIGINS.split(',').map((s) => s.trim()), credentials: false });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    allowList: cfg.NODE_ENV === 'test' ? () => true : undefined,
    errorResponseBuilder: () => new AppError(429, 'rate_limited'),
  });

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    const lang = String(req.headers['accept-language'] ?? '').startsWith('en') ? 'en' : 'ar';
    let e: AppError | null = err instanceof AppError ? err : mapDbError(err);
    if (!e && (err as FastifyError).statusCode === 429) e = new AppError(429, 'rate_limited');
    if (!e && (err as FastifyError).validation) e = new AppError(400, 'validation_failed');
    if (!e && (err as FastifyError).statusCode && (err as FastifyError).statusCode! < 500) e = new AppError((err as FastifyError).statusCode!, 'validation_failed');
    if (!e) {
      req.log.error(err);
      e = new AppError(500, 'internal_error');
    } else if (e.status >= 500 || (err as any).code) {
      req.log.warn({ err }, 'request failed');
    }
    reply.status(e.status).send({ error: { code: e.code, message: messageFor(e.code, lang), details: e.details } });
  });

  app.get('/health', async () => {
    await getPools().app.query('select 1');
    return { ok: true };
  });

  await app.register(async (api) => {
    await api.register(authRoutes);
    await api.register(meRoutes);
    await api.register(driverRoutes);
    await api.register(parentRoutes);
    await api.register(tenantAdminRoutes);
    await api.register(tenantOpsRoutes);
    await api.register(platformRoutes);
    await api.register(supportRoutes);
    await api.register(assistantRoutes);
  }, { prefix: '/v1' });

  return app;
}
