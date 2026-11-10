/**
 * بيانات تجريبية مصطنعة — موسومة بوضوح [تجريبي] ومعلَّمة is_demo.
 * يرفض التشغيل في الإنتاج. كلمة مرور الحسابات من SEED_PASSWORD أو تُولّد وتُطبع.
 * الأسماء والمواقع وهمية (الإحداثيات نقاط عامة في الرياض لأغراض العرض فقط).
 */
import pg from 'pg';
import { hashPassword, randomToken } from '../lib/crypto.js';
import { todayIn } from '../lib/util.js';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data in production');
  process.exit(1);
}
const url = process.env.DATABASE_OWNER_URL;
if (!url) {
  console.error('DATABASE_OWNER_URL is required');
  process.exit(1);
}

const password = process.env.SEED_PASSWORD ?? `Demo${randomToken(6)}1`;
const c = new pg.Client({ connectionString: url });

/**
 * أمثلة تجريبية للميزات الأحدث (تُضاف مرة واحدة، حتى لقاعدة بيانات تجريبية موجودة مسبقًا):
 * تسليم آمن لطالبة صغيرة مع شخص مصرّح له، وطلب تغيير عنوان مؤقت بانتظار المراجعة.
 */
async function seedExtras(tenantId: string) {
  const id = async (sql: string, params: unknown[]) => (await c.query(sql, params)).rows[0]?.id as string | undefined;
  const leen = await id(`select id from students where tenant_id = $1 and full_name = 'لين (تجريبي)'`, [tenantId]);
  const reem = await id(`select id from students where tenant_id = $1 and full_name = 'ريم (تجريبي)'`, [tenantId]);
  const p1 = await id(`select id from users where email = 'parent1@demo.busna.local'`, []);
  const p2 = await id(`select id from users where email = 'parent2@demo.busna.local'`, []);
  if (leen && p2) {
    await c.query(`update students set requires_handover = true where id = $1`, [leen]);
    const has = await c.query(`select 1 from authorized_pickups where student_id = $1`, [leen]);
    if (!has.rowCount) {
      await c.query(
        `insert into authorized_pickups (tenant_id, student_id, full_name, relationship, phone, added_by)
         values ($1, $2, '[تجريبي] الجدة سارة', 'جدة', '+966500000099', $3)`,
        [tenantId, leen, p2],
      );
    }
  }
  if (reem && p1) {
    const has = await c.query(`select 1 from stop_change_requests where student_id = $1`, [reem]);
    if (!has.rowCount) {
      const today = todayIn('Asia/Riyadh');
      const plus = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
      await c.query(
        `insert into stop_change_requests (tenant_id, student_id, requested_by, kind, direction, start_date, end_date, address, lat, lng, note)
         values ($1, $2, $3, 'temporary', 'both', $4, $5, '[تجريبي] منزل الجد — حي الياسمين', 24.8226, 46.6402, 'سفر الوالدين (بيانات تجريبية)')`,
        [tenantId, reem, p1, plus(1), plus(5)],
      );
    }
  }
}

await c.connect();
await c.query('begin');
try {
  const existing = await c.query(`select id from tenants where code = 'DEMO01'`);
  if (existing.rowCount) {
    await seedExtras(existing.rows[0].id);
    await c.query('commit');
    console.log('Demo tenant DEMO01 already exists — added any missing demo examples only. (Use db:bootstrap -- --reset to start over)');
    await c.end();
    process.exit(0);
  }
  const hash = await hashPassword(password);
  const user = async (email: string, name: string, admin = false, phone: string | null = null) =>
    (await c.query(`insert into users (email, phone, password_hash, full_name, is_platform_admin) values ($1, $2, $3, $4, $5)
      on conflict (email) do update set password_hash = excluded.password_hash returning id`, [email, phone, hash, name, admin])).rows[0].id as string;

  await user('platform@demo.busna.local', '[تجريبي] مدير المنصة', true);
  const t = (await c.query(
    `insert into tenants (code, name, name_en, kind, contact_phone, contact_email, is_demo, settings)
     values ('DEMO01', '[تجريبي] مدرسة النور النموذجية', '[DEMO] Al-Noor Model School', 'school', '+966500000001', 'transport@demo.busna.local', true, $1)
     returning id`,
    [JSON.stringify({ supportHours: 'الأحد–الخميس 7:00–15:00 (بيانات تجريبية)' })],
  )).rows[0].id as string;

  const member = (uid: string, role: string) => c.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, $3)`, [t, uid, role]);
  const admin = await user('admin@demo.busna.local', '[تجريبي] مدير الجهة');
  await member(admin, 'tenant_admin');
  const sup = await user('supervisor@demo.busna.local', '[تجريبي] مشرف النقل');
  await member(sup, 'supervisor');
  const d1 = await user('driver1@demo.busna.local', '[تجريبي] السائق أحمد', false, '+966500000011');
  await member(d1, 'driver');
  const d2 = await user('driver2@demo.busna.local', '[تجريبي] السائق فهد', false, '+966500000012');
  await member(d2, 'driver');
  const p1 = await user('parent1@demo.busna.local', '[تجريبي] ولي الأمر محمد');
  await member(p1, 'parent');
  const p2 = await user('parent2@demo.busna.local', '[تجريبي] ولية الأمر نورة');
  await member(p2, 'parent');

  const students: string[] = [];
  for (const [name, grade] of [['ريم (تجريبي)', 'الثاني'], ['عمر (تجريبي)', 'الرابع'], ['لين (تجريبي)', 'الأول'], ['يوسف (تجريبي)', 'الخامس'], ['جود (تجريبي)', 'الثالث'], ['سلمان (تجريبي)', 'السادس']]) {
    students.push((await c.query(`insert into students (tenant_id, full_name, grade) values ($1, $2, $3) returning id`, [t, name, grade])).rows[0].id);
  }
  const link = (g: string, s: string) => c.query(`insert into guardian_students (tenant_id, guardian_user_id, student_id) values ($1, $2, $3)`, [t, g, s]);
  await link(p1, students[0]);
  await link(p1, students[1]);
  await link(p2, students[2]);

  const bus1 = (await c.query(`insert into buses (tenant_id, plate_number, label, capacity) values ($1, 'DEMO-101', 'باص 1', 30) returning id`, [t])).rows[0].id;
  const bus2 = (await c.query(`insert into buses (tenant_id, plate_number, label, capacity) values ($1, 'DEMO-102', 'باص 2', 24) returning id`, [t])).rows[0].id;

  async function route(name: string, direction: string, bus: string, driver: string, stops: Array<[string, number, number, string, string?]>, riders: Array<[number, number]>, dep: string) {
    const r = (await c.query(`insert into routes (tenant_id, name, direction, bus_id, driver_user_id) values ($1, $2, $3, $4, $5) returning id`, [t, name, direction, bus, driver])).rows[0].id;
    const stopIds: string[] = [];
    for (const [i, [sn, lat, lng, time, kind]] of stops.entries()) {
      stopIds.push((await c.query(`insert into route_stops (tenant_id, route_id, seq, name, kind, lat, lng, planned_time) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [t, r, i + 1, sn, kind ?? 'stop', lat, lng, time])).rows[0].id);
    }
    for (const [si, stopIdx] of riders) {
      await c.query(`insert into route_riders (tenant_id, route_id, student_id, stop_id) values ($1, $2, $3, $4)`, [t, r, students[si], stopIds[stopIdx]]);
    }
    const sched = (await c.query(`insert into schedules (tenant_id, route_id, days_of_week, departure_time) values ($1, $2, '{0,1,2,3,4}', $3) returning id`, [t, r, dep])).rows[0].id;
    return { r, sched };
  }
  const school: [string, number, number, string, string] = ['المدرسة (تجريبي)', 24.7743, 46.7386, '07:00', 'school'];
  const morning = await route('[تجريبي] مسار الصباح — شمال', 'to_school', bus1, d1, [
    ['نقطة الياسمين (تجريبي)', 24.8237, 46.6406, '06:20'],
    ['نقطة النرجس (تجريبي)', 24.8325, 46.6614, '06:30'],
    ['نقطة الملقا (تجريبي)', 24.8010, 46.6200, '06:40'],
    school,
  ], [[0, 0], [1, 1], [2, 1], [3, 2]], '06:15');
  await route('[تجريبي] مسار العودة — شمال', 'from_school', bus1, d1, [
    school,
    ['نقطة الياسمين (تجريبي)', 24.8237, 46.6406, '13:20'],
    ['نقطة النرجس (تجريبي)', 24.8325, 46.6614, '13:30'],
  ], [[0, 1], [1, 2], [2, 2]], '13:00');
  await route('[تجريبي] مسار الصباح — شرق', 'to_school', bus2, d2, [
    ['نقطة الروضة (تجريبي)', 24.7400, 46.7700, '06:35'],
    school,
  ], [[4, 0], [5, 0]], '06:30');

  // رحلة اليوم للمسار الأول (يمكن توليد البقية من لوحة الإدارة)
  const today = todayIn('Asia/Riyadh');
  const trip = (await c.query(
    `insert into trips (tenant_id, route_id, schedule_id, service_date, direction, bus_id, driver_user_id, planned_start)
     values ($1, $2, $3, $4, 'to_school', $5, $6, ($4::date + time '06:15') at time zone 'Asia/Riyadh') returning id`,
    [t, morning.r, morning.sched, today, bus1, d1],
  )).rows[0].id;
  await c.query(
    `insert into trip_riders (tenant_id, trip_id, student_id, stop_id) select $1, $2, student_id, stop_id from route_riders where route_id = $3`,
    [t, trip, morning.r],
  );
  await seedExtras(t);
  await c.query('commit');
  console.log('Seeded demo tenant DEMO01 ([تجريبي] مدرسة النور النموذجية).');
  console.log('Accounts (all share one password):');
  for (const e of ['platform@demo.busna.local (platform admin)', 'admin@demo.busna.local (tenant admin)', 'supervisor@demo.busna.local',
    'driver1@demo.busna.local', 'driver2@demo.busna.local', 'parent1@demo.busna.local (2 children)', 'parent2@demo.busna.local']) console.log(`  - ${e}`);
  console.log(`Password: ${password}`);
} catch (e) {
  await c.query('rollback');
  throw e;
} finally {
  await c.end();
}
