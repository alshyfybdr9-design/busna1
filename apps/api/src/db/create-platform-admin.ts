/**
 * إنشاء حساب مدير منصة. كلمة المرور تُولّد عشوائيًا وتُطبع مرة واحدة.
 * الاستخدام: npm run admin:create -- --email admin@example.com --name "اسم المدير"
 */
import pg from 'pg';
import { hashPassword, randomToken } from '../lib/crypto.js';

const args = process.argv.slice(2);
const get = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const email = get('email');
const fullName = get('name') ?? 'مدير المنصة';
if (!email || !process.env.DATABASE_AUTH_URL) {
  console.error('Usage: npm run admin:create -- --email <email> [--name <name>]  (requires DATABASE_AUTH_URL)');
  process.exit(1);
}
const password = `${randomToken(12)}9a`;
const client = new pg.Client({ connectionString: process.env.DATABASE_AUTH_URL });
await client.connect();
const r = await client.query(
  `insert into users (email, password_hash, full_name, is_platform_admin) values ($1, $2, $3, true)
   on conflict (email) do update set is_platform_admin = true, password_hash = excluded.password_hash returning id`,
  [email.toLowerCase(), await hashPassword(password), fullName],
);
await client.query(`insert into audit_logs (actor_user_id, action, entity, entity_id) values ($1::uuid, 'platform.admin_created', 'user', $1::text)`, [r.rows[0].id]);
await client.end();
console.log(`Platform admin ready: ${email}`);
console.log(`Temporary password (shown once): ${password}`);
