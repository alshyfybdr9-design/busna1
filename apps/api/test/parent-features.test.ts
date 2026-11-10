/**
 * ميزات ولي الأمر والسلامة: تنبيه الاقتراب، الرسائل الجماعية، التسليم الآمن، طلبات تغيير العنوان.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, buildTenantWorld, platformAdminToken, ev, ownerQuery, getApp, invite } from './helpers.js';
import { processOutbox, runApproachChecks } from '../src/worker/dispatcher.js';
import { closePools } from '../src/db/pool.js';

let w: Awaited<ReturnType<typeof buildTenantWorld>>;
let other: Awaited<ReturnType<typeof buildTenantWorld>>;

const notes = async (token: string) => (await api('GET', '/me/notifications', token)).body.notifications as any[];
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  const p = await platformAdminToken();
  w = await buildTenantWorld(p, 'الميزات');
  other = await buildTenantWorld(p, 'جهة أخرى');
});
afterAll(async () => {
  await (await getApp()).close();
  await closePools();
});

describe('bus approaching alert + ETA', () => {
  it('parent sees the default distance and can change it for own child only', async () => {
    const s = await api('GET', `/parent/children/${w.student1}/settings`, w.parent1.token);
    expect(s.status).toBe(200);
    expect(s.body.approach).toMatchObject({ meters: 1000, custom: false });
    // ولي أمر خالد يوقف التنبيه لابنه
    const off = await api('PUT', `/parent/children/${w.student2}/approach`, w.parent2.token, { meters: null });
    expect(off.status).toBe(200);
    // لا يستطيع تغيير إعداد طفل غيره
    const denied = await api('PUT', `/parent/children/${w.student1}/approach`, w.parent2.token, { meters: 500 });
    expect(denied.status).toBe(404);
    const otherTenant = await api('GET', `/parent/children/${w.student1}/settings`, other.parent1.token);
    expect(otherTenant.status).toBe(404);
  });

  it('notifies once when the bus is within the distance, with an estimated ETA', async () => {
    expect((await api('POST', `/driver/trips/${w.tripId}/start`, w.driver.token, {})).status).toBe(200);
    // الباص على بعد ~2.5 كم من نقطة 1 — خارج المسافة
    await api('POST', `/driver/trips/${w.tripId}/locations`, w.driver.token, {
      points: [{ recordedAt: new Date(Date.now() - 20_000).toISOString(), lat: 24.6936, lng: 46.6653, speedMps: 9 }],
    });
    await runApproachChecks();
    await processOutbox();
    expect((await notes(w.parent1.token)).some((n) => n.kind === 'bus_approaching')).toBe(false);

    // يقترب إلى ~600 م
    await api('POST', `/driver/trips/${w.tripId}/locations`, w.driver.token, {
      points: [{ recordedAt: new Date().toISOString(), lat: 24.7085, lng: 46.6735, speedMps: 9 }],
    });
    const status = await api('GET', `/parent/children/${w.student1}/status`, w.parent1.token);
    expect(status.body.eta).toMatchObject({ available: true, estimated: true, provider: 'estimate' });
    expect(status.body.eta.seconds).toBeGreaterThan(0);

    await runApproachChecks();
    await runApproachChecks();
    await processOutbox();
    const mine = (await notes(w.parent1.token)).filter((n) => n.kind === 'bus_approaching');
    expect(mine).toHaveLength(1);
    expect(mine[0].body).toContain('تقريبًا');
    const rows = await ownerQuery(`select push_title, push_body from notifications where user_id = $1 and kind = 'bus_approaching'`, [w.parent1.userId]);
    expect(rows[0].push_body).not.toContain('سارة');
    // ولي الأمر الذي أوقف التنبيه لا يصله شيء
    expect((await notes(w.parent2.token)).some((n) => n.kind === 'bus_approaching')).toBe(false);
  });
});

describe('broadcast messages', () => {
  it('only staff can send, and only to their own routes', async () => {
    const asParent = await api('POST', '/tenant/broadcasts', w.parent1.token, { audience: 'all_parents', category: 'general', title: 'اختبار', body: 'اختبار' });
    expect(asParent.status).toBe(403);
    const foreign = await api('POST', '/tenant/broadcasts', w.adminToken, {
      audience: 'routes', routeIds: [other.routeId], category: 'delay', title: 'تأخير', body: 'تأخير بسيط', delayMinutes: 10,
    });
    expect(foreign.status).toBe(404);
  });

  it('delivers a route delay message to that route’s parents only', async () => {
    const r = await api('POST', '/tenant/broadcasts', w.adminToken, {
      audience: 'routes', routeIds: [w.routeId], category: 'delay', title: 'تأخير رحلة الصباح', body: 'ازدحام في الطريق الدائري.', delayMinutes: 15,
    });
    expect(r.status).toBe(200);
    await processOutbox();
    const n1 = (await notes(w.parent1.token)).find((n) => n.kind === 'broadcast');
    expect(n1.title).toContain('تأخير');
    expect(n1.body).toContain('15');
    expect((await notes(w.parent2.token)).some((n) => n.kind === 'broadcast')).toBe(true);
    expect((await notes(other.parent1.token)).some((n) => n.kind === 'broadcast')).toBe(false);
    expect((await notes(w.driver.token)).some((n) => n.kind === 'broadcast')).toBe(false);
    const list = await api('GET', '/tenant/broadcasts', w.adminToken);
    expect(list.body.broadcasts[0].recipientCount).toBe(2);
    // تظهر في الصفحة الرئيسية لولي الأمر
    const home = await api('GET', '/parent/children', w.parent1.token);
    expect(home.body.messages[0].title).toContain('تأخير رحلة الصباح');
  });

  it('drivers audience reaches drivers, not parents', async () => {
    await api('POST', '/tenant/broadcasts', w.adminToken, { audience: 'drivers', category: 'general', title: 'تعميم للسائقين', body: 'اجتماع الساعة 1 ظهرًا.' });
    await processOutbox();
    expect((await notes(w.driver2.token)).some((n) => n.title.includes('تعميم للسائقين'))).toBe(true);
    expect((await notes(w.parent1.token)).some((n) => n.title.includes('تعميم للسائقين'))).toBe(false);
    const d = await api('GET', '/driver/trips', w.driver2.token);
    expect(d.body.messages.some((m: any) => m.title.includes('تعميم للسائقين'))).toBe(true);
  });
});

describe('safe handover on the way home', () => {
  let homeRoute: string;
  let homeTrip: string;
  let pickupId: string;
  let guardian2: Awaited<ReturnType<typeof invite>>;

  beforeAll(async () => {
    const route = await api('POST', '/tenant/routes', w.adminToken, { name: 'مسار العودة', direction: 'from_school', busId: w.busId, driverUserId: w.driver2.userId });
    homeRoute = route.body.route.id;
    const stops = await api('PUT', `/tenant/routes/${homeRoute}/stops`, w.adminToken, {
      stops: [
        { name: 'المدرسة', kind: 'school', lat: 24.73, lng: 46.69 },
        { name: 'منزل سارة', lat: 24.7136, lng: 46.6753 },
        { name: 'منزل خالد', lat: 24.72, lng: 46.68 },
      ],
    });
    await api('PUT', `/tenant/routes/${homeRoute}/riders/${w.student1}`, w.adminToken, { stopId: stops.body.stops[1].id });
    await api('PUT', `/tenant/routes/${homeRoute}/riders/${w.student2}`, w.adminToken, { stopId: stops.body.stops[2].id });
    // سارة صغيرة: تتطلب تسليمًا آمنًا
    expect((await api('PATCH', `/tenant/students/${w.student1}`, w.adminToken, { requiresHandover: true })).status).toBe(200);
    guardian2 = await invite(w.adminToken, 'parent', 'خالة سارة', [w.student1]);
    const trip = await api('POST', '/tenant/trips', w.adminToken, { routeId: homeRoute, date: w.today });
    homeTrip = trip.body.trip.id;
  });

  it('parent manages authorized pickups for own child only', async () => {
    const add = await api('POST', `/parent/children/${w.student1}/pickups`, w.parent1.token, { fullName: 'عمّ سارة', relationship: 'عم', phone: '+966511111111' });
    expect(add.status).toBe(200);
    pickupId = add.body.pickup.id;
    const notMine = await api('POST', `/parent/children/${w.student1}/pickups`, w.parent2.token, { fullName: 'شخص آخر' });
    expect(notMine.status).toBe(404);
    const revokeOther = await api('POST', `/parent/pickups/${pickupId}/revoke`, w.parent2.token);
    expect(revokeOther.status).toBe(404);
    const s = await api('GET', `/parent/children/${w.student1}/settings`, w.parent1.token);
    expect(s.body.child.requiresHandover).toBe(true);
    expect(s.body.pickups.map((p: any) => p.fullName)).toContain('عمّ سارة');
  });

  it('driver sees receivers (names only) and cannot drop off without choosing one', async () => {
    expect((await api('POST', `/driver/trips/${homeTrip}/start`, w.driver2.token, {})).status).toBe(200);
    const d = await api('GET', `/driver/trips/${homeTrip}`, w.driver2.token);
    const sara = d.body.riders.find((r: any) => r.studentId === w.student1);
    const khaled = d.body.riders.find((r: any) => r.studentId === w.student2);
    expect(sara.requiresHandover).toBe(true);
    expect(khaled.requiresHandover).toBe(false);
    expect(sara.receivers.map((r: any) => r.fullName).sort()).toEqual(['خالة سارة', 'عمّ سارة', 'ولي أمر سارة الميزات'].sort());
    expect(JSON.stringify(sara.receivers)).not.toContain('+9665'); // بدون أرقام هواتف

    await api('POST', `/driver/trips/${homeTrip}/events`, w.driver2.token, { events: [ev(w.student1, 'boarded'), ev(w.student2, 'boarded')] });
    const noHandover = await api('POST', `/driver/trips/${homeTrip}/events`, w.driver2.token, { events: [ev(w.student1, 'alighted')] });
    expect(noHandover.body.results[0]).toMatchObject({ result: 'rejected', code: 'handover_required' });
    const fake = await api('POST', `/driver/trips/${homeTrip}/events`, w.driver2.token, {
      events: [ev(w.student1, 'alighted', { handover: { kind: 'authorized', refId: w.student2 } })],
    });
    expect(fake.body.results[0]).toMatchObject({ result: 'rejected', code: 'invalid_receiver' });
    // خالد لا يتطلب تسليمًا
    const k = await api('POST', `/driver/trips/${homeTrip}/events`, w.driver2.token, { events: [ev(w.student2, 'alighted')] });
    expect(k.body.results[0].result).toBe('applied');
  });

  it('no receiver keeps the child on the bus and alerts staff and parents', async () => {
    const r = await api('POST', `/driver/trips/${homeTrip}/riders/${w.student1}/no-receiver`, w.driver2.token, {});
    expect(r.status).toBe(200);
    const again = await api('POST', `/driver/trips/${homeTrip}/riders/${w.student1}/no-receiver`, w.driver2.token, {});
    expect(again.body.duplicate).toBe(true);
    await processOutbox();
    const alerts = await api('GET', '/tenant/alerts', w.adminToken);
    expect(alerts.body.alerts.some((a: any) => a.kind === 'no_receiver')).toBe(true);
    expect((await notes(w.parent1.token)).some((n) => n.kind === 'no_receiver')).toBe(true);
    expect((await notes(guardian2.token)).some((n) => n.kind === 'no_receiver')).toBe(true);
    const d = await api('GET', `/driver/trips/${homeTrip}`, w.driver2.token);
    expect(d.body.riders.find((x: any) => x.studentId === w.student1).status).toBe('boarded');
  });

  it('records who received the child and tells the parents', async () => {
    const ok = await api('POST', `/driver/trips/${homeTrip}/events`, w.driver2.token, {
      events: [ev(w.student1, 'alighted', { handover: { kind: 'authorized', refId: pickupId } })],
    });
    expect(ok.body.results[0].result).toBe('applied');
    await processOutbox();
    const n = (await notes(w.parent1.token)).find((x) => x.kind === 'rider_alighted' && x.data?.tripId === homeTrip);
    expect(n.body).toContain('عمّ سارة');
    const ev2 = await ownerQuery(`select handover_kind, handover_to from boarding_events where trip_id = $1 and student_id = $2 and type = 'alighted'`, [homeTrip, w.student1]);
    expect(ev2[0]).toMatchObject({ handover_kind: 'authorized', handover_to: 'عمّ سارة' });
    const s = await api('GET', `/parent/children/${w.student1}/status`, w.parent1.token);
    expect(s.body.trip.handoverTo).toBe('عمّ سارة');
  });
});

describe('stop change requests', () => {
  let newStopId: string;
  let reqId: string;
  const tomorrow = () => addDays(w.today, 1);

  beforeAll(async () => {
    const r = await api('GET', `/tenant/routes/${w.routeId}`, w.adminToken);
    newStopId = r.body.stops.find((s: any) => s.name === 'نقطة 2').id;
  });

  it('parent submits a temporary change for own child; others cannot see it', async () => {
    const bad = await api('POST', '/parent/stop-changes', w.parent2.token, {
      studentId: w.student1, kind: 'temporary', direction: 'to_school', startDate: tomorrow(), endDate: addDays(w.today, 3), address: 'بيت الجد',
    });
    expect(bad.status).toBe(404);
    const tooLong = await api('POST', '/parent/stop-changes', w.parent1.token, {
      studentId: w.student1, kind: 'temporary', direction: 'to_school', startDate: tomorrow(), endDate: addDays(w.today, 90), address: 'بيت الجد',
    });
    expect(tooLong.status).toBe(400);
    const r = await api('POST', '/parent/stop-changes', w.parent1.token, {
      studentId: w.student1, kind: 'temporary', direction: 'to_school', startDate: tomorrow(), endDate: addDays(w.today, 3),
      address: 'بيت الجد — حي الياسمين', lat: 24.72, lng: 46.68, note: 'سفر الوالدين',
    });
    expect(r.status).toBe(200);
    reqId = r.body.request.id;
    expect((await api('GET', '/parent/stop-changes', w.parent2.token)).body.requests).toHaveLength(0);
    expect((await api('GET', '/tenant/stop-changes', other.adminToken)).body.requests).toHaveLength(0);
    const list = await api('GET', '/tenant/stop-changes?status=pending', w.adminToken);
    expect(list.body.requests.map((x: any) => x.id)).toContain(reqId);
  });

  it('approval needs a valid route/stop of the same tenant and direction', async () => {
    const none = await api('POST', `/tenant/stop-changes/${reqId}/review`, w.adminToken, { decision: 'approved' });
    expect(none.status).toBe(400);
    const foreign = await api('POST', `/tenant/stop-changes/${reqId}/review`, w.adminToken, {
      decision: 'approved', assignments: [{ direction: 'to_school', routeId: other.routeId, stopId: other.stopB.id }],
    });
    expect(foreign.status).toBe(400);
    const asParent = await api('POST', `/tenant/stop-changes/${reqId}/review`, w.parent1.token, { decision: 'rejected' });
    expect(asParent.status).toBe(403);
  });

  it('approved temporary change is used for trips in the period only', async () => {
    const ok = await api('POST', `/tenant/stop-changes/${reqId}/review`, w.adminToken, {
      decision: 'approved', note: 'تم', assignments: [{ direction: 'to_school', routeId: w.routeId, stopId: newStopId }],
    });
    expect(ok.status).toBe(200);
    const inPeriod = await api('POST', '/tenant/trips', w.adminToken, { routeId: w.routeId, date: tomorrow() });
    const rider = await ownerQuery(`select stop_id from trip_riders where trip_id = $1 and student_id = $2`, [inPeriod.body.trip.id, w.student1]);
    expect(rider[0].stop_id).toBe(newStopId);
    const after = await api('POST', '/tenant/trips', w.adminToken, { routeId: w.routeId, date: addDays(w.today, 5) });
    const rider2 = await ownerQuery(`select stop_id from trip_riders where trip_id = $1 and student_id = $2`, [after.body.trip.id, w.student1]);
    expect(rider2[0].stop_id).toBe(w.stopA.id);
    // التعيين الدائم لم يتغير
    const rr = await ownerQuery(`select stop_id from route_riders where route_id = $1 and student_id = $2`, [w.routeId, w.student1]);
    expect(rr[0].stop_id).toBe(w.stopA.id);
    await processOutbox();
    expect((await notes(w.parent1.token)).some((n) => n.kind === 'stop_change_updated')).toBe(true);
    // ولي الأمر يرى نقطة التوقف الجديدة لطفله فقط
    const again = await api('POST', `/tenant/stop-changes/${reqId}/review`, w.adminToken, { decision: 'rejected' });
    expect(again.status).toBe(409);
  });

  it('approved permanent change moves the regular assignment and updates scheduled trips', async () => {
    const r = await api('POST', '/parent/stop-changes', w.parent2.token, {
      studentId: w.student2, kind: 'permanent', direction: 'to_school', startDate: w.today, address: 'المنزل الجديد',
    });
    const future = await api('POST', '/tenant/trips', w.adminToken, { routeId: w.routeId, date: addDays(w.today, 7) });
    const ok = await api('POST', `/tenant/stop-changes/${r.body.request.id}/review`, w.adminToken, {
      decision: 'approved', assignments: [{ direction: 'to_school', routeId: w.routeId, stopId: w.stopA.id }],
    });
    expect(ok.status).toBe(200);
    const rr = await ownerQuery(`select stop_id from route_riders where route_id = $1 and student_id = $2`, [w.routeId, w.student2]);
    expect(rr[0].stop_id).toBe(w.stopA.id);
    const tr = await ownerQuery(`select stop_id from trip_riders where trip_id = $1 and student_id = $2`, [future.body.trip.id, w.student2]);
    expect(tr[0].stop_id).toBe(w.stopA.id);
  });

  it('parent cancels only own pending requests', async () => {
    const r = await api('POST', '/parent/stop-changes', w.parent1.token, {
      studentId: w.student1, kind: 'permanent', direction: 'from_school', startDate: tomorrow(), address: 'عنوان آخر',
    });
    expect((await api('POST', `/parent/stop-changes/${r.body.request.id}/cancel`, w.parent2.token)).status).toBe(409);
    expect((await api('POST', `/parent/stop-changes/${r.body.request.id}/cancel`, w.parent1.token)).status).toBe(200);
    expect((await api('POST', `/parent/stop-changes/${reqId}/cancel`, w.parent1.token)).status).toBe(409);
  });
});

describe('student cards', () => {
  it('students list includes the QR token for printing cards', async () => {
    const r = await api('GET', '/tenant/students', w.adminToken);
    expect(r.body.students[0].qrToken).toMatch(/^[a-f0-9]{32}$/);
    expect((await api('GET', '/tenant/students', w.parent1.token)).status).toBe(403);
  });
});
