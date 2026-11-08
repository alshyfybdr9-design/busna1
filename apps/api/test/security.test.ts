/**
 * اختبارات العزل والصلاحيات: في الـ API وعلى مستوى قاعدة البيانات (RLS) مباشرة.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { api, buildTenantWorld, platformAdminToken, ev, ownerQuery, getApp, invite, PASSWORD, tokenFromUrl } from './helpers.js';
import { closePools } from '../src/db/pool.js';
import { processOutbox } from '../src/worker/dispatcher.js';

let platform: string;
let A: Awaited<ReturnType<typeof buildTenantWorld>>;
let B: Awaited<ReturnType<typeof buildTenantWorld>>;

beforeAll(async () => {
  platform = await platformAdminToken();
  A = await buildTenantWorld(platform, 'أ');
  B = await buildTenantWorld(platform, 'ب');
});
afterAll(async () => {
  await (await getApp()).close();
  await closePools();
});

/** اتصال مباشر بدور busna_app مع سياق جلسة — لاختبار RLS بمعزل عن كود الخادم */
async function asApp<T>(ctx: { tenantId: string | null; userId: string; role: string }, fn: (c: pg.Client) => Promise<T>) {
  const c = new pg.Client({ connectionString: process.env.DATABASE_APP_URL });
  await c.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.role', $3, true)`, [
      ctx.tenantId ?? '', ctx.userId, ctx.role,
    ]);
    const r = await fn(c);
    await c.query('rollback');
    return r;
  } finally {
    await c.end();
  }
}

describe('authentication & tenant entry', () => {
  it('tenant code reveals only public branding', async () => {
    const r = await api('POST', '/auth/tenant/resolve', null, { code: A.code });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.tenant).sort()).toEqual(['code', 'kind', 'logoUrl', 'name', 'nameEn']);
    expect(JSON.stringify(r.body)).not.toMatch(/سارة|خالد|@busna\.test|\+966/);
  });

  it('invite preview shows organization and role only; invites are single-use', async () => {
    const created = await api('POST', '/tenant/invites', A.adminToken, { role: 'parent', fullName: 'ولي أمر جديد', email: 'newparent@busna.test', studentIds: [A.student1] });
    const tok = tokenFromUrl(created.body.invite.inviteUrl);
    const preview = await api('GET', `/auth/invites/${tok}`);
    expect(preview.status).toBe(200);
    expect(JSON.stringify(preview.body)).not.toMatch(/ولي أمر جديد|newparent|سارة/);
    const wrongEmail = await api('POST', `/auth/invites/${tok}/accept`, null, { mode: 'register', fullName: 'x y', email: 'other@busna.test', password: PASSWORD });
    expect(wrongEmail.body.error.code).toBe('invite_email_mismatch');
    const ok = await api('POST', `/auth/invites/${tok}/accept`, null, { mode: 'register', fullName: 'ولي أمر جديد', email: 'newparent@busna.test', password: PASSWORD });
    expect(ok.status).toBe(200);
    const reuse = await api('POST', `/auth/invites/${tok}/accept`, null, { mode: 'register', fullName: 'مهاجم', email: 'newparent@busna.test', password: PASSWORD });
    expect(reuse.status).toBe(404);
  });

  it('a user with several memberships must choose a context after login', async () => {
    // ولي الأمر في الجهة أ يُدعى أيضًا كولي أمر في الجهة ب
    const created = await api('POST', '/tenant/invites', B.adminToken, { role: 'parent', fullName: 'ولي أمر', email: A.parent1.email, studentIds: [B.student1] });
    const acc = await api('POST', `/auth/invites/${tokenFromUrl(created.body.invite.inviteUrl)}/accept`, null, { mode: 'login', identifier: A.parent1.email, password: PASSWORD });
    expect(acc.status).toBe(200);
    const login = await api('POST', '/auth/login', null, { identifier: A.parent1.email, password: PASSWORD });
    expect(login.body.context).toEqual({ kind: 'none' });
    expect(login.body.contexts.memberships).toHaveLength(2);
    const noCtx = await api('GET', '/parent/children', login.body.accessToken);
    expect(noCtx.status).toBe(403);
    expect(noCtx.body.error.code).toBe('context_required');
    // كل سياق يرى أبناءه في جهته فقط
    const mB = login.body.contexts.memberships.find((m: any) => m.tenantCode === B.code);
    const sel = await api('POST', '/auth/context', login.body.accessToken, { membershipId: mB.membershipId });
    const kids = await api('GET', '/parent/children', sel.body.accessToken);
    expect(kids.body.children.map((c: any) => c.id)).toEqual([B.student1]);
    // لا يمكن اختيار عضوية لا تخصه
    const steal = await api('POST', '/auth/context', login.body.accessToken, { membershipId: (await ownerQuery(`select id from memberships where user_id = $1`, [A.parent2.userId]))[0].id });
    expect(steal.status).toBe(403);
  });

  it('wrong passwords lock the account temporarily', async () => {
    for (let i = 0; i < 5; i++) await api('POST', '/auth/login', null, { identifier: A.parent2.email, password: 'wrong-pass-1' });
    const r = await api('POST', '/auth/login', null, { identifier: A.parent2.email, password: PASSWORD });
    expect(r.status).toBe(429);
    await ownerQuery(`update users set locked_until = null, failed_logins = 0 where id = $1`, [A.parent2.userId]);
  });

  it('refresh token reuse revokes the whole session family', async () => {
    const login = await api('POST', '/auth/login', null, { identifier: A.driver2.email, password: PASSWORD });
    const r1 = await api('POST', '/auth/refresh', null, { refreshToken: login.body.refreshToken });
    expect(r1.status).toBe(200);
    const reuse = await api('POST', '/auth/refresh', null, { refreshToken: login.body.refreshToken });
    expect(reuse.status).toBe(401);
    const r2 = await api('POST', '/auth/refresh', null, { refreshToken: r1.body.refreshToken });
    expect(r2.status).toBe(401);
  });

  it('disabling a membership takes effect immediately', async () => {
    const extra = await invite(A.adminToken, 'parent', 'ولي أمر مؤقت');
    expect((await api('GET', '/parent/children', extra.token)).status).toBe(200);
    const mid = (await ownerQuery(`select id from memberships where user_id = $1`, [extra.userId]))[0].id;
    await api('PATCH', `/tenant/members/${mid}`, A.adminToken, { status: 'disabled' });
    expect((await api('GET', '/parent/children', extra.token)).status).toBe(401);
  });
});

describe('parent isolation', () => {
  it('cannot read or act on a child not linked to them', async () => {
    expect((await api('GET', `/parent/children/${A.student2}/status`, A.parent1.token)).status).toBe(404);
    expect((await api('GET', `/parent/children/${A.student2}/history`, A.parent1.token)).status).toBe(404);
    const abs = await api('POST', '/parent/absences', A.parent1.token, { studentId: A.student2, date: A.today, direction: 'both' });
    expect(abs.status).toBe(404);
  });

  it('cannot use staff or driver endpoints', async () => {
    expect((await api('GET', '/tenant/students', A.parent1.token)).status).toBe(403);
    expect((await api('POST', `/driver/trips/${A.tripId}/start`, A.parent1.token, {})).status).toBe(403);
  });

  it('RLS: parent context sees only own child, own stop, and no other homes', async () => {
    const rows = await asApp({ tenantId: A.tenantId, userId: A.parent1.userId, role: 'parent' }, async (c) => ({
      students: (await c.query('select id from students')).rows.map((r) => r.id),
      stops: (await c.query('select name from route_stops order by seq')).rows.map((r) => r.name),
      riders: (await c.query('select student_id from trip_riders')).rows.map((r) => r.student_id),
      guardians: (await c.query('select guardian_user_id from guardian_students')).rows.length,
    }));
    expect(rows.students).toEqual([A.student1]);
    expect(rows.stops).toEqual(['نقطة 1', 'المدرسة']);
    expect(rows.riders).toEqual([A.student1]);
    expect(rows.guardians).toBe(1);
  });

  it('RLS: parent cannot write students, locations or other parents\' absences', async () => {
    await expect(asApp({ tenantId: A.tenantId, userId: A.parent1.userId, role: 'parent' }, (c) =>
      c.query(`insert into students (tenant_id, full_name) values ($1, 'دخيل')`, [A.tenantId]))).rejects.toThrow(/row-level security/);
    await expect(asApp({ tenantId: A.tenantId, userId: A.parent1.userId, role: 'parent' }, (c) =>
      c.query(`insert into absences (tenant_id, student_id, absence_date, direction, requested_by) values ($1, $2, current_date, 'both', $3)`,
        [A.tenantId, A.student2, A.parent1.userId]))).rejects.toThrow(/row-level security/);
  });
});

describe('cross-tenant isolation', () => {
  it('admin of tenant B cannot see tenant A data through the API', async () => {
    expect((await api('GET', `/tenant/students/${A.student1}`, B.adminToken)).status).toBe(404);
    expect((await api('GET', `/tenant/trips/${A.tripId}`, B.adminToken)).status).toBe(404);
    const list = await api('GET', '/tenant/students', B.adminToken);
    expect(list.body.students.map((s: any) => s.id)).not.toContain(A.student1);
    const assign = await api('PUT', `/tenant/routes/${B.routeId}/riders/${A.student1}`, B.adminToken, { stopId: B.stopA.id });
    expect(assign.status).toBe(404);
    const inv = await api('POST', '/tenant/invites', B.adminToken, { role: 'parent', fullName: 'محاولة ربط', email: 'x@busna.test', studentIds: [A.student1] });
    expect(inv.status).toBe(404);
  });

  it('driver of tenant B cannot touch tenant A trips', async () => {
    expect((await api('POST', `/driver/trips/${A.tripId}/start`, B.driver.token, {})).status).toBe(404);
    expect((await api('POST', `/driver/trips/${A.tripId}/events`, B.driver.token, { events: [ev(A.student1, 'boarded')] })).status).toBe(404);
  });

  it('RLS: tenant context cannot read or write another tenant even with a forged id', async () => {
    const r = await asApp({ tenantId: B.tenantId, userId: randomUUID(), role: 'tenant_admin' }, async (c) => ({
      students: (await c.query('select id from students where id = $1', [A.student1])).rowCount,
      trips: (await c.query('select id from trips where id = $1', [A.tripId])).rowCount,
      upd: (await c.query(`update students set full_name = 'x' where id = $1`, [A.student1])).rowCount,
    }));
    expect(r).toEqual({ students: 0, trips: 0, upd: 0 });
    await expect(asApp({ tenantId: B.tenantId, userId: randomUUID(), role: 'tenant_admin' }, (c) =>
      c.query(`insert into students (tenant_id, full_name) values ($1, 'دخيل')`, [A.tenantId]))).rejects.toThrow(/row-level security/);
  });

  it('platform admin sees aggregate counts but not tenant students', async () => {
    const list = await api('GET', '/platform/tenants', platform);
    const a = list.body.tenants.find((t: any) => t.code === A.code);
    expect(a.students).toBe(2);
    const r = await asApp({ tenantId: null, userId: randomUUID(), role: 'platform_admin' }, async (c) => (await c.query('select id from students')).rowCount);
    expect(r).toBe(0);
    expect((await api('GET', '/tenant/students', platform)).status).toBe(403);
  });
});

describe('driver isolation and trip safety', () => {
  it('another driver in the same tenant cannot start or update the trip', async () => {
    expect((await api('POST', `/driver/trips/${A.tripId}/start`, A.driver2.token, {})).status).toBe(404);
    expect((await api('POST', `/driver/trips/${A.tripId}/locations`, A.driver2.token, {
      points: [{ recordedAt: new Date().toISOString(), lat: 1, lng: 1 }],
    })).status).toBe(404);
    const rows = await asApp({ tenantId: A.tenantId, userId: A.driver2.userId, role: 'driver' }, async (c) =>
      (await c.query(`update trips set status = 'in_progress' where id = $1`, [A.tripId])).rowCount);
    expect(rows).toBe(0);
  });

  it('DB trigger stops a driver from changing the trip plan', async () => {
    await expect(asApp({ tenantId: A.tenantId, userId: A.driver.userId, role: 'driver' }, (c) =>
      c.query(`update trips set driver_user_id = $2 where id = $1`, [A.tripId, A.driver2.userId]))).rejects.toThrow(/driver_cannot_modify_trip_plan/);
  });

  it('approved absence marks the rider absent; cancelling restores them', async () => {
    const abs = await api('POST', '/parent/absences', A.parent2.token, { studentId: A.student2, date: A.today, direction: 'to_school' });
    expect(abs.body.absence.status).toBe('approved');
    let rider = await ownerQuery(`select status from trip_riders where trip_id = $1 and student_id = $2`, [A.tripId, A.student2]);
    expect(rider[0].status).toBe('absent');
    const cancel = await api('POST', `/parent/absences/${abs.body.absence.id}/cancel`, A.parent2.token, {});
    expect(cancel.status).toBe(200);
    rider = await ownerQuery(`select status from trip_riders where trip_id = $1 and student_id = $2`, [A.tripId, A.student2]);
    expect(rider[0].status).toBe('expected');
  });

  it('QR lookup identifies a rider but still requires driver confirmation', async () => {
    await api('POST', `/driver/trips/${A.tripId}/start`, A.driver.token, {});
    const qr = (await ownerQuery(`select qr_token from students where id = $1`, [A.student1]))[0].qr_token;
    const r = await api('POST', `/driver/trips/${A.tripId}/qr`, A.driver.token, { qrToken: qr });
    expect(r.body).toMatchObject({ requiresConfirmation: true, rider: { studentId: A.student1, status: 'expected' } });
    const otherTenantQr = (await ownerQuery(`select qr_token from students where id = $1`, [B.student1]))[0].qr_token;
    expect((await api('POST', `/driver/trips/${A.tripId}/qr`, A.driver.token, { qrToken: otherTenantQr })).status).toBe(404);
  });

  it('correction requires staff and a reason, and is recorded', async () => {
    expect((await api('POST', `/tenant/trips/${A.tripId}/riders/x/correct`, A.driver.token, {})).status).toBe(403);
    const rider = (await ownerQuery(`select id from trip_riders where trip_id = $1 and student_id = $2`, [A.tripId, A.student1]))[0].id;
    const noReason = await api('POST', `/tenant/trips/${A.tripId}/riders/${rider}/correct`, A.adminToken, { status: 'boarded', reason: '' });
    expect(noReason.status).toBe(400);
    const ok = await api('POST', `/tenant/trips/${A.tripId}/riders/${rider}/correct`, A.adminToken, { status: 'boarded', reason: 'صعد دون تسجيل — تأكيد هاتفي من السائق' });
    expect(ok.body).toMatchObject({ previousStatus: 'expected', newStatus: 'boarded' });
    const audit = await ownerQuery(`select details from audit_logs where action = 'rider.corrected' and entity_id = $1`, [rider]);
    expect(audit[0].details.reason).toContain('تأكيد');
  });

  it('ending with a child on board escalates a critical alert to staff', async () => {
    const end = await api('POST', `/driver/trips/${A.tripId}/end`, A.driver.token, { acknowledgeUnresolved: true });
    expect(end.body.escalated).toBe(true);
    const dash = await api('GET', '/tenant/dashboard', A.adminToken);
    const kinds = dash.body.alerts.map((a: any) => `${a.kind}:${a.severity}`);
    expect(kinds).toContain('unresolved_riders:critical');
    expect(kinds).toContain('unrecorded_riders:high');
    await processOutbox();
    const n = await api('GET', '/me/notifications', A.adminToken);
    expect(n.body.notifications.some((x: any) => x.kind === 'alert_unresolved_riders')).toBe(true);
  });

  it('emergency report returns direct call numbers and deduplicates', async () => {
    const id = randomUUID();
    const r1 = await api('POST', '/driver/report', A.driver.token, { kind: 'emergency', category: 'accident', clientEventId: id });
    expect(r1.body.call).toEqual({ emergencyNumber: '911', supervisorPhone: '+966500000000' });
    const r2 = await api('POST', '/driver/report', A.driver.token, { kind: 'emergency', category: 'accident', clientEventId: id });
    expect(r2.body).toMatchObject({ duplicate: true, alertId: r1.body.alertId });
  });
});
