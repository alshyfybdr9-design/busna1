/**
 * إدارة المنصة: أدوار فريق المنصة، الخطط وحدودها، والوصول الاستثنائي المؤقت للقراءة فقط.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, buildTenantWorld, platformAdminToken, ownerQuery, getApp, PASSWORD, tokenFromUrl, invite } from './helpers.js';
import { closePools, withCtx } from '../src/db/pool.js';
import { processOutbox } from '../src/worker/dispatcher.js';

let platform: string;
let support: { token: string; refresh: string; userId: string };
let A: Awaited<ReturnType<typeof buildTenantWorld>>;
let B: Awaited<ReturnType<typeof buildTenantWorld>>;

beforeAll(async () => {
  platform = await platformAdminToken();
  A = await buildTenantWorld(platform, 'منصة-أ');
  B = await buildTenantWorld(platform, 'منصة-ب');
  const inv = await api('POST', '/platform/staff/invites', platform, { fullName: 'موظف دعم المنصة', email: 'support@busna.test', role: 'support' });
  expect(inv.status).toBe(200);
  const acc = await api('POST', `/auth/invites/${tokenFromUrl(inv.body.invite.inviteUrl)}/accept`, null, {
    mode: 'register', fullName: 'موظف دعم المنصة', email: 'support@busna.test', password: PASSWORD,
  });
  expect(acc.status).toBe(200);
  expect(acc.body.context).toEqual({ kind: 'platform' });
  support = { token: acc.body.accessToken, refresh: acc.body.refreshToken, userId: acc.body.user.id };
});
afterAll(async () => {
  await (await getApp()).close();
  await closePools();
});

describe('platform staff roles', () => {
  it('support staff can view tenants and the platform ticket queue but cannot manage', async () => {
    const t = await api('GET', '/platform/tenants', support.token);
    expect(t.status).toBe(200);
    expect(t.body.canManage).toBe(false);
    expect((await api('GET', '/support/tickets?scope=queue', support.token)).status).toBe(200);
    expect((await api('GET', '/platform/knowledge', support.token)).status).toBe(200);
    expect((await api('POST', '/platform/tenants', support.token, { code: 'HACK01', name: 'x x', kind: 'school', admin: { fullName: 'x y' } })).status).toBe(403);
    expect((await api('PATCH', `/platform/tenants/${A.tenantId}`, support.token, { status: 'suspended' })).status).toBe(403);
    expect((await api('GET', '/platform/staff', support.token)).status).toBe(403);
    expect((await api('GET', '/tenant/students', support.token)).status).toBe(403);
  });

  it('cannot demote the last admin or change your own role', async () => {
    const me = (await ownerQuery(`select id from users where platform_role = 'admin'`)).map((r) => r.id);
    const staff = await api('GET', '/platform/staff', platform);
    expect(staff.body.staff.map((s: any) => s.role).sort()).toContain('support');
    // تخفيض كل المدراء إلا واحدًا ثم محاولة تخفيض الأخير
    const self = (await api('GET', '/me', platform)).body.user.id;
    for (const id of me.filter((x) => x !== self)) await ownerQuery(`update users set platform_role = null where id = $1`, [id]);
    expect((await api('PATCH', `/platform/staff/${self}`, platform, { role: 'support' })).status).toBe(400);
    const r = await api('PATCH', `/platform/staff/${support.userId}`, platform, { role: 'admin' });
    expect(r.status).toBe(200);
    await api('PATCH', `/platform/staff/${support.userId}`, platform, { role: 'support' });
  });
});

describe('plans and limits', () => {
  it('shows the subscription and usage to the organization', async () => {
    const s = await api('GET', '/tenant/subscription', A.adminToken);
    expect(s.body.subscription).toMatchObject({ plan_code: 'trial', students: 2, buses: 1, drivers: 2 });
  });

  it('enforces plan limits in the database and blocks over-limit invites early', async () => {
    const p = await api('POST', '/platform/plans', platform, {
      code: 'tiny', name: 'صغيرة', maxStudents: 2, maxBuses: 1, maxDrivers: 2, assistantDailyLimit: 0, monthlyPrice: null,
    });
    expect(p.status).toBe(200);
    expect((await api('PUT', `/platform/tenants/${A.tenantId}/subscription`, support.token, { planId: p.body.plan.id, status: 'active', currentPeriodEnd: null })).status).toBe(403);
    const sub = await api('PUT', `/platform/tenants/${A.tenantId}/subscription`, platform, { planId: p.body.plan.id, status: 'active', currentPeriodEnd: '2027-01-01' });
    expect(sub.status).toBe(200);
    const bus = await api('POST', '/tenant/buses', A.adminToken, { plateNumber: 'LIM-1' });
    expect(bus.status).toBe(409);
    expect(bus.body.error.code).toBe('plan_limit_reached');
    expect((await api('POST', '/tenant/students', A.adminToken, { fullName: 'طالب زائد' })).body.error.code).toBe('plan_limit_reached');
    expect((await api('POST', '/tenant/invites', A.adminToken, { role: 'driver', fullName: 'سائق زائد', email: 'extra@busna.test' })).body.error.code).toBe('plan_limit_reached');
    // ولي الأمر لا يتأثر بحد السائقين
    expect((await api('POST', '/tenant/invites', A.adminToken, { role: 'parent', fullName: 'ولي أمر', email: 'p-extra@busna.test' })).status).toBe(200);
    // حد المساعد في الخطة (0) يجعل المساعد في الوضع الاحتياطي
    const r = await api('POST', '/assistant/messages', A.parent1.token, { text: 'مرحبا' });
    expect(r.body.reply.mode).toBe('fallback');
    // الترقية تعيد السماح
    const custom = (await api('GET', '/platform/plans', platform)).body.plans.find((x: any) => x.code === 'custom');
    await api('PUT', `/platform/tenants/${A.tenantId}/subscription`, platform, { planId: custom.id, status: 'active', currentPeriodEnd: null });
    expect((await api('POST', '/tenant/buses', A.adminToken, { plateNumber: 'LIM-2' })).status).toBe(200);
  });
});

describe('exceptional support access', () => {
  it('requires a real reason and respects the organization setting', async () => {
    expect((await api('POST', '/platform/access-grants', support.token, { tenantId: A.tenantId, reason: 'فحص' })).status).toBe(400);
    await api('PATCH', '/tenant/profile', B.adminToken, { settings: { allowPlatformSupportAccess: false } });
    const r = await api('POST', '/platform/access-grants', support.token, { tenantId: B.tenantId, reason: 'متابعة بلاغ عن تأخر الإشعارات لدى الجهة' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('support_access_disabled');
  });

  it('gives time-limited, read-only, audited access that the organization can see and revoke', async () => {
    const g = await api('POST', '/platform/access-grants', support.token, {
      tenantId: A.tenantId, reason: 'التحقق من بلاغ ولي أمر عن عدم ظهور الرحلة', durationMinutes: 15,
    });
    expect(g.status).toBe(200);
    const ref = await api('POST', '/auth/refresh', null, { refreshToken: support.refresh });
    support.refresh = ref.body.refreshToken;
    expect(ref.body.contexts.accessGrants.map((x: any) => x.grantId)).toContain(g.body.grant.id);
    const ctx = await api('POST', '/auth/context', ref.body.accessToken, { accessGrantId: g.body.grant.id });
    const ro = ctx.body.accessToken;

    // قراءة صفحات الإدارة مسموحة
    const students = await api('GET', '/tenant/students', ro);
    expect(students.status).toBe(200);
    expect(students.body.students.map((s: any) => s.id)).toContain(A.student1);
    expect((await api('GET', '/tenant/dashboard', ro)).status).toBe(200);
    const me = await api('GET', '/me', ro);
    expect(me.body.role).toBe('platform_readonly');
    expect(me.body.supportAccess.id).toBe(g.body.grant.id);
    // أي تعديل مرفوض — من الخادم ومن قاعدة البيانات نفسها
    const write = await api('POST', '/tenant/students', ro, { fullName: 'محاولة إضافة' });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe('read_only_access');
    await expect(withCtx({ userId: support.userId, role: 'platform_readonly', tenantId: A.tenantId, membershipId: null }, (c) =>
      c.query(`update students set full_name = 'x' where tenant_id = $1`, [A.tenantId]))).rejects.toMatchObject({ code: '25006' });
    // واجهات أولياء الأمور والسائقين ليست ضمن الوصول
    expect((await api('GET', '/parent/children', ro)).status).toBe(403);
    // جهة أخرى غير مرئية
    expect((await api('GET', `/tenant/students/${B.student1}`, ro)).status).toBe(404);

    // الجهة ترى الوصول والسجل وتُبلَّغ
    const list = await api('GET', '/tenant/support-access', A.adminToken);
    const mine = list.body.grants.find((x: any) => x.id === g.body.grant.id);
    expect(mine.active).toBe(true);
    expect(mine.viewsLogged).toBeGreaterThanOrEqual(2);
    const auditRows = await ownerQuery(`select action from audit_logs where tenant_id = $1 and action like 'platform_access.%'`, [A.tenantId]);
    expect(auditRows.map((r) => r.action)).toEqual(expect.arrayContaining(['platform_access.granted', 'platform_access.view']));
    await processOutbox();
    const n = await api('GET', '/me/notifications', A.adminToken);
    expect(n.body.notifications.some((x: any) => x.kind === 'support_access')).toBe(true);
    // المشرف (ليس مديرًا) لا يرى سجل الوصول
    const sup = await invite(A.adminToken, 'supervisor', 'مشرف تجريبي');
    expect((await api('GET', '/tenant/support-access', sup.token)).status).toBe(403);

    // مدير الجهة ينهي الوصول فورًا
    expect((await api('POST', `/tenant/support-access/${g.body.grant.id}/revoke`, A.adminToken, {})).status).toBe(200);
    expect((await api('GET', '/tenant/students', ro)).status).toBe(401);
    // التجديد بعد الإنهاء يعيد سياق المنصة بدل الوصول للجهة
    const back = await api('POST', '/auth/refresh', null, { refreshToken: support.refresh, accessGrantId: g.body.grant.id });
    expect(back.body.context).toEqual({ kind: 'platform' });
  });

  it('expired grants stop working', async () => {
    const g = await api('POST', '/platform/access-grants', platform, { tenantId: A.tenantId, reason: 'مراجعة إعدادات المسارات بطلب من الجهة', durationMinutes: 5 });
    const ctx = await api('POST', '/auth/context', platform, { accessGrantId: g.body.grant.id });
    expect((await api('GET', '/tenant/routes', ctx.body.accessToken)).status).toBe(200);
    await ownerQuery(`update platform_access_grants set expires_at = created_at + interval '1 second', created_at = created_at where id = $1`, [g.body.grant.id]);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await api('GET', '/tenant/routes', ctx.body.accessToken)).status).toBe(401);
  });
});
