/**
 * يشغّل الخادم المبني (dist) على قاعدة busna_load لاختبار الضغط.
 * TRUST_PROXY=true لأن أداة المحاكاة ترسل عنوان IP مختلفًا لكل مستخدم (كما يحدث خلف موزّع الأحمال).
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadUrl } from './seed-scale-url.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
if (existsSync(path.join(root, '.env')) && !process.env.DATABASE_APP_URL) process.loadEnvFile(path.join(root, '.env'));
for (const k of ['DATABASE_OWNER_URL', 'DATABASE_APP_URL', 'DATABASE_AUTH_URL', 'DATABASE_WORKER_URL']) process.env[k] = loadUrl(process.env[k]);
process.env.TRUST_PROXY = 'true';
process.env.PORT = process.env.LT_PORT ?? '4100';
// مسار ديناميكي حتى لا يتطلب ملف تعريف أنواع للنسخة المبنية
const serverPath = '../dist/server.js';
await import(serverPath);
