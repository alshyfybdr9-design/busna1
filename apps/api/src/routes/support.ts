/** تذاكر الدعم + قاعدة المعرفة */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withCtx, one, many } from '../db/pool.js';
import { requireAuth, type Role } from '../lib/auth.js';
import { AppError, notFound } from '../lib/errors.js';
import { parse, idParam, audit } from '../lib/util.js';
import { createTicket, listMyTickets, TICKET_CATEGORIES } from '../services/support.js';
import { searchKnowledge } from '../services/knowledge.js';
import { enqueue } from '../services/outbox.js';
import { loadTenant } from '../services/trips.js';

const TENANT_ROLES: Role[] = ['tenant_admin', 'supervisor', 'driver', 'parent'];
const ANY: Role[] = [...TENANT_ROLES, 'platform_admin', 'platform_support'];
const isPlatform = (r: Role) => r === 'platform_admin' || r === 'platform_support';

const articleBody = z.object({
  title: z.string().trim().min(3).max(200),
  body: z.string().trim().min(3).max(8000),
  audience: z.array(z.enum(['parent', 'driver', 'staff'])).min(1).max(3).default(['parent', 'driver', 'staff']),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  status: z.enum(['published', 'draft']).default('published'),
});

export async function supportRoutes(app: FastifyInstance) {
  // معلومات التواصل الفعلية للجهة (لا أوقات استجابة مختلقة)
  app.get('/support/info', { preHandler: requireAuth(TENANT_ROLES) }, async (req) =>
    withCtx(req.ctx, async (c) => {
      const t = await loadTenant(c, req.ctx.tenantId!);
      const row = await one(c, `select name, contact_phone as "contactPhone", contact_email as "contactEmail" from tenants where id = $1`, [t.id]);
      return { ...row, supportHours: t.cfg.supportHours, emergencyNumber: t.cfg.emergencyNumber };
    }),
  );

  app.get('/support/tickets', { preHandler: requireAuth(ANY) }, async (req) => {
    const q = parse(z.object({
      scope: z.enum(['mine', 'queue']).default('mine'),
      status: z.enum(['open', 'in_progress', 'waiting_user', 'resolved', 'closed', 'active']).optional(),
    }), req.query);
    return withCtx(req.ctx, async (c) => {
      if (q.scope === 'mine' && !isPlatform(req.ctx.role)) return { tickets: await listMyTickets(c, req.ctx, 100) };
      if (!['tenant_admin', 'supervisor', 'platform_admin', 'platform_support', 'platform_readonly'].includes(req.ctx.role)) throw new AppError(403, 'forbidden');
      // RLS تعيد طابور الجهة للموظفين، وطابور المنصة لمدير المنصة
      const tickets = await many(
        c,
        `select t.id, t.ref, t.queue, t.category, t.subject, t.status, t.priority, t.source,
                t.created_at as "createdAt", t.last_activity_at as "lastActivityAt",
                u.full_name as "requesterName", t.requester_role as "requesterRole", tn.name as "tenantName",
                a.full_name as "assignedName"
         from support_tickets t join users u on u.id = t.requester_user_id join tenants tn on tn.id = t.tenant_id
         left join users a on a.id = t.assigned_to
         where ($1::boolean or t.queue = 'tenant')
           and ($2::text is null or ($2 = 'active' and t.status in ('open', 'in_progress', 'waiting_user')) or t.status = $2)
         order by case t.priority when 'urgent' then 0 when 'high' then 1 else 2 end, t.last_activity_at desc limit 300`,
        [isPlatform(req.ctx.role), q.status ?? null],
      );
      return { tickets };
    });
  });

  app.post('/support/tickets', { preHandler: requireAuth(TENANT_ROLES), config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const body = parse(z.object({
      category: z.enum(TICKET_CATEGORIES),
      subject: z.string().trim().min(3).max(200),
      body: z.string().trim().min(3).max(5000),
      studentId: z.string().uuid().optional(),
      tripId: z.string().uuid().optional(),
      priority: z.enum(['normal', 'high']).optional(),
      source: z.enum(['app', 'web']).default('app'),
    }), req.body);
    return withCtx(req.ctx, async (c) => ({ ticket: await createTicket(c, req.ctx, body) }));
  });

  app.get('/support/tickets/:id', { preHandler: requireAuth(ANY) }, async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(req.ctx, async (c) => {
      const ticket = await one(
        c,
        `select t.id, t.ref, t.queue, t.category, t.subject, t.status, t.priority, t.source, t.created_at as "createdAt",
                t.last_activity_at as "lastActivityAt", t.requester_user_id as "requesterUserId", t.requester_role as "requesterRole",
                t.student_id as "studentId", t.trip_id as "tripId", t.conversation_id as "conversationId",
                u.full_name as "requesterName", s.full_name as "studentName", tn.name as "tenantName",
                app.ticket_agent(t.id) as "isAgent"
         from support_tickets t join users u on u.id = t.requester_user_id join tenants tn on tn.id = t.tenant_id
         left join students s on s.id = t.student_id where t.id = $1`,
        [id],
      );
      if (!ticket) throw notFound();
      // RLS تحجب الملاحظات الداخلية عن صاحب التذكرة
      const messages = await many(
        c,
        `select m.id, m.author_kind as "authorKind", m.body, m.internal, m.created_at as "createdAt",
                case when m.author_kind = 'agent' and not app.ticket_agent(m.ticket_id) then null else u.full_name end as "authorName"
         from ticket_messages m left join users u on u.id = m.author_user_id where m.ticket_id = $1 order by m.created_at`,
        [id],
      );
      return { ticket, messages };
    });
  });

  app.post('/support/tickets/:id/messages', { preHandler: requireAuth(ANY), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ body: z.string().trim().min(1).max(5000), internal: z.boolean().default(false) }), req.body);
    return withCtx(req.ctx, async (c) => {
      const t = await one(c, `select id, tenant_id, status, requester_user_id, app.ticket_agent(id) as agent from support_tickets where id = $1`, [id]);
      if (!t) throw notFound();
      if (t.status === 'closed') throw new AppError(409, 'conflict', { reason: 'ticket_closed' });
      const isAgent = t.agent as boolean;
      if (body.internal && !isAgent) throw new AppError(403, 'forbidden');
      await c.query(
        `insert into ticket_messages (ticket_id, tenant_id, author_user_id, author_kind, body, internal) values ($1, $2, $3, $4, $5, $6)`,
        [id, t.tenant_id, req.ctx.userId, isAgent ? 'agent' : 'requester', body.body, body.internal],
      );
      // رد الموظف ينقل التذكرة لقيد المعالجة؛ رد صاحبها يعيد فتح "بانتظار ردك"
      const nextStatus = isAgent && !body.internal && t.status === 'open' ? 'in_progress'
        : !isAgent && (t.status === 'waiting_user' || t.status === 'resolved') ? 'open' : t.status;
      await c.query(`update support_tickets set last_activity_at = now(), status = $2 where id = $1`, [id, nextStatus]);
      if (!body.internal) await enqueue(c, t.tenant_id, 'ticket_event', { ticketId: id, event: isAgent ? 'agent_reply' : 'requester_reply' });
      return { ok: true, status: nextStatus };
    });
  });

  app.patch('/support/tickets/:id', { preHandler: requireAuth(ANY) }, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({
      status: z.enum(['open', 'in_progress', 'waiting_user', 'resolved', 'closed']).optional(),
      priority: z.enum(['normal', 'high', 'urgent']).optional(),
      assignToMe: z.boolean().optional(),
    }), req.body);
    return withCtx(req.ctx, async (c) => {
      const t = await one(c, `select id, tenant_id, status, app.ticket_agent(id) as agent from support_tickets where id = $1`, [id]);
      if (!t) throw notFound();
      if (!t.agent && (body.priority || body.assignToMe || (body.status && !['closed', 'open'].includes(body.status)))) throw new AppError(403, 'forbidden');
      await c.query(
        `update support_tickets set status = coalesce($2, status), priority = coalesce($3, priority),
           assigned_to = case when $4::boolean then $5::uuid else assigned_to end,
           resolved_at = case when $2 in ('resolved', 'closed') then coalesce(resolved_at, now()) when $2 is not null then null else resolved_at end,
           last_activity_at = now()
         where id = $1`,
        [id, body.status ?? null, body.priority ?? null, !!body.assignToMe, req.ctx.userId],
      );
      if (body.status && body.status !== t.status) {
        await c.query(
          `insert into outbox_events (tenant_id, kind, payload) values ($1, 'ticket_event', $2)`,
          [t.tenant_id, JSON.stringify({ ticketId: id, event: 'status', status: body.status })],
        );
      }
      await audit(c, req.ctx, 'ticket.updated', 'support_ticket', id, body, t.tenant_id);
      return { ok: true };
    });
  });

  // ---------------- قاعدة المعرفة ----------------
  app.get('/knowledge/search', { preHandler: requireAuth(TENANT_ROLES) }, async (req) => {
    const q = parse(z.object({ q: z.string().trim().min(2).max(200) }), req.query);
    return withCtx(req.ctx, async (c) => ({ results: await searchKnowledge(c, req.ctx, q.q, 5) }));
  });

  const kbList = (scopeSql: string) => async (req: any) =>
    withCtx(req.ctx, async (c) => ({
      articles: await many(
        c,
        `select id, title, body, audience, tags, status, tenant_id is null as "isGlobal", updated_at as "updatedAt"
         from knowledge_articles where ${scopeSql} order by updated_at desc limit 300`,
      ),
    }));
  app.get('/tenant/knowledge', { preHandler: requireAuth(['tenant_admin', 'supervisor']) }, kbList('true'));
  app.get('/platform/knowledge', { preHandler: requireAuth(['platform_admin', 'platform_support']) }, kbList('tenant_id is null'));

  for (const scope of ['tenant', 'platform'] as const) {
    const auth = { preHandler: requireAuth(scope === 'tenant' ? ['tenant_admin'] : ['platform_admin', 'platform_support']) };
    app.post(`/${scope}/knowledge`, auth, async (req) => {
      const b = parse(articleBody, req.body);
      return withCtx(req.ctx, async (c) => {
        const r = await one(
          c,
          `insert into knowledge_articles (tenant_id, title, body, audience, tags, status, updated_by) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [scope === 'tenant' ? req.ctx.tenantId : null, b.title, b.body, b.audience, b.tags, b.status, req.ctx.userId],
        );
        await audit(c, req.ctx, 'knowledge.created', 'knowledge_article', r.id);
        return { article: r };
      });
    });
    app.patch(`/${scope}/knowledge/:id`, auth, async (req) => {
      const { id } = parse(idParam, req.params);
      const b = parse(articleBody.partial(), req.body);
      return withCtx(req.ctx, async (c) => {
        const r = await c.query(
          `update knowledge_articles set title = coalesce($2, title), body = coalesce($3, body), audience = coalesce($4, audience),
             tags = coalesce($5, tags), status = coalesce($6, status), updated_by = $7
           where id = $1 and ${scope === 'tenant' ? 'tenant_id is not null' : 'tenant_id is null'}`,
          [id, b.title ?? null, b.body ?? null, b.audience ?? null, b.tags ?? null, b.status ?? null, req.ctx.userId],
        );
        if (!r.rowCount) throw notFound();
        await audit(c, req.ctx, 'knowledge.updated', 'knowledge_article', id);
        return { ok: true };
      });
    });
    app.delete(`/${scope}/knowledge/:id`, auth, async (req) => {
      const { id } = parse(idParam, req.params);
      return withCtx(req.ctx, async (c) => {
        const r = await c.query(`delete from knowledge_articles where id = $1 and ${scope === 'tenant' ? 'tenant_id is not null' : 'tenant_id is null'}`, [id]);
        if (!r.rowCount) throw notFound();
        await audit(c, req.ctx, 'knowledge.deleted', 'knowledge_article', id);
        return { ok: true };
      });
    });
  }
}
