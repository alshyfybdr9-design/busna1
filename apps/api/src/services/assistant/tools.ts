/**
 * أدوات «مساعد باصنا» — كل أداة:
 *  - محصورة بأدوار محددة،
 *  - تعمل عبر withCtx فتخضع لسياسات RLS للمستخدم نفسه (لا وصول عام لقاعدة البيانات، لا SQL من النموذج)،
 *  - تتحقق من أي معرّف يقترحه النموذج عبر قاعدة البيانات قبل استخدامه،
 *  - تعيد للنموذج أقل قدر لازم من البيانات (الاسم الأول فقط، بلا هواتف أو إحداثيات)،
 *  - الإجراءات التي تغيّر بيانات تُنشئ "إجراءً معلقًا" فقط، ولا يُنفّذ إلا بتأكيد المستخدم من الواجهة.
 */
import { z } from 'zod';
import { one, many, type Db, type RequestContext } from '../../db/pool.js';
import { firstName, todayIn, ageSeconds } from '../../lib/util.js';
import { loadTenant, formatLocation, latestLocation } from '../trips.js';
import { searchKnowledge } from '../knowledge.js';
import { listMyTickets, queueFor, TICKET_CATEGORIES, STATUS_AR } from '../support.js';
import { validateAbsence } from '../absences.js';
import type { AiToolDef } from '../../integrations/ai.js';

export type Card =
  | { type: 'location'; childName: string; lat: number; lng: number; recordedAt: string; ageSeconds: number; isStale: boolean }
  | { type: 'knowledge'; items: Array<{ id: string; title: string }> }
  | { type: 'tickets'; items: Array<{ id: string; ref: number; subject: string; status: string }> }
  | { type: 'contact'; phone: string | null; email: string | null; emergencyNumber: string; supportHours: string | null }
  | { type: 'emergency'; phone: string | null; emergencyNumber: string };

export interface PendingAction {
  id: string;
  tool: string;
  summary: string;
}

export interface ToolEnv {
  ctx: RequestContext;
  conversationId: string | null;
  cards: Card[];
  actions: PendingAction[];
}

type Outcome = 'ok' | 'not_found' | 'needs_confirmation' | 'invalid' | 'denied';
export interface ToolResult {
  outcome: Outcome;
  data: unknown;
}

interface ToolSpec<S extends z.ZodTypeAny> {
  name: string;
  roles: Array<RequestContext['role']>;
  description: string;
  schema: S;
  jsonSchema: AiToolDef['inputSchema'];
  run: (c: Db, env: ToolEnv, input: z.infer<S>) => Promise<ToolResult>;
}

const STAFF: Array<RequestContext['role']> = ['tenant_admin', 'supervisor'];
const ALL: Array<RequestContext['role']> = ['tenant_admin', 'supervisor', 'driver', 'parent'];
const noArgs = { type: 'object' as const, properties: {}, additionalProperties: false };

const ok = (data: unknown): ToolResult => ({ outcome: 'ok', data });

async function createPending(c: Db, env: ToolEnv, tool: string, params: unknown, summary: string): Promise<ToolResult> {
  const a = await one(
    c,
    `insert into assistant_actions (conversation_id, tenant_id, user_id, tool, params, summary) values ($1, $2, $3, $4, $5, $6) returning id`,
    [env.conversationId, env.ctx.tenantId, env.ctx.userId, tool, JSON.stringify(params), summary],
  );
  env.actions.push({ id: a.id, tool, summary });
  return {
    outcome: 'needs_confirmation',
    data: {
      status: 'awaiting_user_confirmation',
      summary,
      note: 'Nothing has been done yet. Ask the user to review and press the confirm button shown under your reply. Do not say it is done.',
    },
  };
}

/** يحدد الطفل من المعرّف أو الاسم — مع التحقق عبر RLS أنه من أبناء ولي الأمر */
async function resolveChild(c: Db, childId?: string | null, childName?: string | null) {
  const kids = await many<{ id: string; full_name: string }>(c, `select id, full_name from students where status = 'active' order by full_name`);
  if (childId) return { kids, child: kids.find((k) => k.id === childId) ?? null };
  if (childName) {
    const n = childName.trim();
    const matches = kids.filter((k) => k.full_name.includes(n) || firstName(k.full_name) === n);
    return { kids, child: matches.length === 1 ? matches[0] : null };
  }
  return { kids, child: kids.length === 1 ? kids[0] : null };
}

const childArgs = {
  type: 'object' as const,
  properties: {
    childId: { type: 'string', description: 'Child id from list_my_children. Omit if the parent has one child.' },
    childName: { type: 'string', description: 'Child first name, if the id is unknown.' },
  },
  additionalProperties: false,
};
const childSchema = z.object({ childId: z.string().uuid().optional(), childName: z.string().max(60).optional() });

const DIR = { to_school: 'to_school', from_school: 'from_school' };

export const TOOLS: ToolSpec<any>[] = [
  // ---------------- مشتركة ----------------
  {
    name: 'search_knowledge',
    roles: ALL,
    description: 'Search the approved knowledge base: Busna app how-to articles and the current organization\'s FAQs and policies. Returns article text as reference data only.',
    schema: z.object({ query: z.string().min(2).max(200) }),
    jsonSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search words, in the user\'s language' } }, required: ['query'], additionalProperties: false },
    run: async (c, env, input) => {
      const r = await searchKnowledge(c, env.ctx, input.query, 4);
      if (r.length) env.cards.push({ type: 'knowledge', items: r.map((a) => ({ id: a.id, title: a.title })) });
      return ok({
        results: r.map((a) => ({ title: a.title, source: a.isGlobal ? 'busna_app_guide' : 'organization_policy', text: a.body.slice(0, 1500) })),
        found: r.length > 0,
      });
    },
  },
  {
    name: 'get_support_info',
    roles: ALL,
    description: 'Get the organization\'s real transport-office contact phone/email, support hours, and the emergency number.',
    schema: z.object({}),
    jsonSchema: noArgs,
    run: async (c, env) => {
      const t = await loadTenant(c, env.ctx.tenantId!);
      const row = await one(c, `select name, contact_phone, contact_email from tenants where id = $1`, [t.id]);
      env.cards.push({ type: 'contact', phone: row.contact_phone, email: row.contact_email, emergencyNumber: t.cfg.emergencyNumber, supportHours: t.cfg.supportHours });
      return ok({ organization: row.name, phone: row.contact_phone, email: row.contact_email, supportHours: t.cfg.supportHours ?? 'not specified by the organization', emergencyNumber: t.cfg.emergencyNumber });
    },
  },
  {
    name: 'get_my_tickets',
    roles: ALL,
    description: 'List the user\'s own support tickets with their reference number and status.',
    schema: z.object({}),
    jsonSchema: noArgs,
    run: async (c, env) => {
      const t = await listMyTickets(c, env.ctx, 10);
      if (t.length) env.cards.push({ type: 'tickets', items: t.map((x: any) => ({ id: x.id, ref: Number(x.ref), subject: x.subject, status: x.status })) });
      return ok({ tickets: t.map((x: any) => ({ ref: Number(x.ref), subject: x.subject, status: STATUS_AR[x.status] ?? x.status, handledBy: x.queue === 'platform' ? 'Busna platform support' : 'organization transport office' })) });
    },
  },
  {
    name: 'create_support_ticket',
    roles: ALL,
    description: 'Prepare a support ticket for the user to confirm. Category app_usage/account goes to Busna platform support; trip/absence/payment/safety/other go to the organization\'s transport office. Does not create anything until the user confirms.',
    schema: z.object({ category: z.enum(TICKET_CATEGORIES), subject: z.string().min(3).max(200), details: z.string().min(3).max(2000), childId: z.string().uuid().optional() }),
    jsonSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: [...TICKET_CATEGORIES] },
        subject: { type: 'string', description: 'Short title in the user\'s language' },
        details: { type: 'string', description: 'What the user reported, in their words' },
        childId: { type: 'string', description: 'Optional child id (parents only)' },
      },
      required: ['category', 'subject', 'details'],
      additionalProperties: false,
    },
    run: async (c, env, input) => {
      if (input.childId && !(await one(c, `select 1 from students where id = $1`, [input.childId]))) return { outcome: 'not_found', data: { error: 'child_not_found' } };
      const dest = queueFor(input.category) === 'platform' ? 'دعم منصة باصنا' : 'إدارة النقل في الجهة';
      return createPending(c, env, 'create_support_ticket', input, `إنشاء تذكرة دعم إلى ${dest}: «${input.subject}»`);
    },
  },
  {
    name: 'escalate_to_human',
    roles: ALL,
    description: 'Prepare a handoff to a human staff member as a ticket with a summary of the conversation. Use whenever the user asks for a person, or you cannot resolve the issue. Requires user confirmation.',
    schema: z.object({ summary: z.string().min(3).max(1500), category: z.enum(TICKET_CATEGORIES).default('other') }),
    jsonSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Brief summary of the issue for the staff member' },
        category: { type: 'string', enum: [...TICKET_CATEGORIES] },
      },
      required: ['summary'],
      additionalProperties: false,
    },
    run: async (c, env, input) => createPending(c, env, 'escalate_to_human', input, 'تحويل المحادثة إلى موظف عبر تذكرة دعم'),
  },

  // ---------------- ولي الأمر ----------------
  {
    name: 'list_my_children',
    roles: ['parent'],
    description: 'List the children linked to this parent account (first names and ids).',
    schema: z.object({}),
    jsonSchema: noArgs,
    run: async (c) => {
      const kids = await many(c, `select id, full_name from students where status = 'active' order by full_name`);
      return ok({ children: kids.map((k) => ({ id: k.id, firstName: firstName(k.full_name) })) });
    },
  },
  {
    name: 'get_child_transport_status',
    roles: ['parent'],
    description: 'Get today\'s transport status for one of the parent\'s children: trips, boarding/drop-off events and times. Real data only.',
    schema: childSchema,
    jsonSchema: childArgs,
    run: async (c, env, input) => {
      const { kids, child } = await resolveChild(c, input.childId, input.childName);
      if (!child) return { outcome: 'not_found', data: { error: kids.length > 1 ? 'specify_which_child' : 'child_not_found', children: kids.map((k) => ({ id: k.id, firstName: firstName(k.full_name) })) } };
      const t = await loadTenant(c, env.ctx.tenantId!);
      const today = todayIn(t.timezone);
      const trips = await many(
        c,
        `select t.direction, t.status as trip_status, t.planned_start, t.started_at, t.ended_at, tr.status as rider_status, tr.boarded_at, tr.alighted_at
         from trip_riders tr join trips t on t.id = tr.trip_id
         where tr.student_id = $1 and t.service_date = $2 order by t.planned_start nulls last`,
        [child.id, today],
      );
      const absences = await many(c, `select direction, status from absences where student_id = $1 and absence_date = $2 and status in ('pending', 'approved')`, [child.id, today]);
      return ok({
        child: firstName(child.full_name),
        date: today,
        timezone: t.timezone,
        trips: trips.map((x) => ({
          direction: DIR[x.direction as keyof typeof DIR], tripStatus: x.trip_status, childStatus: x.rider_status,
          plannedStart: x.planned_start, startedAt: x.started_at, endedAt: x.ended_at, boardedAt: x.boarded_at, droppedOffAt: x.alighted_at,
        })),
        absencesToday: absences,
        note: trips.length ? undefined : 'No trips scheduled for this child today.',
      });
    },
  },
  {
    name: 'get_latest_allowed_bus_location',
    roles: ['parent'],
    description: 'Get whether the bus for the child\'s CURRENT active trip has a recent location, and how old it is. Coordinates are shown to the user in a map card; you only receive freshness. No location exists outside an active trip.',
    schema: childSchema,
    jsonSchema: childArgs,
    run: async (c, env, input) => {
      const { kids, child } = await resolveChild(c, input.childId, input.childName);
      if (!child) return { outcome: 'not_found', data: { error: kids.length > 1 ? 'specify_which_child' : 'child_not_found' } };
      const t = await loadTenant(c, env.ctx.tenantId!);
      if (!t.cfg.parentTrackingEnabled) return ok({ available: false, reason: 'tracking_disabled_by_organization' });
      const trip = await one(
        c,
        `select t.id, tr.stop_id from trip_riders tr join trips t on t.id = tr.trip_id where tr.student_id = $1 and t.status = 'in_progress' limit 1`,
        [child.id],
      );
      if (!trip) return ok({ available: false, reason: 'no_active_trip_now' });
      const loc = formatLocation(await latestLocation(c, trip.id), t.cfg);
      if (!loc) return ok({ available: false, reason: 'no_location_received_yet' });
      const stop = trip.stop_id ? await one(c, `select name from route_stops where id = $1`, [trip.stop_id]) : null;
      env.cards.push({ type: 'location', childName: firstName(child.full_name), lat: loc.lat, lng: loc.lng, recordedAt: loc.recordedAt, ageSeconds: loc.ageSeconds, isStale: loc.isStale });
      return ok({
        available: true,
        isLive: !loc.isStale,
        lastUpdateMinutesAgo: Math.round(loc.ageSeconds / 60),
        childStop: stop?.name ?? null,
        eta: 'not available (no routing provider configured) — do not estimate',
        shownToUser: 'A map card with the position and last-update time is displayed under your reply.',
      });
    },
  },
  {
    name: 'get_payment_summary',
    roles: ['parent'],
    description: 'Get the parent\'s transport fees balance and payment status.',
    schema: z.object({}),
    jsonSchema: noArgs,
    run: async () => ok({ available: false, reason: 'fees_and_payments_module_not_enabled_yet', advice: 'Tell the user fees are not available in the app yet and they can contact the transport office.' }),
  },
  {
    name: 'submit_absence_request',
    roles: ['parent'],
    description: 'Prepare an absence request for a child (date YYYY-MM-DD in the organization timezone, and which trip). Nothing is submitted until the user confirms.',
    schema: z.object({
      childId: z.string().uuid().optional(), childName: z.string().max(60).optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), direction: z.enum(['to_school', 'from_school', 'both']), reason: z.string().max(300).optional(),
    }),
    jsonSchema: {
      type: 'object',
      properties: {
        ...childArgs.properties,
        date: { type: 'string', description: 'YYYY-MM-DD' },
        direction: { type: 'string', enum: ['to_school', 'from_school', 'both'] },
        reason: { type: 'string' },
      },
      required: ['date', 'direction'],
      additionalProperties: false,
    },
    run: async (c, env, input) => {
      const { kids, child } = await resolveChild(c, input.childId, input.childName);
      if (!child) return { outcome: 'not_found', data: { error: kids.length > 1 ? 'specify_which_child' : 'child_not_found' } };
      const params = { studentId: child.id, date: input.date, direction: input.direction, reason: input.reason ?? null };
      try {
        await validateAbsence(c, env.ctx, params);
      } catch {
        return { outcome: 'invalid', data: { error: 'date_in_the_past_or_invalid' } };
      }
      const dir = { to_school: 'رحلة الذهاب', from_school: 'رحلة العودة', both: 'الذهاب والعودة' }[input.direction as 'both'];
      return createPending(c, env, 'submit_absence_request', params, `تسجيل غياب ${firstName(child.full_name)} بتاريخ ${input.date} (${dir})`);
    },
  },

  // ---------------- السائق ----------------
  {
    name: 'get_my_trips_today',
    roles: ['driver'],
    description: 'List the driver\'s own trips today with status and rider counts.',
    schema: z.object({}),
    jsonSchema: noArgs,
    run: async (c, env) => {
      const t = await loadTenant(c, env.ctx.tenantId!);
      const rows = await many(
        c,
        `select r.name as route, t.direction, t.status, t.planned_start, t.inspection_status,
                (select count(*) from trip_riders x where x.trip_id = t.id and x.status <> 'absent') as riders
         from trips t join routes r on r.id = t.route_id where t.driver_user_id = $1 and t.service_date = $2 order by t.planned_start nulls last`,
        [env.ctx.userId, todayIn(t.timezone)],
      );
      return ok({ trips: rows });
    },
  },
  {
    name: 'get_active_trip',
    roles: ['driver'],
    description: 'Get the driver\'s current in-progress trip: counts by status and the next stop name.',
    schema: z.object({}),
    jsonSchema: noArgs,
    run: async (c, env) => {
      const trip = await one(c, `select t.id, t.direction, r.name as route, t.started_at from trips t join routes r on r.id = t.route_id where t.driver_user_id = $1 and t.status = 'in_progress' limit 1`, [env.ctx.userId]);
      if (!trip) return ok({ active: false });
      const counts = await many(c, `select status, count(*) as n from trip_riders where trip_id = $1 group by status`, [trip.id]);
      const next = await one(
        c,
        `select s.name from route_stops s join trip_riders tr on tr.stop_id = s.id
         where tr.trip_id = $1 and tr.status = case when $2 = 'to_school' then 'expected' else 'boarded' end order by s.seq limit 1`,
        [trip.id, trip.direction],
      );
      return ok({ active: true, route: trip.route, direction: trip.direction, startedMinutesAgo: Math.round((ageSeconds(trip.started_at) ?? 0) / 60), counts: Object.fromEntries(counts.map((x) => [x.status, x.n])), nextStop: next?.name ?? null });
    },
  },

  // ---------------- الإدارة ----------------
  {
    name: 'get_operations_summary',
    roles: STAFF,
    description: 'Today\'s operations: trips by status, trips late to start (with minutes), open safety alerts by kind.',
    schema: z.object({}),
    jsonSchema: noArgs,
    run: async (c, env) => {
      const t = await loadTenant(c, env.ctx.tenantId!);
      const today = todayIn(t.timezone);
      const byStatus = await many(c, `select status, count(*) as n from trips where service_date = $1 group by status`, [today]);
      const late = await many(
        c,
        `select r.name as route, round(extract(epoch from (now() - t.planned_start)) / 60) as minutes_late
         from trips t join routes r on r.id = t.route_id
         where t.status = 'scheduled' and t.planned_start < now() - make_interval(mins => $1) and t.service_date = $2`,
        [t.cfg.delayThresholdMin, today],
      );
      const alerts = await many(c, `select kind, severity, count(*) as n from safety_alerts where status <> 'resolved' group by kind, severity`);
      return ok({ date: today, tripsByStatus: Object.fromEntries(byStatus.map((x) => [x.status, x.n])), lateToStart: late, lateDefinition: `not started ${t.cfg.delayThresholdMin}+ minutes after planned time`, openAlerts: alerts, delayReasons: 'not recorded in the system — do not guess' });
    },
  },
  {
    name: 'list_open_tickets',
    roles: STAFF,
    description: 'List open support tickets in the organization\'s queue.',
    schema: z.object({}),
    jsonSchema: noArgs,
    run: async (c) => {
      const rows = await many(
        c,
        `select id, ref, subject, status, priority, category, last_activity_at from support_tickets
         where queue = 'tenant' and status in ('open', 'in_progress', 'waiting_user') order by last_activity_at desc limit 20`,
      );
      return ok({ count: rows.length, tickets: rows.map((r) => ({ ref: Number(r.ref), subject: r.subject, status: r.status, priority: r.priority, category: r.category })) });
    },
  },
  {
    name: 'get_attendance_summary',
    roles: STAFF,
    description: 'Attendance counts (boarded, dropped off, absent, no-show, awaiting) for a date (default today).',
    schema: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
    jsonSchema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD' } }, additionalProperties: false },
    run: async (c, env, input) => {
      const t = await loadTenant(c, env.ctx.tenantId!);
      const date = input.date ?? todayIn(t.timezone);
      const rows = await many(
        c,
        `select tr.status, count(*) as n from trip_riders tr join trips t on t.id = tr.trip_id where t.service_date = $1 and t.status <> 'cancelled' group by tr.status`,
        [date],
      );
      return ok({ date, counts: Object.fromEntries(rows.map((x) => [x.status, x.n])) });
    },
  },
  {
    name: 'list_pending_absences',
    roles: STAFF,
    description: 'List absence requests awaiting review.',
    schema: z.object({}),
    jsonSchema: noArgs,
    run: async (c) => {
      const rows = await many(
        c,
        `select s.full_name, a.absence_date, a.direction from absences a join students s on s.id = a.student_id
         where a.status = 'pending' order by a.absence_date limit 30`,
      );
      return ok({ count: rows.length, requests: rows.map((r) => ({ student: firstName(r.full_name), date: r.absence_date, direction: r.direction })) });
    },
  },
];

export function toolsForRole(role: RequestContext['role']) {
  return TOOLS.filter((t) => t.roles.includes(role));
}
