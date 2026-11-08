import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/lib/crypto.js';
import { todayIn } from '../src/lib/util.js';

let app: FastifyInstance | null = null;
export async function getApp() {
  if (!app) app = await buildApp({ logger: !!process.env.TEST_LOG });
  return app;
}

export interface Res<T = any> {
  status: number;
  body: T;
}

export async function api<T = any>(method: string, url: string, token?: string | null, body?: unknown): Promise<Res<T>> {
  const a = await getApp();
  const r = await a.inject({
    method: method as any,
    url: `/v1${url}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: body as any,
  });
  return { status: r.statusCode, body: r.json() as T };
}

export async function ownerQuery(sql: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}

const uniq = () => randomUUID().slice(0, 8);
export const PASSWORD = 'Passw0rd-test';

export async function platformAdminToken() {
  const email = `platform-${uniq()}@busna.test`;
  await ownerQuery(`insert into users (email, password_hash, full_name, is_platform_admin) values ($1, $2, 'مدير منصة تجريبي', true)`, [
    email, await hashPassword(PASSWORD),
  ]);
  const r = await api('POST', '/auth/login', null, { identifier: email, password: PASSWORD });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return r.body.accessToken as string;
}

export function tokenFromUrl(url: string) {
  return url.split('/invite/')[1];
}

export async function acceptInvite(inviteUrl: string, fullName: string, email: string) {
  const r = await api('POST', `/auth/invites/${tokenFromUrl(inviteUrl)}/accept`, null, { mode: 'register', fullName, email, password: PASSWORD });
  if (r.status !== 200) throw new Error(`accept failed: ${JSON.stringify(r.body)}`);
  return r.body as { accessToken: string; user: { id: string }; context: { mid: string } };
}

export async function invite(adminToken: string, role: string, fullName: string, studentIds: string[] = []) {
  const email = `${role}-${uniq()}@busna.test`;
  const r = await api('POST', '/tenant/invites', adminToken, { role, fullName, email, studentIds });
  if (r.status !== 200) throw new Error(`invite failed: ${JSON.stringify(r.body)}`);
  const accepted = await acceptInvite(r.body.invite.inviteUrl, fullName, email);
  return { token: accepted.accessToken, userId: accepted.user.id, email };
}

/** يبني جهة كاملة: مدير، سائقان، وليّا أمر، طالبان، باص، مسار بنقاط، ورحلة اليوم */
export async function buildTenantWorld(platformToken: string, label: string) {
  const code = `T${uniq()}`.toUpperCase().slice(0, 10);
  const t = await api('POST', '/platform/tenants', platformToken, {
    code, name: `[تجريبي] مدرسة ${label}`, kind: 'school', isDemo: true, contactPhone: '+966500000000',
    admin: { fullName: `مدير ${label}`, email: `admin-${uniq()}@busna.test` },
  });
  if (t.status !== 200) throw new Error(JSON.stringify(t.body));
  const adminEmail = (await ownerQuery(`select email from invites where id = $1`, [t.body.adminInvite.id]))[0].email;
  const admin = await acceptInvite(t.body.adminInvite.inviteUrl, `مدير ${label}`, adminEmail);
  const adminToken = admin.accessToken;

  const s1 = await api('POST', '/tenant/students', adminToken, { fullName: `سارة ${label}`, grade: 'الثالث' });
  const s2 = await api('POST', '/tenant/students', adminToken, { fullName: `خالد ${label}`, grade: 'الرابع' });
  const student1 = s1.body.student.id as string;
  const student2 = s2.body.student.id as string;

  const driver = await invite(adminToken, 'driver', `سائق ${label}`);
  const driver2 = await invite(adminToken, 'driver', `سائق احتياط ${label}`);
  const parent1 = await invite(adminToken, 'parent', `ولي أمر سارة ${label}`, [student1]);
  const parent2 = await invite(adminToken, 'parent', `ولي أمر خالد ${label}`, [student2]);

  const bus = await api('POST', '/tenant/buses', adminToken, { plateNumber: `ABC-${uniq().slice(0, 4)}`, label: `باص ${label}`, capacity: 30 });
  const route = await api('POST', '/tenant/routes', adminToken, {
    name: `مسار الصباح ${label}`, direction: 'to_school', busId: bus.body.bus.id, driverUserId: driver.userId,
  });
  const routeId = route.body.route.id as string;
  const stops = await api('PUT', `/tenant/routes/${routeId}/stops`, adminToken, {
    stops: [
      { name: 'نقطة 1', lat: 24.7136, lng: 46.6753, plannedTime: '06:30' },
      { name: 'نقطة 2', lat: 24.72, lng: 46.68, plannedTime: '06:40' },
      { name: 'المدرسة', kind: 'school', lat: 24.73, lng: 46.69, plannedTime: '07:00' },
    ],
  });
  const [stopA, stopB] = stops.body.stops;
  await api('PUT', `/tenant/routes/${routeId}/riders/${student1}`, adminToken, { stopId: stopA.id });
  await api('PUT', `/tenant/routes/${routeId}/riders/${student2}`, adminToken, { stopId: stopB.id });
  const today = todayIn('Asia/Riyadh');
  const trip = await api('POST', '/tenant/trips', adminToken, { routeId, date: today });
  if (trip.status !== 200) throw new Error(JSON.stringify(trip.body));
  return {
    tenantId: admin.context ? (await ownerQuery(`select tenant_id from memberships where id = $1`, [admin.context.mid]))[0].tenant_id : null,
    code, adminToken, driver, driver2, parent1, parent2, student1, student2, routeId, busId: bus.body.bus.id as string,
    stopA, stopB, tripId: trip.body.trip.id as string, today,
  };
}

export const ev = (studentId: string, type: string, extra: Record<string, unknown> = {}) => ({
  clientEventId: randomUUID(), studentId, type, recordedAt: new Date().toISOString(), source: 'manual', ...extra,
});
