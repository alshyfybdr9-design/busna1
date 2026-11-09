import { one, many, type Db, type RequestContext } from '../db/pool.js';
import { AppError, notFound } from '../lib/errors.js';
import { audit } from '../lib/util.js';
import { enqueue } from './outbox.js';

export const TICKET_CATEGORIES = ['app_usage', 'trip', 'absence', 'payment', 'safety', 'account', 'other'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

/**
 * التوجيه: مشاكل استخدام التطبيق والحساب ← إدارة المنصة.
 * كل ما يخص تشغيل النقل (الرحلات، الغياب، الرسوم، السلامة...) ← الجهة نفسها.
 */
export function queueFor(category: TicketCategory): 'tenant' | 'platform' {
  return category === 'app_usage' || category === 'account' ? 'platform' : 'tenant';
}

export async function createTicket(
  c: Db,
  ctx: RequestContext,
  input: {
    category: TicketCategory;
    subject: string;
    body: string;
    studentId?: string | null;
    tripId?: string | null;
    priority?: 'normal' | 'high' | 'urgent';
    source: 'app' | 'web' | 'assistant';
    conversationId?: string | null;
  },
) {
  if (!ctx.tenantId) throw new AppError(403, 'forbidden');
  // معرّفات الطالب/الرحلة تُتحقق عبر RLS: غير المرئي للمستخدم = غير موجود
  if (input.studentId && !(await one(c, `select 1 from students where id = $1`, [input.studentId]))) throw notFound();
  if (input.tripId && !(await one(c, `select 1 from trips where id = $1`, [input.tripId]))) throw notFound();
  const priority = input.category === 'safety' ? 'urgent' : input.priority === 'urgent' ? 'high' : input.priority ?? 'normal';
  const t = await one(
    c,
    `insert into support_tickets (tenant_id, queue, category, subject, priority, requester_user_id, requester_role, student_id, trip_id, source, conversation_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id, ref, queue, status, priority`,
    [ctx.tenantId, queueFor(input.category), input.category, input.subject.slice(0, 200), priority, ctx.userId, ctx.role,
      input.studentId ?? null, input.tripId ?? null, input.source, input.conversationId ?? null],
  );
  await c.query(
    `insert into ticket_messages (ticket_id, tenant_id, author_user_id, author_kind, body) values ($1, $2, $3, 'requester', $4)`,
    [t.id, ctx.tenantId, ctx.userId, input.body.slice(0, 5000)],
  );
  await enqueue(c, ctx.tenantId, 'ticket_event', { ticketId: t.id, event: 'created' });
  await audit(c, ctx, 'ticket.created', 'support_ticket', t.id, { queue: t.queue, category: input.category, source: input.source });
  return { id: t.id as string, ref: Number(t.ref), queue: t.queue as string, status: t.status as string, priority: t.priority as string };
}

export async function listMyTickets(c: Db, ctx: RequestContext, limit = 20) {
  return many(
    c,
    `select id, ref, queue, category, subject, status, priority, created_at as "createdAt", last_activity_at as "lastActivityAt"
     from support_tickets where requester_user_id = $1 order by last_activity_at desc limit $2`,
    [ctx.userId, limit],
  );
}

export const STATUS_AR: Record<string, string> = {
  open: 'مفتوحة', in_progress: 'قيد المعالجة', waiting_user: 'بانتظار ردك', resolved: 'تم الحل', closed: 'مغلقة',
};
