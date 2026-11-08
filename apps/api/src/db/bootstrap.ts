/**
 * تهيئة قاعدة بيانات للتطوير/الاختبار فقط:
 * ينشئ الأدوار (owner/app/auth/worker) بكلمات المرور الموجودة في روابط الاتصال،
 * وينشئ قاعدة البيانات ثم يطبّق الترحيلات.
 * في الإنتاج: أنشئ الأدوار وقاعدة البيانات بإجراءات مزود قاعدة البيانات، ثم شغّل db:migrate فقط.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { migrate } from './migrate.js';

function parse(url: string) {
  const u = new URL(url);
  return { user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), db: u.pathname.slice(1) };
}

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`Unsafe identifier: ${s}`);
  return `"${s}"`;
};
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

export async function bootstrap(opts: {
  adminUrl: string; ownerUrl: string; appUrl: string; authUrl: string; workerUrl: string; reset?: boolean;
  log?: (s: string) => void;
}) {
  const log = opts.log ?? console.log;
  const owner = parse(opts.ownerUrl);
  const roles = [owner, parse(opts.appUrl), parse(opts.authUrl), parse(opts.workerUrl)];
  const admin = new pg.Client({ connectionString: opts.adminUrl });
  await admin.connect();
  try {
    for (const r of roles) {
      const exists = (await admin.query('select 1 from pg_roles where rolname = $1', [r.user])).rowCount;
      await admin.query(`${exists ? 'alter' : 'create'} role ${ident(r.user)} login password ${lit(r.password)}`);
    }
    if (opts.reset) {
      await admin.query(`drop database if exists ${ident(owner.db)} with (force)`);
    }
    const dbExists = (await admin.query('select 1 from pg_database where datname = $1', [owner.db])).rowCount;
    if (!dbExists) {
      await admin.query(`create database ${ident(owner.db)} owner ${ident(owner.user)} encoding 'UTF8'`);
      log(`created database ${owner.db}`);
    }
    for (const r of roles) await admin.query(`grant connect on database ${ident(owner.db)} to ${ident(r.user)}`);
  } finally {
    await admin.end();
  }
  // الامتدادات تتطلب صلاحيات أعلى أحيانًا
  const adminDbUrl = new URL(opts.adminUrl);
  adminDbUrl.pathname = `/${owner.db}`;
  const adminDb = new pg.Client({ connectionString: adminDbUrl.toString() });
  await adminDb.connect();
  try {
    await adminDb.query('create extension if not exists citext');
    await adminDb.query('create extension if not exists pgcrypto');
  } finally {
    await adminDb.end();
  }
  await migrate(opts.ownerUrl, log);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.env.NODE_ENV === 'production') {
    console.error('db:bootstrap is for development only');
    process.exit(1);
  }
  const need = ['DATABASE_ADMIN_URL', 'DATABASE_OWNER_URL', 'DATABASE_APP_URL', 'DATABASE_AUTH_URL', 'DATABASE_WORKER_URL'];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing env: ${missing.join(', ')}`);
    process.exit(1);
  }
  bootstrap({
    adminUrl: process.env.DATABASE_ADMIN_URL!, ownerUrl: process.env.DATABASE_OWNER_URL!,
    appUrl: process.env.DATABASE_APP_URL!, authUrl: process.env.DATABASE_AUTH_URL!,
    workerUrl: process.env.DATABASE_WORKER_URL!, reset: process.argv.includes('--reset'),
  }).then(() => console.log('bootstrap complete'), (e) => {
    console.error(e);
    process.exit(1);
  });
}
