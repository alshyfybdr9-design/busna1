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
import { etaProvider, haversineM } from '../integrations/routing.js';

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
  ticket: { title: 'باصنا — الدعم', body: 'يوجد تحديث على تذكرة دعم. افتح التطبيق للتفاصيل.' },
  broadcast: { title: 'باصنا', body: 'رسالة جديدة من إدارة النقل. افتح التطبيق للتفاصيل.' },
  approach: { title: 'باصنا', body: 'الباص يقترب من نقطة التوقف.' },
  request: { title: 'باصنا', body: 'تم تحديث طلبك. افتح التطبيق للتفاصيل.' },
};
type Audience = keyof typeof PUSH_GENERIC;

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

const CATEGORY_AR: Record<string, string> = {
  delay: 'تأخير', breakdown: 'عطل باص', route_change: 'تغيير مسار', weather: 'ظروف جوية', early_dismissal: 'خروج مبكر', general: 'إعلان',
};

async function buildNotes(c: Db, ev: { tenant_id: string; kind: string; payload: any; id: number }): Promise<{ notes: Note[]; audience: Audience; platform?: boolean }> {
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
      const be = p.eventId ? await one(c, `select handover_to from boarding_events where id = $1`, [p.eventId]) : null;
      const handover = status === 'alighted' && be?.handover_to ? ` وتم تسليمه إلى: ${be.handover_to}` : '';
      return {
        audience: 'parent',
        notes: gs.map((g) => ({
          userId: g.user_id,
          kind: `rider_${status}`,
          title: p.type === 'correction' ? 'تصحيح حالة الرحلة' : 'تحديث الرحلة',
          body: `${firstName(g.full_name)} ${text[status]}${handover}.`,
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
        no_receiver: 'لا يوجد مستلم مصرّح له — الطالب باقٍ في الباص',
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
    case 'ticket_event': {
      const t = await one(c, `select id, ref, queue, subject, status, requester_user_id, assigned_to from support_tickets where id = $1`, [p.ticketId]);
      if (!t) return { notes: [], audience: 'ticket' };
      const STATUS: Record<string, string> = { open: 'مفتوحة', in_progress: 'قيد المعالجة', waiting_user: 'بانتظار ردك', resolved: 'تم الحل', closed: 'مغلقة' };
      const data = { ticketId: t.id as string };
      if (p.event === 'agent_reply' || p.event === 'status') {
        return {
          audience: 'ticket',
          notes: [{
            userId: t.requester_user_id, kind: 'ticket_update',
            title: `تذكرة #${t.ref}`,
            body: p.event === 'status' ? `تغيّرت حالة تذكرتك إلى: ${STATUS[p.status] ?? p.status}.` : 'يوجد رد جديد من فريق الدعم على تذكرتك.',
            dedupeKey: `ticket:${t.id}:${p.event}:${ev.id}`, data,
          }],
        };
      }
      // تذكرة جديدة أو رد من صاحبها ← فريق الطابور المسؤول (الجهة أو المنصة)
      const agents = t.queue === 'platform'
        ? await many<{ user_id: string }>(c, `select id as user_id from users where platform_role is not null and status = 'active'`)
        : t.assigned_to && p.event === 'requester_reply' ? [{ user_id: t.assigned_to }] : await staffOf(c, ev.tenant_id);
      return {
        audience: 'ticket',
        platform: t.queue === 'platform',
        notes: agents.map((a) => ({
          userId: a.user_id, kind: 'ticket_queue',
          title: p.event === 'created' ? `تذكرة دعم جديدة #${t.ref}` : `رد جديد على التذكرة #${t.ref}`,
          body: String(t.subject).slice(0, 140),
          dedupeKey: `ticketq:${t.id}:${p.event}:${ev.id}`, data,
        })),
      };
    }
    case 'support_access': {
      const g = await one(c, `select g.id, g.reason, g.expires_at, round(extract(epoch from g.expires_at - g.created_at) / 60) as minutes from platform_access_grants g where g.id = $1`, [p.grantId]);
      if (!g) return { notes: [], audience: 'staff' };
      const admins = await many<{ user_id: string }>(c, `select user_id from memberships where tenant_id = $1 and role = 'tenant_admin' and status = 'active'`, [ev.tenant_id]);
      return {
        audience: 'staff',
        notes: admins.map((a) => ({
          userId: a.user_id, kind: 'support_access',
          title: 'وصول مؤقت من دعم منصة باصنا',
          body: `فتح فريق دعم باصنا وصولًا للقراءة فقط لمدة ${g.minutes} دقيقة. السبب: ${String(g.reason).slice(0, 200)}. يمكنك إنهاؤه من الإعدادات.`,
          dedupeKey: `support_access:${g.id}`, data: { grantId: g.id },
        })),
      };
    }
    case 'broadcast': {
      const b = await one(c, `select id, audience, route_ids, trip_ids, category, title, body, delay_minutes from broadcasts where id = $1`, [p.broadcastId]);
      if (!b) return { notes: [], audience: 'broadcast' };
      let users: Array<{ user_id: string }> = [];
      const parentsSql = `select distinct gs.guardian_user_id as user_id from guardian_students gs
        join memberships m on m.user_id = gs.guardian_user_id and m.tenant_id = gs.tenant_id and m.role = 'parent' and m.status = 'active'
        where gs.tenant_id = $1 and gs.student_id in `;
      if (b.audience === 'all_parents' || b.audience === 'everyone') {
        users = await many(c, `select distinct user_id from memberships where tenant_id = $1 and role = 'parent' and status = 'active'`, [ev.tenant_id]);
      } else if (b.audience === 'routes') {
        users = await many(
          c,
          parentsSql + `(select rr.student_id from route_riders rr where rr.route_id = any($2::uuid[])
                         union select tr.student_id from trip_riders tr join trips t on t.id = tr.trip_id
                           where t.route_id = any($2::uuid[]) and t.service_date >= current_date - 1 and t.status in ('scheduled', 'in_progress')
                         union select o.student_id from rider_overrides o where o.route_id = any($2::uuid[]) and o.status = 'active' and o.end_date >= current_date)`,
          [ev.tenant_id, b.route_ids],
        );
      } else if (b.audience === 'trips') {
        users = await many(c, parentsSql + `(select tr.student_id from trip_riders tr where tr.trip_id = any($2::uuid[]) and tr.status <> 'absent')`, [ev.tenant_id, b.trip_ids]);
      }
      if (b.audience === 'drivers' || b.audience === 'everyone') {
        users = [...users, ...(await many(c, `select distinct user_id from memberships where tenant_id = $1 and role in ('driver', 'attendant') and status = 'active'`, [ev.tenant_id]))];
      }
      const ids = [...new Set(users.map((u) => u.user_id))];
      await c.query(`update broadcasts set recipient_count = $2 where id = $1`, [b.id, ids.length]);
      const prefix = b.category !== 'general' ? `${CATEGORY_AR[b.category]}: ` : '';
      return {
        audience: 'broadcast',
        notes: ids.map((u) => ({
          userId: u, kind: 'broadcast',
          title: `${prefix}${b.title}`.slice(0, 160),
          body: b.delay_minutes ? `${b.body}\n(التأخير المتوقع: نحو ${b.delay_minutes} دقيقة)` : b.body,
          dedupeKey: `broadcast:${b.id}`, data: { broadcastId: b.id },
        })),
      };
    }
    case 'bus_approaching': {
      const gs = (await guardiansOf(c, ev.tenant_id, [p.studentId])).filter((g) => g.user_id === p.guardianUserId);
      const mins = p.etaSec ? Math.max(1, Math.round(p.etaSec / 60)) : null;
      const dist = p.distanceM >= 1000 ? `${(p.distanceM / 1000).toFixed(1)} كم` : `${Math.max(50, Math.round(p.distanceM / 50) * 50)} م`;
      return {
        audience: 'approach',
        notes: gs.map((g) => ({
          userId: g.user_id, kind: 'bus_approaching',
          title: p.direction === 'from_school' ? 'الباص يقترب من المنزل' : 'الباص يقترب من نقطة الصعود',
          body: `باص ${firstName(g.full_name)} على بعد نحو ${dist} من ${p.stopName}${mins ? ` — الوصول خلال ${mins} دقيقة تقريبًا (تقديري)` : ''}.`,
          dedupeKey: `approach:${p.tripId}:${p.studentId}`,
          data: { tripId: p.tripId, studentId: p.studentId },
        })),
      };
    }
    case 'no_receiver': {
      const gs = await guardiansOf(c, ev.tenant_id, [p.studentId]);
      return {
        audience: 'parent',
        notes: gs.map((g) => ({
          userId: g.user_id, kind: 'no_receiver',
          title: 'لم يكن هناك مستلم عند نقطة النزول',
          body: `لم يجد السائق مستلمًا مصرّحًا له لـ${firstName(g.full_name)}، لذلك بقي في الباص بأمان. ستتواصل معكم إدارة النقل.`,
          dedupeKey: `no_receiver:${p.tripId}:${p.studentId}`,
          data: { tripId: p.tripId, studentId: p.studentId },
        })),
      };
    }
    case 'stop_change_updated': {
      const r = await one(c, `select id, status, requested_by, review_note from stop_change_requests where id = $1`, [p.requestId]);
      if (!r || !['approved', 'rejected'].includes(r.status)) return { notes: [], audience: 'request' };
      const title = r.status === 'approved' ? 'تم اعتماد طلب تغيير العنوان' : 'تم رفض طلب تغيير العنوان';
      return {
        audience: 'request',
        notes: [{ userId: r.requested_by, kind: 'stop_change_updated', title, body: r.review_note ? `${title}. ملاحظة الإدارة: ${r.review_note}` : `${title}.`,
          dedupeKey: `stop_change:${r.id}:${r.status}`, data: { requestId: r.id } }],
      };
    }
    default:
      return { notes: [], audience: 'parent' };
  }
}

/**
 * تنبيه «الباص اقترب»: لكل رحلة جارية بموقع حديث، يُقارن موقع الباص بنقطة توقف كل طالب
 * (الذهاب: من لم يصعد بعد. العودة: من في الباص). يُرسل مرة واحدة لكل طالب في الرحلة.
 */
export async function runApproachChecks(): Promise<number> {
  return withWorkerDb(async (c) => {
    const rows = await many(
      c,
      `with lastloc as (
         select distinct on (bl.trip_id) bl.trip_id, bl.lat, bl.lng, bl.recorded_at
         from bus_locations bl join trips t on t.id = bl.trip_id
         where t.status = 'in_progress' and bl.recorded_at > now() - interval '2 minutes'
         order by bl.trip_id, bl.recorded_at desc)
       select t.id as trip_id, t.tenant_id, t.direction, tr.student_id, gs.guardian_user_id, st.name as stop_name,
              st.lat as stop_lat, st.lng as stop_lng, l.lat, l.lng, extract(epoch from now() - l.recorded_at)::int as age,
              p.student_id is not null as has_pref, p.approach_meters, tn.settings
       from lastloc l join trips t on t.id = l.trip_id join tenants tn on tn.id = t.tenant_id
       join trip_riders tr on tr.trip_id = t.id
         and ((t.direction = 'to_school' and tr.status = 'expected') or (t.direction = 'from_school' and tr.status = 'boarded'))
       join route_stops st on st.id = tr.stop_id and st.kind = 'stop'
       join guardian_students gs on gs.student_id = tr.student_id and gs.tenant_id = t.tenant_id
       join memberships m on m.user_id = gs.guardian_user_id and m.tenant_id = t.tenant_id and m.role = 'parent' and m.status = 'active'
       left join guardian_alert_prefs p on p.student_id = tr.student_id and p.guardian_user_id = gs.guardian_user_id
       where not exists (select 1 from notifications n where n.user_id = gs.guardian_user_id
                         and n.dedupe_key = 'approach:' || t.id || ':' || tr.student_id)`,
    );
    let n = 0;
    for (const r of rows) {
      const threshold = r.has_pref ? r.approach_meters : tenantSettings(r.settings).approachAlertDefaultM;
      if (!threshold) continue;
      const bus = { lat: r.lat, lng: r.lng };
      const stop = { lat: r.stop_lat, lng: r.stop_lng };
      const distanceM = haversineM(bus, stop);
      if (distanceM > threshold) continue;
      const eta = await etaProvider().estimate({ from: bus, to: stop, locationAgeSec: r.age, staleAfterSec: tenantSettings(r.settings).staleAfterSec });
      await c.query(`insert into outbox_events (tenant_id, kind, payload) values ($1, 'bus_approaching', $2)`, [
        r.tenant_id,
        JSON.stringify({ tripId: r.trip_id, studentId: r.student_id, guardianUserId: r.guardian_user_id, direction: r.direction,
          stopName: r.stop_name, distanceM: Math.round(distanceM), etaSec: eta.available ? eta.seconds : null }),
      ]);
      n++;
    }
    return n;
  });
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
        const { notes, audience, platform } = await buildNotes(c, ev);
        for (const n of notes) {
          const generic = PUSH_GENERIC[audience];
          const row = await one(
            c,
            `insert into notifications (tenant_id, user_id, kind, title, body, push_title, push_body, data, dedupe_key, push_status)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             on conflict (user_id, dedupe_key) do nothing returning id`,
            [platform ? null : ev.tenant_id, n.userId, n.kind, n.title, n.body, generic.title, generic.body, JSON.stringify(n.data ?? {}), n.dedupeKey,
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
export async function runRetention(): Promise<{ locationsDeleted: number; notificationsDeleted: number; conversationsDeleted: number }> {
  return withWorkerDb(async (c) => {
    const tenants = await many(c, `select id, settings from tenants`);
    let locationsDeleted = 0;
    for (const t of tenants) {
      const days = tenantSettings(t.settings).locationRetentionDays;
      const r = await c.query(`delete from bus_locations where tenant_id = $1 and recorded_at < now() - make_interval(days => $2)`, [t.id, days]);
      locationsDeleted += r.rowCount ?? 0;
    }
    const n = await c.query(`delete from notifications where created_at < now() - interval '180 days'`);
    // محادثات المساعد: تُحذف بعد مدة الجهة (افتراضي 30 يومًا)؛ سجل الأدوات (بيانات وصفية فقط) سنة
    let conversationsDeleted = 0;
    for (const t of tenants) {
      const days = tenantSettings(t.settings).assistantRetentionDays;
      const r = await c.query(`delete from assistant_conversations where tenant_id = $1 and last_message_at < now() - make_interval(days => $2)`, [t.id, days]);
      conversationsDeleted += r.rowCount ?? 0;
    }
    await c.query(`update assistant_actions set status = 'expired', decided_at = now() where status = 'pending' and expires_at < now()`);
    await c.query(`delete from assistant_tool_log where created_at < now() - interval '365 days'`);
    await c.query(`insert into audit_logs (action, entity, details) values ('retention.run', 'system', $1)`, [
      JSON.stringify({ locationsDeleted, notificationsDeleted: n.rowCount ?? 0, conversationsDeleted }),
    ]);
    return { locationsDeleted, notificationsDeleted: n.rowCount ?? 0, conversationsDeleted };
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
      if (ticks % 5 === 0) await runApproachChecks();
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
