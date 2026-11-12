import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withCtx, many } from '../db/pool.js';
import { requireAuth, type Role } from '../lib/auth.js';
import { notFound } from '../lib/errors.js';
import { parse, idParam } from '../lib/util.js';
import { decideAction, getConversation, handleMessage } from '../services/assistant/engine.js';
import { aiProvider } from '../integrations/ai.js';

const ROLES: Role[] = ['tenant_admin', 'supervisor', 'driver', 'attendant', 'parent'];

export async function assistantRoutes(app: FastifyInstance) {
  const auth = { preHandler: requireAuth(ROLES) };

  app.get('/assistant/status', auth, async () => ({ aiAvailable: aiProvider().configured }));

  app.post('/assistant/messages', { ...auth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const body = parse(z.object({ conversationId: z.string().uuid().optional(), text: z.string().trim().min(1).max(2000) }), req.body);
    return handleMessage(req.ctx, body);
  });

  app.get('/assistant/conversations', auth, async (req) =>
    withCtx(req.ctx, async (c) => ({
      conversations: await many(
        c,
        `select id, created_at as "createdAt", last_message_at as "lastMessageAt" from assistant_conversations order by last_message_at desc limit 20`,
      ),
    })),
  );

  app.get('/assistant/conversations/:id', auth, async (req) => {
    const { id } = parse(idParam, req.params);
    return getConversation(req.ctx, id);
  });

  /** حذف المستخدم لمحادثته (إضافة لسياسة الاحتفاظ التلقائية) */
  app.delete('/assistant/conversations/:id', auth, async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(req.ctx, async (c) => {
      const r = await c.query(`delete from assistant_conversations where id = $1`, [id]);
      if (!r.rowCount) throw notFound();
      return { ok: true };
    });
  });

  app.post('/assistant/actions/:id/confirm', auth, async (req) => {
    const { id } = parse(idParam, req.params);
    return decideAction(req.ctx, id, 'confirm');
  });

  app.post('/assistant/actions/:id/cancel', auth, async (req) => {
    const { id } = parse(idParam, req.params);
    return decideAction(req.ctx, id, 'cancel');
  });
}
