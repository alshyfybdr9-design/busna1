import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default('0.0.0.0'),
  // اتصالات قاعدة البيانات: كل دور باتصال مستقل وصلاحيات مختلفة
  DATABASE_OWNER_URL: z.string().optional(), // للترحيلات فقط
  DATABASE_APP_URL: z.string().min(1),
  DATABASE_AUTH_URL: z.string().min(1),
  DATABASE_WORKER_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(30),
  INVITE_TTL_DAYS: z.coerce.number().int().default(7),
  APP_PUBLIC_URL: z.string().url().default('http://localhost:5173'),
  APP_SCHEME: z.string().default('busna'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  PUSH_PROVIDER: z.enum(['none', 'expo']).default('none'),
  EXPO_ACCESS_TOKEN: z.string().optional(),
  ROUTING_PROVIDER: z.enum(['none']).default('none'),
  WORKER_ENABLED: bool.default(true),
  TRUST_PROXY: bool.default(false),
});

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;
export function config(): Config {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
      throw new Error(`Invalid environment configuration:\n${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** إعدادات الجهة الافتراضية — تُدمج مع tenants.settings */
export const tenantSettingsSchema = z.object({
  locationIntervalSec: z.number().int().min(3).max(120).default(10),
  locationRetentionDays: z.number().int().min(1).max(365).default(30),
  staleAfterSec: z.number().int().min(15).max(900).default(60),
  parentTrackingEnabled: z.boolean().default(true),
  absenceAutoApprove: z.boolean().default(true),
  inspectionDeadlineMin: z.number().int().min(1).max(120).default(10),
  delayThresholdMin: z.number().int().min(1).max(120).default(10),
  locationLostAfterMin: z.number().int().min(1).max(60).default(5),
  requireRearQrScan: z.boolean().default(false),
  emergencyNumber: z.string().max(20).default('911'),
  supportHours: z.string().max(200).nullable().default(null),
});
export type TenantSettings = z.infer<typeof tenantSettingsSchema>;

export function tenantSettings(raw: unknown): TenantSettings {
  const r = tenantSettingsSchema.safeParse(raw ?? {});
  return r.success ? r.data : tenantSettingsSchema.parse({});
}
