/**
 * «مساعد باصنا» والدعم: يُختبر بمزود نموذج "مُبرمَج" يحاكي استدعاءات الأدوات،
 * حتى نتحقق من منطق الخادم (الصلاحيات، التأكيد، التعطل، التصعيد) دون مفتاح API.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { api, buildTenantWorld, platformAdminToken, ownerQuery, getApp } from './helpers.js';
import { closePools } from '../src/db/pool.js';
import { setAiProvider, AiUnavailableError, type AiProvider, type AiTurn } from '../src/integrations/ai.js';
import { processOutbox } from '../src/worker/dispatcher.js';

type Step = (messages: any[], tools: string[]) => Partial<AiTurn> | Error;

/** مزود وهمي: كل استدعاء يأخذ الخطوة التالية من السيناريو ويسجّل ما أُرسل إليه */
class ScriptedProvider implements AiProvider {
  name = 'scripted';
  configured = true;
  calls: Array<{ messages: any[]; tools: string[]; system: string }> = [];
  constructor(private steps: Step[]) {}
  async turn(input: { system: string; tools: any[]; messages: unknown[] }): Promise<AiTurn> {
    const tools = input.tools.map((t) => t.name);
    this.calls.push({ messages: JSON.parse(JSON.stringify(input.messages)), tools, system: input.system });
    const step = this.steps.shift();
    if (!step) throw new Error('unexpected model call');
    const r = step(input.messages as any[], tools);
    if (r instanceof Error) throw r;
    const toolCalls = r.toolCalls ?? [];
    const content: any[] = [];
    if (r.text) content.push({ type: 'text', text: r.text });
    for (const t of toolCalls) content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input });
    return {
      stop: r.stop ?? (toolCalls.length ? 'tool_use' : 'end'),
      text: r.text ?? '',
      toolCalls,
      assistantMessage: { role: 'assistant', content },
      usage: { input: 100, output: 20 },
    };
  }
  userMessage(texts: string[]) {
    return { role: 'user', content: texts.map((t) => ({ type: 'text', text: t })) };
  }
  toolResultsMessage(results: Array<{ id: string; content: string; isError?: boolean }>) {
    return { role: 'user', content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, is_error: !!r.isError })) };
  }
}

const lastToolResult = (p: ScriptedProvider) => {
  const msgs = p.calls[p.calls.length - 1].messages;
  return JSON.parse(msgs[msgs.length - 1].content[0].content);
};

let platform: string;
let A: Awaited<ReturnType<typeof buildTenantWorld>>;
let B: Awaited<ReturnType<typeof buildTenantWorld>>;

beforeAll(async () => {
  platform = await platformAdminToken();
  A = await buildTenantWorld(platform, 'مساعد');
  B = await buildTenantWorld(platform, 'أخرى');
});
afterEach(() => setAiProvider(null));
afterAll(async () => {
  await (await getApp()).close();
  await closePools();
});

describe('assistant without a model (fallback)', () => {
  it('works without an AI key: no invented answer, knowledge results and ticket option', async () => {
    const r = await api('POST', '/assistant/messages', A.parent1.token, { text: 'كيف أبلغ عن غياب ابني؟' });
    expect(r.status).toBe(200);
    expect(r.body.reply.mode).toBe('fallback');
    expect(r.body.reply.offerTicket).toBe(true);
    expect(r.body.reply.text).toContain('لن أخمّن');
    expect(r.body.reply.cards[0].items.map((i: any) => i.title)).toContain('كيف أبلغ عن غياب ابني؟');
  });

  it('routes emergencies to direct calls immediately, without calling the model', async () => {
    const p = new ScriptedProvider([]);
    setAiProvider(p);
    const r = await api('POST', '/assistant/messages', A.parent1.token, { text: 'بنتي مفقودة وما رجعت من المدرسة' });
    expect(r.body.reply.mode).toBe('emergency');
    expect(r.body.reply.cards[0]).toMatchObject({ type: 'emergency', phone: '+966500000000', emergencyNumber: '911' });
    expect(p.calls).toHaveLength(0);
    const action = r.body.reply.actions[0];
    const c = await api('POST', `/assistant/actions/${action.id}/confirm`, A.parent1.token, {});
    expect(c.status).toBe(200);
    const t = await ownerQuery(`select queue, category, priority, source from support_tickets where ref = $1`, [c.body.result.ticketRef]);
    expect(t[0]).toEqual({ queue: 'tenant', category: 'safety', priority: 'urgent', source: 'assistant' });
  });
});

describe('assistant with a model (scripted)', () => {
  it('cannot read another family\'s child even if the model proposes its id', async () => {
    const p = new ScriptedProvider([
      () => ({ toolCalls: [{ id: 't1', name: 'get_latest_allowed_bus_location', input: { childId: A.student2 } }] }),
      () => ({ text: 'لا أستطيع الوصول لهذه البيانات.' }),
    ]);
    setAiProvider(p);
    const r = await api('POST', '/assistant/messages', A.parent1.token, { text: 'وين باص خالد؟' });
    expect(r.body.reply.mode).toBe('ai');
    const result = lastToolResult(p);
    expect(result.error).toBe('child_not_found');
    expect(JSON.stringify(p.calls)).not.toContain('خالد مساعد'); // لا اسم كامل لطفل آخر
    expect(r.body.reply.cards).toHaveLength(0);
  });

  it('denies tools outside the user\'s role and never offers them', async () => {
    const p = new ScriptedProvider([
      (_m, tools) => {
        expect(tools).not.toContain('get_operations_summary');
        expect(tools).toContain('submit_absence_request');
        return { toolCalls: [{ id: 't1', name: 'get_operations_summary', input: {} }] };
      },
      () => ({ text: 'غير متاح.' }),
    ]);
    setAiProvider(p);
    await api('POST', '/assistant/messages', A.parent1.token, { text: 'كم رحلة متأخرة؟' });
    expect(lastToolResult(p).error).toBe('tool_not_available_for_this_user');
    const log = await ownerQuery(`select outcome from assistant_tool_log where tool = 'get_operations_summary' order by id desc limit 1`);
    expect(log[0].outcome).toBe('denied');
  });

  it('reports location freshness to the model and coordinates only to the user card', async () => {
    await api('POST', `/driver/trips/${A.tripId}/start`, A.driver.token, {});
    await api('POST', `/driver/trips/${A.tripId}/locations`, A.driver.token, { points: [{ recordedAt: new Date().toISOString(), lat: 24.7141, lng: 46.6761 }] });
    const p = new ScriptedProvider([
      () => ({ toolCalls: [{ id: 't1', name: 'get_latest_allowed_bus_location', input: {} }] }),
      () => ({ text: 'الباص في الطريق، آخر تحديث قبل أقل من دقيقة.' }),
    ]);
    setAiProvider(p);
    const r = await api('POST', '/assistant/messages', A.parent1.token, { text: 'وين باص ولدي؟' });
    const result = lastToolResult(p);
    expect(result).toMatchObject({ available: true, isLive: true });
    expect(JSON.stringify(result)).not.toContain('24.714'); // لا إحداثيات للنموذج
    expect(result.eta).toContain('not available');
    expect(r.body.reply.cards[0]).toMatchObject({ type: 'location', lat: 24.7141, isStale: false });
  });

  it('prepares an absence but only submits it after the user confirms', async () => {
    const date = A.today;
    const p = new ScriptedProvider([
      () => ({ toolCalls: [{ id: 't1', name: 'submit_absence_request', input: { date, direction: 'from_school' } }] }),
      () => ({ text: 'جهزت الطلب، اضغط تأكيد.' }),
      (messages) => {
        // الرسالة التالية تحمل ملاحظة النظام بنتيجة التأكيد
        const last = messages[messages.length - 1];
        expect(last.content[0].text).toContain('CONFIRMED');
        return { text: 'تم.' };
      },
    ]);
    setAiProvider(p);
    const r = await api('POST', '/assistant/messages', A.parent1.token, { text: 'أبي أبلغ عن غياب سارة اليوم في العودة' });
    expect(lastToolResult(p).status).toBe('awaiting_user_confirmation');
    expect(r.body.reply.actions).toHaveLength(1);
    let rows = await ownerQuery(`select count(*)::int as n from absences where student_id = $1 and direction = 'from_school'`, [A.student1]);
    expect(rows[0].n).toBe(0); // لم يُسجَّل شيء قبل التأكيد
    // مستخدم آخر لا يستطيع تأكيد إجراء غيره
    expect((await api('POST', `/assistant/actions/${r.body.reply.actions[0].id}/confirm`, A.parent2.token, {})).status).toBe(404);
    const c = await api('POST', `/assistant/actions/${r.body.reply.actions[0].id}/confirm`, A.parent1.token, {});
    expect(c.body.status).toBe('confirmed');
    rows = await ownerQuery(`select status from absences where student_id = $1 and direction = 'from_school'`, [A.student1]);
    expect(rows[0].status).toBe('approved');
    expect((await api('POST', `/assistant/actions/${r.body.reply.actions[0].id}/confirm`, A.parent1.token, {})).status).toBe(409);
    await api('POST', '/assistant/messages', A.parent1.token, { conversationId: r.body.conversationId, text: 'شكرًا' });
  });

  it('does not invent information when the model fails mid-conversation', async () => {
    const p = new ScriptedProvider([
      () => ({ toolCalls: [{ id: 't1', name: 'get_child_transport_status', input: {} }] }),
      () => new AiUnavailableError('provider_error:529'),
    ]);
    setAiProvider(p);
    const r = await api('POST', '/assistant/messages', A.parent1.token, { text: 'هل بنتي ركبت؟' });
    expect(r.body.reply.mode).toBe('fallback');
    expect(r.body.reply.text).toContain('لن أخمّن');
    expect(r.body.reply.text).not.toMatch(/صعد|ركبت|نزل/);
    // السجل يبقى صالحًا: كل استدعاء أداة له نتيجة
    const rows = await ownerQuery(
      `select model_message from assistant_messages where conversation_id = $1 and model_message is not null order by id`,
      [r.body.conversationId],
    );
    const last = rows[rows.length - 1].model_message;
    expect(last.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });
  });

  it('hands off to a human: ticket routed to the organization, visible to staff only', async () => {
    const p = new ScriptedProvider([
      () => ({ toolCalls: [{ id: 't1', name: 'escalate_to_human', input: { summary: 'ولي الأمر يطلب موظفًا بخصوص التأخير', category: 'trip' } }] }),
      () => ({ text: 'جهزت التحويل لموظف، اضغط تأكيد.' }),
    ]);
    setAiProvider(p);
    const r = await api('POST', '/assistant/messages', A.parent1.token, { text: 'أبي أكلم موظف' });
    const c = await api('POST', `/assistant/actions/${r.body.reply.actions[0].id}/confirm`, A.parent1.token, {});
    expect(c.body.message).toContain('#');
    const ref = c.body.result.ticketRef;
    const mine = await api('GET', '/support/tickets', A.parent1.token);
    expect(mine.body.tickets.map((t: any) => Number(t.ref))).toContain(ref);
    const queue = await api('GET', '/support/tickets?scope=queue', A.adminToken);
    expect(queue.body.tickets.map((t: any) => Number(t.ref))).toContain(ref);
    const other = await api('GET', '/support/tickets', A.parent2.token);
    expect(other.body.tickets.map((t: any) => Number(t.ref))).not.toContain(ref);
    const otherTenant = await api('GET', '/support/tickets?scope=queue', B.adminToken);
    expect(otherTenant.body.tickets.map((t: any) => Number(t.ref))).not.toContain(ref);
    const platformQ = await api('GET', '/support/tickets?scope=queue', platform);
    expect(platformQ.body.tickets.map((t: any) => Number(t.ref))).not.toContain(ref);
  });

  it('enforces the per-user daily limit and falls back', async () => {
    await ownerQuery(`update tenants set settings = settings || '{"assistantDailyLimitPerUser": 1}' where id = $1`, [B.tenantId]);
    setAiProvider(new ScriptedProvider([() => ({ text: 'أهلًا' })]));
    const r1 = await api('POST', '/assistant/messages', B.parent1.token, { text: 'مرحبا' });
    expect(r1.body.reply.mode).toBe('ai');
    const r2 = await api('POST', '/assistant/messages', B.parent1.token, { text: 'مرحبا مرة أخرى' });
    expect(r2.body.reply.mode).toBe('fallback');
  });

  it('keeps conversations private to their owner', async () => {
    const r = await api('POST', '/assistant/messages', A.parent1.token, { text: 'سؤال' });
    expect((await api('GET', `/assistant/conversations/${r.body.conversationId}`, A.parent2.token)).status).toBe(404);
    expect((await api('GET', `/assistant/conversations/${r.body.conversationId}`, B.parent1.token)).status).toBe(404);
    const mine = await api('GET', `/assistant/conversations/${r.body.conversationId}`, A.parent1.token);
    expect(mine.body.messages[0].text).toBe('سؤال');
  });
});

describe('support tickets', () => {
  it('routes app-usage issues to platform support and transport issues to the organization', async () => {
    const app1 = await api('POST', '/support/tickets', A.parent1.token, { category: 'app_usage', subject: 'التطبيق لا يرسل إشعارات', body: 'لا تصلني أي إشعارات منذ أمس' });
    const ops = await api('POST', '/support/tickets', A.parent1.token, { category: 'trip', subject: 'الباص يتأخر يوميًا', body: 'الباص يصل متأخرًا' });
    expect(app1.body.ticket.queue).toBe('platform');
    expect(ops.body.ticket.queue).toBe('tenant');
    const tenantQ = await api('GET', '/support/tickets?scope=queue', A.adminToken);
    const tenantRefs = tenantQ.body.tickets.map((t: any) => Number(t.ref));
    expect(tenantRefs).toContain(ops.body.ticket.ref);
    expect(tenantRefs).not.toContain(app1.body.ticket.ref);
    const platformQ = await api('GET', '/support/tickets?scope=queue', platform);
    const pt = platformQ.body.tickets.find((t: any) => Number(t.ref) === app1.body.ticket.ref);
    expect(pt.requesterName).toContain('ولي أمر');
    expect(platformQ.body.tickets.map((t: any) => Number(t.ref))).not.toContain(ops.body.ticket.ref);
  });

  it('hides internal staff notes from the requester and notifies on replies', async () => {
    const t = await api('POST', '/support/tickets', A.parent2.token, { category: 'absence', subject: 'استفسار عن الغياب', body: 'هل يلزم عذر؟' });
    const id = t.body.ticket.id;
    expect((await api('POST', `/support/tickets/${id}/messages`, A.adminToken, { body: 'ملاحظة داخلية: تحقق من السجل', internal: true })).status).toBe(200);
    expect((await api('POST', `/support/tickets/${id}/messages`, A.adminToken, { body: 'لا يلزم عذر، شكرًا لتواصلك' })).status).toBe(200);
    // صاحب التذكرة لا يستطيع كتابة ملاحظة داخلية
    expect((await api('POST', `/support/tickets/${id}/messages`, A.parent2.token, { body: 'x', internal: true })).status).toBe(403);
    const view = await api('GET', `/support/tickets/${id}`, A.parent2.token);
    expect(view.body.messages.map((m: any) => m.body)).toEqual(['هل يلزم عذر؟', 'لا يلزم عذر، شكرًا لتواصلك']);
    expect(view.body.ticket.status).toBe('in_progress');
    // صاحب التذكرة لا يغيّر الأولوية أو يحلّها بنفسه، لكن يستطيع إغلاقها
    expect((await api('PATCH', `/support/tickets/${id}`, A.parent2.token, { priority: 'urgent' })).status).toBe(403);
    expect((await api('PATCH', `/support/tickets/${id}`, A.parent2.token, { status: 'resolved' })).status).toBe(403);
    expect((await api('PATCH', `/support/tickets/${id}`, A.parent2.token, { status: 'closed' })).status).toBe(200);
    await processOutbox();
    const n = await api('GET', '/me/notifications', A.parent2.token);
    expect(n.body.notifications.some((x: any) => x.kind === 'ticket_update')).toBe(true);
    const staffN = await api('GET', '/me/notifications', A.adminToken);
    expect(staffN.body.notifications.some((x: any) => x.kind === 'ticket_queue')).toBe(true);
    // ولي أمر آخر وجهة أخرى لا يريان التذكرة
    expect((await api('GET', `/support/tickets/${id}`, A.parent1.token)).status).toBe(404);
    expect((await api('GET', `/support/tickets/${id}`, B.adminToken)).status).toBe(404);
  });

  it('tenant knowledge is searchable only inside its organization', async () => {
    await api('POST', '/tenant/knowledge', A.adminToken, { title: 'سياسة استرداد رسوم النقل', body: 'يُسترد 50% عند الانسحاب قبل منتصف الفصل.', audience: ['parent'], tags: ['استرداد'] });
    const a = await api('GET', '/knowledge/search?q=استرداد الرسوم', A.parent1.token);
    expect(a.body.results[0].title).toBe('سياسة استرداد رسوم النقل');
    const b = await api('GET', '/knowledge/search?q=استرداد الرسوم', B.parent1.token);
    expect(b.body.results.map((r: any) => r.title)).not.toContain('سياسة استرداد رسوم النقل');
    // مقالات المنصة العامة متاحة للجميع
    expect(b.body.results).toBeDefined();
    expect((await api('POST', '/tenant/knowledge', A.parent1.token, { title: 'xxx', body: 'yyy' })).status).toBe(403);
  });
});
