/**
 * المرافق على الباص: يسجّل الحضور والتسليم والفحص والبلاغات، ولا يبدأ الرحلة أو ينهيها أو يرسل الموقع.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, buildTenantWorld, platformAdminToken, ev, ownerQuery, getApp, invite } from './helpers.js';
import { processOutbox } from '../src/worker/dispatcher.js';
import { closePools } from '../src/db/pool.js';

let w: Awaited<ReturnType<typeof buildTenantWorld>>;
let other: Awaited<ReturnType<typeof buildTenantWorld>>;
let att: Awaited<ReturnType<typeof invite>>;
let otherAtt: Awaited<ReturnType<typeof invite>>;
let tripId: string;

beforeAll(async () => {
  const p = await platformAdminToken();
  w = await buildTenantWorld(p, 'المرافقة');
  other = await buildTenantWorld(p, 'جهة ثانية');
  att = await invite(w.adminToken, 'attendant', 'مرافقة الباص');
  otherAtt = await invite(other.adminToken, 'attendant', 'مرافقة جهة ثانية');
});
afterAll(async () => {
  await (await getApp()).close();
  await closePools();
});

describe('attendant role', () => {
  it('only an attendant of the same tenant can be assigned to a route', async () => {
    const wrongRole = await api('PATCH', `/tenant/routes/${w.routeId}`, w.adminToken, { attendantUserId: w.driver2.userId });
    expect(wrongRole.status).toBe(400);
    const foreign = await api('PATCH', `/tenant/routes/${w.routeId}`, w.adminToken, { attendantUserId: otherAtt.userId });
    expect(foreign.status).toBe(400);
    const ok = await api('PATCH', `/tenant/routes/${w.routeId}`, w.adminToken, { attendantUserId: att.userId });
    expect(ok.status).toBe(200);
    const list = await api('GET', '/tenant/routes', w.adminToken);
    expect(list.body.routes.find((r: any) => r.id === w.routeId).attendantName).toBe('مرافقة الباص');
  });

  it('new trips carry the route attendant; the attendant sees only their trips', async () => {
    const t = await api('POST', '/tenant/trips', w.adminToken, { routeId: w.routeId, date: new Date(Date.parse(`${w.today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10) });
    expect(t.status).toBe(200);
    const row = await ownerQuery(`select attendant_user_id from trips where id = $1`, [t.body.trip.id]);
    expect(row[0].attendant_user_id).toBe(att.userId);
    // رحلة اليوم أُنشئت قبل التعيين: تُعيَّن من قاعدة البيانات لهذا الاختبار
    await ownerQuery(`update trips set attendant_user_id = $2 where id = $1`, [w.tripId, att.userId]);
    tripId = w.tripId;
    const mine = await api('GET', '/driver/trips', att.token);
    expect(mine.status).toBe(200);
    expect(mine.body.myRole).toBe('attendant');
    expect(mine.body.trips.map((x: any) => x.id)).toContain(tripId);
    const d = await api('GET', `/driver/trips/${tripId}`, att.token);
    expect(d.status).toBe(200);
    expect(d.body.crew).toMatchObject({ attendantName: 'مرافقة الباص' });
    expect(d.body.crew.driverName).toContain('سائق');
    expect(d.body.riders).toHaveLength(2);
    // مرافقة جهة أخرى لا ترى الرحلة
    expect((await api('GET', `/driver/trips/${tripId}`, otherAtt.token)).status).toBe(404);
    // والسائق الاحتياط (غير معيّن) لا يرى رحلة المرافقة
    expect((await api('GET', `/driver/trips/${tripId}`, w.driver2.token)).status).toBe(404);
  });

  it('attendant cannot start the trip, send locations, or use staff pages', async () => {
    expect((await api('POST', `/driver/trips/${tripId}/start`, att.token, {})).status).toBe(403);
    expect((await api('POST', `/driver/trips/${tripId}/locations`, att.token, { points: [{ recordedAt: new Date().toISOString(), lat: 24.7, lng: 46.6 }] })).status).toBe(403);
    expect((await api('GET', '/tenant/students', att.token)).status).toBe(403);
    // قبل بدء الرحلة لا يُقبل تسجيل الحضور
    const early = await api('POST', `/driver/trips/${tripId}/events`, att.token, { events: [ev(w.student1, 'boarded')] });
    expect(early.body.results[0]).toMatchObject({ result: 'rejected', code: 'trip_not_active' });
  });

  it('after the driver starts, the attendant records boarding and the driver sees it', async () => {
    expect((await api('POST', `/driver/trips/${tripId}/start`, w.driver.token, {})).status).toBe(200);
    const r = await api('POST', `/driver/trips/${tripId}/events`, att.token, { events: [ev(w.student1, 'boarded', { source: 'qr' }), ev(w.student2, 'no_show')] });
    expect(r.body.results.map((x: any) => x.result)).toEqual(['applied', 'applied']);
    const d = await api('GET', `/driver/trips/${tripId}`, w.driver.token);
    expect(d.body.riders.find((x: any) => x.studentId === w.student1).status).toBe('boarded');
    const by = await ownerQuery(`select recorded_by from boarding_events where trip_id = $1 and student_id = $2 and type = 'boarded'`, [tripId, w.student1]);
    expect(by[0].recorded_by).toBe(att.userId);
    // الإشعار يصل لولي الأمر كالمعتاد
    await processOutbox();
    const n = await api('GET', '/me/notifications', w.parent1.token);
    expect(n.body.notifications.some((x: any) => x.kind === 'rider_boarded')).toBe(true);
  });

  it('attendant can report but cannot end the trip; database blocks trip changes', async () => {
    const rep = await api('POST', '/driver/report', att.token, { tripId, kind: 'issue', category: 'student_behavior', clientEventId: crypto.randomUUID() });
    expect(rep.status).toBe(200);
    expect((await api('POST', `/driver/trips/${tripId}/end`, att.token, { acknowledgeUnresolved: true })).status).toBe(403);
    await api('POST', `/driver/trips/${tripId}/events`, att.token, { events: [ev(w.student1, 'alighted')] });
    expect((await api('POST', `/driver/trips/${tripId}/end`, w.driver.token, {})).status).toBe(200);
  });

  it('attendant performs the bus-empty check after the driver ends the trip', async () => {
    const r = await api('POST', `/driver/trips/${tripId}/inspection`, att.token, {
      clientEventId: crypto.randomUUID(), startedAt: new Date().toISOString(), result: 'bus_empty',
      checklist: { walkedToRear: true, checkedSeats: true, checkedUnderSeats: true, checkedBackRow: true, noBelongingsLeft: true },
    });
    expect(r.status).toBe(200);
    const t = await api('GET', `/tenant/trips/${tripId}`, w.adminToken);
    expect(t.body.trip.inspectionStatus).toBe('completed');
    expect(t.body.trip.attendantName).toBe('مرافقة الباص');
    const insp = await ownerQuery(`select driver_user_id from trip_inspections where trip_id = $1`, [tripId]);
    expect(insp[0].driver_user_id).toBe(att.userId);
  });

  it('broadcast to drivers also reaches attendants', async () => {
    await api('POST', '/tenant/broadcasts', w.adminToken, { audience: 'drivers', category: 'general', title: 'تعميم للطاقم', body: 'اجتماع الطاقم غدًا.' });
    await processOutbox();
    const n = await api('GET', '/me/notifications', att.token);
    expect(n.body.notifications.some((x: any) => x.title.includes('تعميم للطاقم'))).toBe(true);
  });

  it('supervisors can invite attendants', async () => {
    const sup = await invite(w.adminToken, 'supervisor', 'مشرف');
    const r = await api('POST', '/tenant/invites', sup.token, { role: 'attendant', fullName: 'مرافقة جديدة', email: `att-${Date.now()}@busna.test` });
    expect(r.status).toBe(200);
  });
});
