/**
 * بيانات اختبار الضغط — قاعدة منفصلة تمامًا (busna_load) لا تمس بيانات التطوير.
 *
 * الحجم الافتراضي (قابل للتغيير بالمتغيرات):
 *   LT_STUDENTS=300000     إجمالي الطلاب
 *   LT_BIG_TENANT=30000    طلاب أكبر جهة (شركة نقل) — لاختبار جهة كبيرة واحدة
 *   LT_PER_TENANT=900      طلاب كل مدرسة من البقية
 *   LT_HISTORY_DAYS=3      أيام سابقة من الرحلات ونقاط الموقع
 *
 * يُبنى بالكامل بأوامر SQL مجمّعة (generate_series) باتصال المشرف مع تعطيل المحفزات أثناء التعبئة فقط
 * — البيانات متسقة بالبناء، ولا يُستخدم هذا الأسلوب خارج اختبار الضغط.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import pg from 'pg';
import { bootstrap } from '../src/db/bootstrap.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
if (existsSync(path.join(root, '.env')) && !process.env.DATABASE_APP_URL) process.loadEnvFile(path.join(root, '.env'));

import { loadUrl } from './seed-scale-url.js';

const S = Number(process.env.LT_STUDENTS ?? 300_000);
const BIG = Number(process.env.LT_BIG_TENANT ?? 30_000);
const PER = Number(process.env.LT_PER_TENANT ?? 900);
const DAYS = Number(process.env.LT_HISTORY_DAYS ?? 3);
const SMALL = Math.max(0, Math.round((S - BIG) / PER));

const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

await bootstrap({
  adminUrl: process.env.DATABASE_ADMIN_URL!,
  ownerUrl: loadUrl(process.env.DATABASE_OWNER_URL),
  appUrl: loadUrl(process.env.DATABASE_APP_URL),
  authUrl: loadUrl(process.env.DATABASE_AUTH_URL),
  workerUrl: loadUrl(process.env.DATABASE_WORKER_URL),
  reset: true,
  log,
});

const c = new pg.Client({ connectionString: loadUrl(process.env.DATABASE_ADMIN_URL) });
await c.connect();
const q = async (label: string, sql: string, params: unknown[] = []) => {
  const r = await c.query(sql, params);
  log(`${label}${r.rowCount != null ? `: ${r.rowCount.toLocaleString('en')}` : ''}`);
};

await c.query(`set session_replication_role = replica`); // تعطيل المحفزات وفحوص المفاتيح أثناء التعبئة فقط
await c.query(`set work_mem = '256MB'`);
await c.query(`set maintenance_work_mem = '1GB'`);

log(`generating: ${S.toLocaleString('en')} students = 1 × ${BIG} + ${SMALL} × ${PER}, history ${DAYS} days`);

// ---------------- الجهات ----------------
await c.query(`create temp table t_ten as
  select i as ti, gen_random_uuid() as id, case when i = 1 then $1::int else $2::int end as n
  from generate_series(1, $3::int + 1) i`, [BIG, PER, SMALL]);
await c.query(`create temp table t_ten2 as select ti, id, n, (sum(n) over (order by ti) - n)::int as off from t_ten`);
await q('tenants', `insert into tenants (id, code, name, kind, is_demo)
  select id, 'LT' || lpad(ti::text, 5, '0'), '[اختبار ضغط] جهة ' || ti, case when ti = 1 then 'transport_company' else 'school' end, true from t_ten2`);
await q('subscriptions', `insert into tenant_subscriptions (tenant_id, plan_id, status)
  select id, (select id from platform_plans where code = 'custom'), 'active' from t_ten2`);

// ---------------- الطلاب ----------------
await c.query(`create temp table t_st as
  select g, t.id as tenant_id, t.ti, (g - t.off - 1) as k, gen_random_uuid() as id
  from t_ten2 t, generate_series(t.off + 1, t.off + t.n) g`);
await q('students', `insert into students (id, tenant_id, full_name, grade)
  select id, tenant_id, 'طالب اختبار ' || g, 'الصف ' || (1 + k % 6) from t_st`);

// ---------------- الباصات والسائقون والمسارات ----------------
await c.query(`create temp table t_bus as
  select t.id as tenant_id, t.ti, b as bi, gen_random_uuid() as id, gen_random_uuid() as driver_id, gen_random_uuid() as driver_mid,
         gen_random_uuid() as r_to, gen_random_uuid() as r_from,
         24.55 + (t.ti % 40) * 0.01 as lat0, 46.55 + (b % 60) * 0.004 as lng0
  from t_ten2 t, generate_series(0, ceil(t.n / 50.0)::int - 1) b`);
await q('buses', `insert into buses (id, tenant_id, plate_number, label, capacity)
  select id, tenant_id, 'LT-' || ti || '-' || bi, 'باص ' || (bi + 1), 60 from t_bus`);
await q('drivers', `insert into users (id, email, password_hash, full_name)
  select driver_id, 'driver-' || ti || '-' || bi || '@load.busna.test', 'x', 'سائق اختبار ' || ti || '-' || bi from t_bus`);
await q('driver memberships', `insert into memberships (id, tenant_id, user_id, role) select driver_mid, tenant_id, driver_id, 'driver' from t_bus`);
await q('routes', `insert into routes (id, tenant_id, name, direction, bus_id, driver_user_id)
  select r_to, tenant_id, 'ذهاب ' || (bi + 1), 'to_school', id, driver_id from t_bus
  union all select r_from, tenant_id, 'عودة ' || (bi + 1), 'from_school', id, driver_id from t_bus`);

// 5 نقاط + المدرسة لكل مسار
await c.query(`create temp table t_stop as
  select gen_random_uuid() as id, b.tenant_id, b.ti, b.bi, r.route_id, r.dir, j,
         case when r.dir = 'to_school' then j + 1 else j + 2 end as seq,
         b.lat0 + j * 0.004 as lat, b.lng0 + j * 0.002 as lng
  from t_bus b
  cross join lateral (values (b.r_to, 'to_school'), (b.r_from, 'from_school')) r(route_id, dir)
  cross join generate_series(0, 4) j`);
await q('stops', `insert into route_stops (id, tenant_id, route_id, seq, name, kind, lat, lng)
  select id, tenant_id, route_id, seq, 'نقطة ' || (j + 1), 'stop', lat, lng from t_stop
  union all
  select gen_random_uuid(), b.tenant_id, r.route_id, case when r.dir = 'to_school' then 6 else 1 end, 'المدرسة', 'school', b.lat0 + 0.03, b.lng0 + 0.015
  from t_bus b cross join lateral (values (b.r_to, 'to_school'), (b.r_from, 'from_school')) r(route_id, dir)`);
await c.query(`create index on t_stop (ti, bi, dir, j)`);

// كل طالب: الباص = k/50 ، النقطة = (k%50)/10
await c.query(`create temp table t_rr as
  select s.id as student_id, s.tenant_id, s.ti, s.k, st.route_id, st.id as stop_id, st.dir, st.j
  from t_st s join t_stop st on st.ti = s.ti and st.bi = s.k / 50 and st.j = (s.k % 50) / 10`);
await q('route riders', `insert into route_riders (tenant_id, route_id, student_id, stop_id) select tenant_id, route_id, student_id, stop_id from t_rr`);
await q('schedules', `insert into schedules (tenant_id, route_id, days_of_week, departure_time)
  select tenant_id, r_to, '{0,1,2,3,4}'::smallint[], '06:15'::time from t_bus union all select tenant_id, r_from, '{0,1,2,3,4}'::smallint[], '13:00'::time from t_bus`);

// ---------------- أولياء الأمور: كل 5 طلاب ← 4 أولياء (أخوان يشتركان في ولي أمر) ----------------
await c.query(`create temp table t_gs as
  select s.id as student_id, s.tenant_id, s.ti, (s.k / 5) * 4 + greatest(0, s.k % 5 - 1) as pk from t_st s`);
await c.query(`create temp table t_par as select distinct on (ti, pk) ti, pk, tenant_id, gen_random_uuid() as id, gen_random_uuid() as mid from t_gs order by ti, pk`);
await q('parents', `insert into users (id, email, password_hash, full_name)
  select id, 'parent-' || ti || '-' || pk || '@load.busna.test', 'x', 'ولي أمر اختبار ' || ti || '-' || pk from t_par`);
await q('parent memberships', `insert into memberships (id, tenant_id, user_id, role) select mid, tenant_id, id, 'parent' from t_par`);
await q('guardian links', `insert into guardian_students (tenant_id, guardian_user_id, student_id)
  select g.tenant_id, p.id, g.student_id from t_gs g join t_par p on p.ti = g.ti and p.pk = g.pk`);

// ---------------- الرحلات: أيام سابقة مكتملة + اليوم (الذهاب جارية، العودة مجدولة) ----------------
await c.query(`create temp table t_trip as
  select gen_random_uuid() as id, b.tenant_id, b.ti, b.bi, r.route_id, r.dir, d,
         ((now() at time zone 'Asia/Riyadh')::date - d) as service_date, b.id as bus_id, b.driver_id, b.lat0, b.lng0
  from t_bus b
  cross join lateral (values (b.r_to, 'to_school'), (b.r_from, 'from_school')) r(route_id, dir)
  cross join generate_series(0, $1::int) d`, [DAYS]);
await q('trips', `insert into trips (id, tenant_id, route_id, service_date, direction, bus_id, driver_user_id, status, planned_start, started_at, ended_at, inspection_status, last_location_at)
  select id, tenant_id, route_id, service_date, dir, bus_id, driver_id,
         case when d > 0 then 'completed' when dir = 'to_school' then 'in_progress' else 'scheduled' end,
         now() - make_interval(days => d, mins => 20),
         case when d > 0 or dir = 'to_school' then now() - make_interval(days => d, mins => 20) end,
         case when d > 0 then now() - make_interval(days => d) + interval '40 minutes' end,
         case when d > 0 then 'completed' else 'not_required' end,
         case when d > 0 then now() - make_interval(days => d) + interval '40 minutes' when dir = 'to_school' then now() end
  from t_trip`);
await q('trip riders', `insert into trip_riders (tenant_id, trip_id, student_id, stop_id, status, boarded_at, alighted_at)
  select t.tenant_id, t.id, rr.student_id, rr.stop_id,
         case when t.d > 0 then 'alighted' when t.dir = 'to_school' and rr.j < 2 then 'boarded' else 'expected' end,
         case when t.d > 0 or (t.dir = 'to_school' and rr.j < 2) then now() - make_interval(days => t.d, mins => 10) end,
         case when t.d > 0 then now() - make_interval(days => t.d) + interval '35 minutes' end
  from t_trip t join t_rr rr on rr.route_id = t.route_id`);

// نقاط الموقع: ساعة لكل رحلة سابقة (كل 10 ثوانٍ) و20 دقيقة لرحلات الذهاب الجارية اليوم
await q('bus locations (history + live)', `insert into bus_locations (tenant_id, trip_id, recorded_at, lat, lng, accuracy_m, speed_mps, heading)
  select t.tenant_id, t.id,
         case when t.d > 0 then now() - make_interval(days => t.d) + make_interval(secs => i * 10)
              else now() - interval '20 minutes' + make_interval(secs => i * 10) end,
         t.lat0 + (i::float8 / 360) * 0.03, t.lng0 + (i::float8 / 360) * 0.015, 8, 9, 45
  from t_trip t
  cross join lateral generate_series(0, case when t.d > 0 then 359 when t.dir = 'to_school' then 119 else -1 end) i`);

// إشعارات سابقة: اثنان لكل ولي أمر في كل يوم سابق
await q('notifications', `insert into notifications (tenant_id, user_id, kind, title, body, push_title, push_body, dedupe_key, created_at, read_at)
  select p.tenant_id, p.id, 'rider_boarded', 'تحديث الرحلة', 'صعد إلى الباص.', 'باصنا', 'يوجد تحديث جديد.',
         'lt:' || p.id || ':' || d || ':' || n, now() - make_interval(days => d), now() - make_interval(days => d)
  from t_par p cross join generate_series(1, $1::int) d cross join generate_series(1, 2) n`, [DAYS]);

await c.query(`set session_replication_role = origin`);
await q('analyze', 'analyze');

const counts: Record<string, string> = {};
for (const t of ['students', 'users', 'buses', 'routes', 'trips', 'trip_riders', 'bus_locations', 'guardian_students', 'notifications']) {
  counts[t] = Number((await c.query(`select count(*) as n from ${t}`)).rows[0].n).toLocaleString('en');
}
console.table(counts);
const db = await c.query(`select pg_size_pretty(pg_database_size('busna_load')) as size`);
log(`done — database size ${db.rows[0].size}`);
await c.end();
