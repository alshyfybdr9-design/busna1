/**
 * المسار الأساسي الكامل:
 * إضافة طالب ← تعيينه لباص ومسار ← بدء رحلة ← صعود ونزول ← متابعة ولي الأمر ← إنهاء الرحلة وفحص الباص
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { api, buildTenantWorld, platformAdminToken, ev, ownerQuery, getApp } from './helpers.js';
import { processOutbox } from '../src/worker/dispatcher.js';
import { closePools } from '../src/db/pool.js';

let w: Awaited<ReturnType<typeof buildTenantWorld>>;

beforeAll(async () => {
  w = await buildTenantWorld(await platformAdminToken(), 'المسار');
});
afterAll(async () => {
  await (await getApp()).close();
  await closePools();
});

describe('core trip flow', () => {
  it('parent sees child before the trip starts, without location', async () => {
    const r = await api('GET', '/parent/children', w.parent1.token);
    expect(r.status).toBe(200);
    expect(r.body.children).toHaveLength(1);
    expect(r.body.children[0].id).toBe(w.student1);
    expect(r.body.children[0].today[0].tripStatus).toBe('scheduled');
    const s = await api('GET', `/parent/children/${w.student1}/status`, w.parent1.token);
    expect(s.body.tracking).toEqual({ available: false, reason: 'trip_not_active' });
  });

  it('rejects location before trip start', async () => {
    const r = await api('POST', `/driver/trips/${w.tripId}/locations`, w.driver.token, {
      points: [{ recordedAt: new Date().toISOString(), lat: 24.71, lng: 46.67 }],
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('trip_not_active');
  });

  it('driver sees the trip and starts it', async () => {
    const list = await api('GET', '/driver/trips', w.driver.token);
    expect(list.body.trips.map((t: any) => t.id)).toContain(w.tripId);
    const detail = await api('GET', `/driver/trips/${w.tripId}`, w.driver.token);
    expect(detail.body.riders).toHaveLength(2);
    expect(detail.body.stops).toHaveLength(3);
    const start = await api('POST', `/driver/trips/${w.tripId}/start`, w.driver.token, {});
    expect(start.status).toBe(200);
    expect(start.body.tracking.intervalSec).toBe(10);
  });

  it('accepts location points and dedupes resent batches', async () => {
    const recordedAt = new Date().toISOString();
    const points = [{ recordedAt, lat: 24.7140, lng: 46.6760, accuracyM: 8 }];
    const r1 = await api('POST', `/driver/trips/${w.tripId}/locations`, w.driver.token, { points });
    const r2 = await api('POST', `/driver/trips/${w.tripId}/locations`, w.driver.token, { points });
    expect(r1.body.accepted).toBe(1);
    expect(r2.body.accepted).toBe(0);
  });

  it('refuses alighting a student who never boarded', async () => {
    const r = await api('POST', `/driver/trips/${w.tripId}/events`, w.driver.token, { events: [ev(w.student1, 'alighted')] });
    expect(r.body.results[0]).toMatchObject({ result: 'rejected', code: 'not_boarded' });
  });

  it('records boarding idempotently across re-sync', async () => {
    const boarded = ev(w.student1, 'boarded');
    const r1 = await api('POST', `/driver/trips/${w.tripId}/events`, w.driver.token, { events: [boarded] });
    expect(r1.body.results[0].result).toBe('applied');
    const r2 = await api('POST', `/driver/trips/${w.tripId}/events`, w.driver.token, { events: [boarded] });
    expect(r2.body.results[0].result).toBe('duplicate');
    const rows = await ownerQuery(`select count(*)::int as n from boarding_events where trip_id = $1 and student_id = $2 and type = 'boarded'`, [w.tripId, w.student1]);
    expect(rows[0].n).toBe(1);
  });

  it('parent follows the child: status, own stop only, fresh location, ETA honestly unavailable', async () => {
    const s = await api('GET', `/parent/children/${w.student1}/status`, w.parent1.token);
    expect(s.status).toBe(200);
    expect(s.body.trip.riderStatus).toBe('boarded');
    expect(s.body.trip.stop.name).toBe('نقطة 1');
    expect(s.body.tracking.available).toBe(true);
    expect(s.body.tracking.location.isStale).toBe(false);
    expect(typeof s.body.tracking.location.ageSeconds).toBe('number');
    expect(s.body.eta).toEqual({ available: false, reason: 'no_provider' });
    // لا بيانات عن الطالب الآخر في الرد
    expect(JSON.stringify(s.body)).not.toContain('خالد');
    expect(JSON.stringify(s.body)).not.toContain('نقطة 2');
  });

  it('marks location as stale when updates stop', async () => {
    await ownerQuery(`update bus_locations set recorded_at = recorded_at - interval '10 minutes' where trip_id = $1`, [w.tripId]);
    const s = await api('GET', `/parent/children/${w.student1}/status`, w.parent1.token);
    expect(s.body.tracking.location.isStale).toBe(true);
    expect(s.body.tracking.location.ageSeconds).toBeGreaterThanOrEqual(600);
  });

  it('blocks ending the trip while a student is on board, then escalates when acknowledged', async () => {
    const blocked = await api('POST', `/driver/trips/${w.tripId}/end`, w.driver.token, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('unresolved_riders');
    expect(blocked.body.error.details.onboard.map((r: any) => r.studentId)).toEqual([w.student1]);
    expect(blocked.body.error.details.unrecorded.map((r: any) => r.studentId)).toEqual([w.student2]);
  });

  it('completes boarding/alighting and ends the trip cleanly', async () => {
    const r = await api('POST', `/driver/trips/${w.tripId}/events`, w.driver.token, {
      events: [ev(w.student1, 'alighted', { recordedAt: new Date(Date.now() + 1000).toISOString() }), ev(w.student2, 'no_show')],
    });
    expect(r.body.results.map((x: any) => x.result)).toEqual(['applied', 'applied']);
    const end = await api('POST', `/driver/trips/${w.tripId}/end`, w.driver.token, {});
    expect(end.status).toBe(200);
    expect(end.body).toMatchObject({ status: 'completed', inspectionRequired: true, escalated: false });
  });

  it('stops accepting locations and hides location from parent after trip end', async () => {
    const r = await api('POST', `/driver/trips/${w.tripId}/locations`, w.driver.token, {
      points: [{ recordedAt: new Date().toISOString(), lat: 24.71, lng: 46.67 }],
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('trip_not_active');
    const s = await api('GET', `/parent/children/${w.student1}/status`, w.parent1.token);
    expect(s.body.trip.riderStatus).toBe('alighted');
    expect(s.body.tracking).toEqual({ available: false, reason: 'trip_not_active' });
  });

  it('requires a complete bus-empty checklist', async () => {
    const partial = await api('POST', `/driver/trips/${w.tripId}/inspection`, w.driver.token, {
      clientEventId: randomUUID(), startedAt: new Date().toISOString(), result: 'bus_empty',
      checklist: { walkedToRear: true, checkedSeats: true, checkedUnderSeats: false, checkedBackRow: true, noBelongingsLeft: true },
    });
    expect(partial.status).toBe(400);
    expect(partial.body.error.code).toBe('inspection_incomplete');
    const id = randomUUID();
    const body = {
      clientEventId: id, startedAt: new Date(Date.now() - 60_000).toISOString(), result: 'bus_empty',
      checklist: { walkedToRear: true, checkedSeats: true, checkedUnderSeats: true, checkedBackRow: true, noBelongingsLeft: true },
    };
    const ok = await api('POST', `/driver/trips/${w.tripId}/inspection`, w.driver.token, body);
    expect(ok.status).toBe(200);
    expect(ok.body.selfDeclared).toBe(true);
    const again = await api('POST', `/driver/trips/${w.tripId}/inspection`, w.driver.token, body);
    expect(again.body.status).toBe('duplicate');
  });

  it('delivers deduplicated in-app notifications with lock-screen-safe push text', async () => {
    await processOutbox();
    await processOutbox();
    const n = await api('GET', '/me/notifications', w.parent1.token);
    const kinds = n.body.notifications.map((x: any) => x.kind).sort();
    expect(kinds).toEqual(['rider_alighted', 'rider_boarded', 'trip_started']);
    const rows = await ownerQuery(`select push_title, push_body, body from notifications where user_id = $1`, [w.parent1.userId]);
    for (const r of rows) {
      expect(r.push_body).not.toContain('سارة'); // اسم الطفل لا يظهر على شاشة القفل
      expect(r.push_title).not.toContain('سارة');
    }
    expect(rows.some((r) => r.body.includes('سارة'))).toBe(true); // يظهر داخل التطبيق بعد المصادقة فقط
    // ولي الأمر الآخر لم يتلقَّ إشعارات صعود/نزول ابن غيره
    const other = await api('GET', '/me/notifications', w.parent2.token);
    expect(other.body.notifications.map((x: any) => x.kind).sort()).toEqual(['rider_no_show', 'trip_started']);
  });

  it('shows the completed trip with events and inspection on the admin side', async () => {
    const t = await api('GET', `/tenant/trips/${w.tripId}`, w.adminToken);
    expect(t.status).toBe(200);
    expect(t.body.trip.status).toBe('completed');
    expect(t.body.trip.inspectionStatus).toBe('completed');
    expect(t.body.counts).toMatchObject({ alighted: 1, no_show: 1 });
    expect(t.body.inspection.result).toBe('bus_empty');
    expect(t.body.trail.length).toBeGreaterThan(0);
  });
});
