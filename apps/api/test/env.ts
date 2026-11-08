/**
 * بيئة الاختبار: قاعدة بيانات منفصلة busna_test (لا تلمس بيانات التطوير أو الإنتاج).
 * تُشتق الروابط من .env باستبدال اسم قاعدة البيانات.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const envFile = path.join(root, '.env');
if (existsSync(envFile) && !process.env.DATABASE_APP_URL) process.loadEnvFile(envFile);

const toTest = (u?: string) => {
  if (!u) throw new Error('DATABASE_* URLs are required (copy .env.example to .env)');
  const url = new URL(u);
  url.pathname = '/busna_test';
  return url.toString();
};

process.env.NODE_ENV = 'test';
process.env.DATABASE_OWNER_URL = toTest(process.env.TEST_DATABASE_OWNER_URL ?? process.env.DATABASE_OWNER_URL);
process.env.DATABASE_APP_URL = toTest(process.env.TEST_DATABASE_APP_URL ?? process.env.DATABASE_APP_URL);
process.env.DATABASE_AUTH_URL = toTest(process.env.TEST_DATABASE_AUTH_URL ?? process.env.DATABASE_AUTH_URL);
process.env.DATABASE_WORKER_URL = toTest(process.env.TEST_DATABASE_WORKER_URL ?? process.env.DATABASE_WORKER_URL);
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
process.env.PUSH_PROVIDER = 'none';
process.env.WORKER_ENABLED = 'false';
process.env.APP_PUBLIC_URL = 'https://app.busna.test';
