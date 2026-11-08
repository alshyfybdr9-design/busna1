/**
 * العامل الخلفي:
 *  1) يعالج outbox_events ويحوّلها إلى إشعارات داخل التطبيق (+ إشعارات جوال إن أُعدّت)
 *     مع منع التكرار عبر dedupe_key فريد لكل مستخدم.
 *  2) فحوصات السلامة الدورية: فحص الباص المتأخر، وانقطاع الموقع أثناء رحلة جارية.
 *  3) سياسة الاحتفاظ: حذف إحداثيات الباص الأقدم من مدة الجهة.
 */
import { withWorkerDb, many, one, type Db } from '../db/pool.js';
import { pushProvider } from '../integrations/push.js';
import { tenantSettings } from '../config.js';
import { firstName } from '../lib/util.js';

interface Note {
  userId: string;
  kind: string;
  title: string;
  body: string;
  dedupeKey: string;
  data?: Record<string, string>;
}

// نص شاشة القفل ثابت وعام عمدًا
const PUSH_GENERIC = {
  parent: { title: 'باصنا', body: 'يوجد تحديث جديد على رحلة النقل. افتح التطبيق للتفاصيل.' },
  staff: { title: 'باصنا — تنبيه تشغيل', body: 'يوجد تنبيه تشغيلي يحتاج المتابعة. افتح التطبيق.' },
  absence: { title: 'باصنا', body: 'تم تحديث طلب الغياب. افتح التطبيق للتفاصيل.' },
};

const DIRECTION_AR: Record<string, string> = { to_school: 'الذهاب', from_school: 'العودة' };

async function guardiansOf(c: Db, tenantId: string, studentIds: string[]) {
  return many<{ user_id: string; student_id: string; full_name: string }>(
    c,
    `select gs.guardian_user_id as user_id, gs.student_id, s.full_name
     from guardian_students gs join students s on s.id = gs.student_id
     join memberships m on m.user_id = gs.guardian_user_id and m.tenant_id = gs.tenant_id and m.role = 'parent' and m.status = 'active'
     where gs.tenant_id = $1 and gs.student_id = any($2::uuid[])`,
    [tenantId, studentIds],
  );
}

async function staffOf(c: Db, tenantId: string) {
  return many<{ user_id: string }>(
    c,
    `select distinct user_id from memberships where tenant_id = $1 and role in ('tenant_admin', 'supervisor') and status = 'active'`,
    [tenantId],
  );
}

async function buildNotes(c: Db, ev: { tenant_id: string; kind: string; payload: any; id: number }): Promise<{ notes: Note[]; audience: 'parent' | 'staff' | 'absence' }> {
  const p = ev.payload;
  switch (ev.kind) {
    case 'trip_started':
    case 'trip_cancelled': {
      const trip = await one(c, `select id, direction from trips where id = $1`, [p.tripId]);
      if (!trip) return { notes: [], audience: 'parent' };
      const riders = await many(c, `select student_id from trip_riders where trip_id = $1 and status <> 'absent'`, [p.tripId]);
      const gs = await guardiansOf(c, ev.tenant_id, riders.map((r) => r.student_id));
      const dir = DIRECTION_AR[trip.direction] ?? '';
      return {
        audience: 'parent',
        notes: gs.map((g) => ({
          userId: g.user_id,
          kind: ev.kind,
          title: ev.kind === 'trip_started' ? `بدأت رحلة ${dir}` : `أُلغيت رحلة ${dir}`,
          body: ev.kind === 'trip_started'
            ? `بدأت رحلة ${dir} الخاصة بـ${firstName(g.full_name)}.`
            : `أُلغيت رحلة ${dir} الخاصة بـ${firstName(g.full_name)}. ${p.reason ? `السبب: ${p.reason}` : ''}`.trim(),
          dedupeKey: `${ev.kind}:${p.tripId}:${g.student_id}`,
          data: { tripId: p.tripId, studentId: g.student_id },
        })),
      };
    }
    case 'rider_event': {
      const gs = await guardiansOf(c, ev.tenant_id, [p.studentId]);
      const status = p.type === 'correction' ? p.newStatus : p.type;
      const text: Record<string, string> = {
        boarded: 'صعد إلى الباص',
        alighted: 'نزل من الباص',
        absent: 'سُجّل غائبًا عن الرحلة',
        no_show: 'لم يحضر إلى نقطة التوقف',
        expected: 'عاد إلى قائمة الرحلة',
      };
      if (!text[status]) return { notes: [], audience: 'parent' };
      return {
        audience: 'parent',
        notes: gs.map((g) => ({
          userId: g.user_id,
          kind: `rider_${status}`,
          title: p.type === 'correction' ? 'تصحيح حالة الرحلة' : 'تحديث الرحلة',
          body: `${firstName(g.full_name)} ${text[status]}.`,
          dedupeKey: p.type === 'correction' ? `correction:${p.eventId}` : `rider:${p.tripRiderId}:${status}`,
          data: { tripId: p.tripId, studentId: p.studentId },
        })),
      };
    }
    case 'safety_alert': {
      const alert = await one(c, `select id, kind, severity from safety_alerts where id = $1`, [p.alertId]);
      if (!alert) return { notes: [], audience: 'staff' };
      const titles: Record<string, string> = {
        unresolved_riders: 'طلاب لم يُسجّل نزولهم بعد انتهاء الرحلة',
        unrecorded_riders: 'طلاب بلا تسجيل حضور في رحلة منتهية',
        inspection_overdue: 'فحص خلو الباص متأخر',
        child_found: 'تم العثور على طفل داخل الباص',
        emergency: 'بلاغ طوارئ من سائق',
        issue: 'بلاغ مشكلة من سائق',
        location_lost: 'انقطاع موقع باص أثناء رحلة',
      };
      const staff = await staffOf(c, ev.tenant_id);
      return {
        audience: 'staff',
        notes: staff.map((s) => ({
          userId: s.user_id,
          kind: `alert_${alert.kind}`,
          title: titles[alert.kind] ?? 'تنبيه تشغيل',
          body: alert.severity === 'critical' ? 'تنبيه حرج — يتطلب تدخلًا فوريًا.' : 'يرجى المراجعة من لوحة التشغيل.',
          dedupeKey: `alert:${alert.id}`,
          data: { alertId: alert.id },
        })),
      };
    }
    case 'absence_updated': {
      const a = await one(c, `select id, status, requested_by from absences where id = $1`, [p.absenceId]);
      if (!a) return { notes: [], audience: 'absence' };
      const label: Record<string, string> = { approved: 'تم اعتماد طلب الغياب', rejected: 'تم رفض طلب الغياب', cancelled: 'تم إلغاء طلب الغياب' };
      if (!label[a.status]) return { notes: [], audience: 'absence' };
      return {
        audience: 'absence',
        notes: [{ userId: a.requested_by, kind: 'absence_updated', title: label[a.status], body: label[a.status] + '.', dedupeKey: `absence:${a.id}:${a.status}`, data: { absenceId: a.id } }],
      };
    }
    default:
      return { notes: [], audience: 'parent' };
  }
}

export async function processOutbox(limit = 50): Promise<number> {
  const push = pushProvider();
  const pending: Array<{ id: string; userId: string; push: { title: string; body: string } }> = [];
  const processed = await withWorkerDb(async (c) => {
    const events = await many(
      c,
      `select id, tenant_id, kind, payload from outbox_events where processed_at is null and attempts < 5
       order by id limit $1 for update skip locked`,
      [limit],
    );
    for (const ev of events) {
      try {
        await c.query('savepoint ev');
        const { notes, audience } = await buildNotes(c, ev);
        for (const n of notes) {
          const generic = PUSH_GENERIC[audience];
          const row = await one(
            c,
            `insert into notifications (tenant_id, user_id, kind, title, body, push_title, push_body, data, dedupe_key, push_status)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             on conflict (user_id, dedupe_key) do nothing returning id`,
            [ev.tenant_id, n.userId, n.kind, n.title, n.body, generic.title, generic.body, JSON.stringify(n.data ?? {}), n.dedupeKey,
              push.configured ? 'pending' : 'skipped'],
          );
          if (row && push.configured) pending.push({ id: row.id, userId: n.userId, push: generic });
        }
        await c.query(`update outbox_events set processed_at = now(), attempts = attempts + 1 where id = $1`, [ev.id]);
        await c.query('release savepoint ev');
      } catch (e) {
        await c.query('rollback to savepoint ev');
        await c.query(`update outbox_events set attempts = attempts + 1, last_error = $2 where id = $1`, [ev.id, (e as Error).message.slice(0, 500)]);
      }
    }
    return events.length;
  });
  if (pending.length) await sendPushes(pending);
  return processed;
}

async function sendPushes(items: Array<{ id: string; userId: string; push: { title: string; body: string } }>) {
  const push = pushProvider();
  await withWorkerDb(async (c) => {
    const tokens = await many<{ user_id: string; token: string }>(
      c,
      `select user_id, token from push_tokens where user_id = any($1::uuid[])`,
      [[...new Set(items.map((i) => i.userId))]],
    );
    const messages = items.flatMap((i) =>
      tokens.filter((t) => t.user_id === i.userId).map((t) => ({ to: t.token, title: i.push.title, body: i.push.body, data: { notificationId: i.id } })),
    );
    const results = messages.length ? await push.send(messages) : [];
    const invalid = results.filter((r) => r.invalidToken).map((r) => r.token);
    if (invalid.length) await c.query(`delete from push_tokens where token = any($1)`, [invalid]);
    for (const i of items) {
      const mine = messages.filter((m) => m.data.notificationId === i.id);
      const ok = mine.some((m) => results.find((r) => r.token === m.to)?.ok);
      await c.query(`update notifications set push_status = $2 where id = $1`, [i.id, mine.length === 0 ? 'skipped' : ok ? 'sent' : 'failed']);
    }
  });
}

/** تنبيهات سلامة دورية: فحص متأخر + انقطاع موقع */
export async function runSafetyChecks(): Promise<number> {
  return withWorkerDb(async (c) => {
    let created = 0;
    const overdue = await many(
      c,
      `select t.id, t.tenant_id from trips t join tenants tn on tn.id = t.tenant_id
       where t.status = 'completed' and t.inspection_status = 'pending'
         and t.ended_at < now() - make_interval(mins => coalesce((tn.settings->>'inspectionDeadlineMin')::int, 10))`,
    );
    for (const t of overdue) {
      const a = await one(
        c,
        `insert into safety_alerts (tenant_id, trip_id, kind, severity, dedupe_key) values ($1, $2, 'inspection_overdue', 'high', $3)
         on conflict (tenant_id, dedupe_key) do nothing returning id`,
        [t.tenant_id, t.id, `inspection_overdue:${t.id}`],
      );
      if (a) {
        created++;
        await c.query(`insert into outbox_events (tenant_id, kind, payload) values ($1, 'safety_alert', $2)`, [t.tenant_id, JSON.stringify({ alertId: a.id })]);
      }
    }
    const lost = await many(
      c,
      `select t.id, t.tenant_id from trips t join tenants tn on tn.id = t.tenant_id
       where t.status = 'in_progress'
         and coalesce(t.last_location_at, t.started_at) < now() - make_interval(mins => coalesce((tn.settings->>'locationLostAfterMin')::int, 5))`,
    );
    for (const t of lost) {
      const a = await one(
        c,
        `insert into safety_alerts (tenant_id, trip_id, kind, severity, dedupe_key) values ($1, $2, 'location_lost', 'medium', $3)
         on conflict (tenant_id, dedupe_key) do nothing returning id`,
        [t.tenant_id, t.id, `location_lost:${t.id}`],
      );
      if (a) {
        created++;
        await c.query(`insert into outbox_events (tenant_id, kind, payload) values ($1, 'safety_alert', $2)`, [t.tenant_id, JSON.stringify({ alertId: a.id })]);
      }
    }
    return created;
  });
}

/** سياسة الاحتفاظ: الإحداثيات لا تُخزن لمدة غير محدودة */
export async function runRetention(): Promise<{ locationsDeleted: number; notificationsDeleted: number }> {
  return withWorkerDb(async (c) => {
    const tenants = await many(c, `select id, settings from tenants`);
    let locationsDeleted = 0;
    for (const t of tenants) {
      const days = tenantSettings(t.settings).locationRetentionDays;
      const r = await c.query(`delete from bus_locations where tenant_id = $1 and recorded_at < now() - make_interval(days => $2)`, [t.id, days]);
      locationsDeleted += r.rowCount ?? 0;
    }
    const n = await c.query(`delete from notifications where created_at < now() - interval '180 days'`);
    await c.query(`insert into audit_logs (action, entity, details) values ('retention.run', 'system', $1)`, [
      JSON.stringify({ locationsDeleted, notificationsDeleted: n.rowCount ?? 0 }),
    ]);
    return { locationsDeleted, notificationsDeleted: n.rowCount ?? 0 };
  });
}

export const workerStatus = { lastRunAt: null as Date | null, lastError: null as string | null };

export function startWorker(log: { error: (o: unknown, m?: string) => void }) {
  let busy = false;
  let ticks = 0;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await processOutbox();
      if (ticks % 30 === 0) await runSafetyChecks();
      if (ticks % 1800 === 0) await runRetention();
      workerStatus.lastRunAt = new Date();
      workerStatus.lastError = null;
    } catch (e) {
      workerStatus.lastError = (e as Error).message;
      log.error(e, 'worker tick failed');
    } finally {
      ticks++;
      busy = false;
    }
  };
  const handle = setInterval(tick, 2000);
  return () => clearInterval(handle);
}
