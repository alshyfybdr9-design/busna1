/**
 * محاكاة ذروة الصباح على قاعدة busna_load:
 *  - السائقون: نقطة موقع كل 10 ثوانٍ (0.1 طلب/ث لكل سائق) + تسجيل صعود أحيانًا.
 *  - أولياء الأمور النشطون: قائمة الأبناء كل 20 ث، حالة الطفل كل 30 ث في المتوسط
 *    (نصفهم على شاشة التتبع كل 15 ث)، و/me كل 60 ث ≈ 0.1 طلب/ث لكل ولي أمر.
 *
 * كل خطوة = نسبة من ذروة كاملة (LT_PEAK_DRIVERS سائق + LT_PEAK_PARENTS ولي أمر نشط في نفس اللحظة).
 * المعدل مفتوح (open-loop): الطلبات تُرسل بالمعدل المطلوب بغض النظر عن بطء الردود، كما يحدث فعليًا.
 *
 *   LT_API=http://127.0.0.1:4000  LT_STEPS=0.05,0.1,0.2  LT_STEP_SEC=30  npx tsx loadtest/run.ts
 */
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SignJWT } from 'jose';
import { loadUrl } from './seed-scale-url.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
if (existsSync(path.join(root, '.env')) && !process.env.DATABASE_APP_URL) process.loadEnvFile(path.join(root, '.env'));

const API = new URL(process.env.LT_API ?? 'http://127.0.0.1:4000');
const PEAK_DRIVERS = Number(process.env.LT_PEAK_DRIVERS ?? 6000);
const PEAK_PARENTS = Number(process.env.LT_PEAK_PARENTS ?? 50000);
const STEPS = (process.env.LT_STEPS ?? '0.05,0.1,0.2,0.35,0.5,0.75,1').split(',').map(Number);
const STEP_SEC = Number(process.env.LT_STEP_SEC ?? 30);
const MAX_INFLIGHT = Number(process.env.LT_MAX_INFLIGHT ?? 3000);
const STOP_P95_MS = Number(process.env.LT_STOP_P95_MS ?? 3000);
const OUT = process.env.LT_OUT;

// ---------------- العينات والرموز ----------------
const db = new pg.Client({ connectionString: loadUrl(process.env.DATABASE_OWNER_URL) });
await db.connect();
const parentRows = (await db.query(
  `select m.user_id, m.id as mid, (select gs.student_id from guardian_students gs where gs.guardian_user_id = m.user_id limit 1) as student_id
   from memberships m where m.role = 'parent' order by random() limit $1`, [PEAK_PARENTS],
)).rows;
const driverRows = (await db.query(
  `select t.id as trip_id, t.driver_user_id as user_id, m.id as mid,
          (select lat from bus_locations l where l.trip_id = t.id order by recorded_at desc limit 1) as lat,
          (select lng from bus_locations l where l.trip_id = t.id order by recorded_at desc limit 1) as lng,
          array(select tr.student_id from trip_riders tr where tr.trip_id = t.id and tr.status = 'expected') as expected
   from trips t join memberships m on m.user_id = t.driver_user_id and m.tenant_id = t.tenant_id and m.role = 'driver'
   where t.status = 'in_progress' order by random() limit $1`, [PEAK_DRIVERS],
)).rows;
await db.end();
console.log(`sample: ${parentRows.length.toLocaleString('en')} parents, ${driverRows.length.toLocaleString('en')} drivers with live trips`);

const key = new TextEncoder().encode(process.env.JWT_SECRET!);
const sign = (sub: string, mid: string) =>
  new SignJWT({ ctx: { kind: 'membership', mid } }).setProtectedHeader({ alg: 'HS256' }).setSubject(sub)
    .setIssuedAt().setIssuer('busna').setAudience('busna-api').setExpirationTime('3h').sign(key);
const parents = await Promise.all(parentRows.map(async (r, i) => ({ ...r, token: await sign(r.user_id, r.mid), ip: `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}` })));
const drivers = await Promise.all(driverRows.map(async (r, i) => ({ ...r, token: await sign(r.user_id, r.mid), ip: `11.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}` })));

// ---------------- إرسال الطلبات ----------------
const agent = new http.Agent({ keepAlive: true, maxSockets: 1024 });
type Kind = 'parent_children' | 'parent_status' | 'me' | 'driver_location' | 'driver_event';
interface Sample { kind: Kind; ms: number; status: number }
let samples: Sample[] = [];
let inflight = 0;
let dropped = 0;

function send(kind: Kind, method: string, p: string, token: string, ip: string, body?: unknown) {
  if (inflight >= MAX_INFLIGHT) { dropped++; return; }
  inflight++;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const start = performance.now();
  const req = http.request({
    agent, host: API.hostname, port: API.port, path: `/v1${p}`, method,
    headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': ip, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) },
  }, (res) => {
    res.resume();
    res.on('end', () => { inflight--; samples.push({ kind, ms: performance.now() - start, status: res.statusCode ?? 0 }); });
  });
  req.setTimeout(30_000, () => req.destroy(new Error('timeout')));
  req.on('error', () => { inflight--; samples.push({ kind, ms: performance.now() - start, status: 0 }); });
  if (payload) req.write(payload);
  req.end();
}

const pick = <T>(a: T[], n: number) => a[Math.floor(Math.random() * Math.min(n, a.length))];

function fire(kind: Kind, nParents: number, nDrivers: number) {
  if (kind.startsWith('driver')) {
    const d = pick(drivers, nDrivers);
    if (kind === 'driver_location') {
      d.lat += 0.00005; d.lng += 0.00003;
      send(kind, 'POST', `/driver/trips/${d.trip_id}/locations`, d.token, d.ip, {
        points: [{ recordedAt: new Date().toISOString(), lat: d.lat, lng: d.lng, accuracyM: 8, speedMps: 9, heading: 45 }],
      });
    } else {
      const sid = d.expected.length ? d.expected[Math.floor(Math.random() * d.expected.length)] : null;
      if (!sid) return;
      send(kind, 'POST', `/driver/trips/${d.trip_id}/events`, d.token, d.ip, {
        events: [{ clientEventId: randomUUID(), studentId: sid, type: 'boarded', recordedAt: new Date().toISOString(), source: 'manual' }],
      });
    }
    return;
  }
  const p = pick(parents, nParents);
  if (kind === 'parent_children') send(kind, 'GET', '/parent/children', p.token, p.ip);
  else if (kind === 'parent_status') send(kind, 'GET', `/parent/children/${p.student_id}/status`, p.token, p.ip);
  else send(kind, 'GET', '/me', p.token, p.ip);
}

const pct = (a: number[], p: number) => (a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : 0);
const results: any[] = [];

for (const f of STEPS) {
  const nD = Math.round(PEAK_DRIVERS * f);
  const nP = Math.round(PEAK_PARENTS * f);
  const rates: Record<Kind, number> = {
    driver_location: nD * 0.1,
    driver_event: nD * 0.004,
    parent_children: nP * 0.05,
    parent_status: nP * 0.0333,
    me: nP * 0.0167,
  };
  const target = Object.values(rates).reduce((a, b) => a + b, 0);
  samples = [];
  dropped = 0;
  const sent: Record<string, number> = {};
  const t0 = performance.now();
  await new Promise<void>((resolve) => {
    const h = setInterval(() => {
      const el = (performance.now() - t0) / 1000;
      if (el >= STEP_SEC) { clearInterval(h); resolve(); return; }
      for (const k of Object.keys(rates) as Kind[]) {
        const due = Math.floor(rates[k] * el) - (sent[k] ?? 0);
        for (let i = 0; i < due; i++) fire(k, nP, nD);
        sent[k] = (sent[k] ?? 0) + Math.max(0, due);
      }
    }, 10);
  });
  // انتظار الردود المعلقة (حتى 15 ث)
  const wait0 = performance.now();
  while (inflight > 0 && performance.now() - wait0 < 15_000) await new Promise((r) => setTimeout(r, 100));
  const done = samples;
  const ok = done.filter((s) => s.status >= 200 && s.status < 400);
  const lat = ok.map((s) => s.ms).sort((a, b) => a - b);
  const byKind: Record<string, any> = {};
  for (const k of Object.keys(rates)) {
    const ks = done.filter((s) => s.kind === k);
    const kl = ks.filter((s) => s.status >= 200 && s.status < 400).map((s) => s.ms).sort((a, b) => a - b);
    byKind[k] = { n: ks.length, p50: Math.round(pct(kl, 50)), p95: Math.round(pct(kl, 95)), p99: Math.round(pct(kl, 99)), errors: ks.length - kl.length };
  }
  const statuses: Record<string, number> = {};
  for (const s of done) if (s.status < 200 || s.status >= 400) statuses[s.status] = (statuses[s.status] ?? 0) + 1;
  const row = {
    step: f, drivers: nD, parents: nP, targetRps: Math.round(target), achievedRps: Math.round(ok.length / STEP_SEC),
    p50: Math.round(pct(lat, 50)), p95: Math.round(pct(lat, 95)), p99: Math.round(pct(lat, 99)),
    errors: done.length - ok.length, dropped, statuses, byKind,
  };
  results.push(row);
  console.log(`\n=== ${Math.round(f * 100)}% of peak: ${nD} drivers + ${nP} active parents → target ${row.targetRps} req/s ===`);
  console.log(`achieved ${row.achievedRps} req/s ok · p50 ${row.p50}ms · p95 ${row.p95}ms · p99 ${row.p99}ms · errors ${row.errors} ${JSON.stringify(statuses)} · not sent (overload) ${dropped}`);
  console.table(byKind);
  if (row.p95 > STOP_P95_MS || (row.errors + dropped) > done.length * 0.05) {
    console.log(`stopping: p95 above ${STOP_P95_MS}ms or >5% failed`);
    break;
  }
  await new Promise((r) => setTimeout(r, 5000));
}
if (OUT) writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), peakDrivers: PEAK_DRIVERS, peakParents: PEAK_PARENTS, stepSec: STEP_SEC, results }, null, 2));
agent.destroy();
