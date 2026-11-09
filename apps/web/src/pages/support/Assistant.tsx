import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { useI18n } from '../../i18n';
import { ErrorBox } from '../../components/ui';

type Msg = {
  role: 'user' | 'assistant';
  text: string;
  mode?: 'ai' | 'fallback' | 'emergency' | 'system';
  cards?: any[];
  actions?: Array<{ id: string; summary: string }>;
  offerTicket?: boolean;
};

/** محادثة «مساعد باصنا» لفريق الإدارة */
export function AssistantPage() {
  const { lang } = useI18n();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [decided, setDecided] = useState<Record<string, string>>({});
  const status = useQuery({ queryKey: ['assistant-status'], queryFn: () => api('GET', '/assistant/status') });
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = useMutation({
    mutationFn: (t: string) => api('POST', '/assistant/messages', { text: t, ...(conversationId ? { conversationId } : {}) }),
    onMutate: (t) => setMessages((m) => [...m, { role: 'user', text: t }]),
    onSuccess: (r) => { setConversationId(r.conversationId); setMessages((m) => [...m, r.reply]); },
  });
  const decide = useMutation({
    mutationFn: (p: { id: string; d: 'confirm' | 'cancel' }) => api('POST', `/assistant/actions/${p.id}/${p.d}`, {}),
    onSuccess: (r, p) => {
      setDecided((x) => ({ ...x, [p.id]: r.status }));
      setMessages((m) => [...m, { role: 'assistant', mode: 'system', text: r.message ?? (lang === 'ar' ? 'أُلغي الإجراء.' : 'Cancelled.') }]);
    },
  });

  const suggestions = lang === 'ar'
    ? ['لخص لي الرحلات المتأخرة اليوم', 'كم تذكرة مفتوحة؟', 'ملخص الحضور اليوم', 'هل في طلبات غياب معلقة؟']
    : ['Summarize late trips today', 'How many open tickets?', "Today's attendance summary", 'Pending absence requests?'];

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: '70vh' }}>
      <div className="row between">
        <h2 style={{ margin: 0 }}>{lang === 'ar' ? 'مساعد باصنا' : 'Busna Assistant'}</h2>
        <div className="row">
          {status.data && !status.data.aiAvailable && <span className="badge amber">{lang === 'ar' ? 'الذكاء الاصطناعي غير مفعّل — بحث في قاعدة المعرفة فقط' : 'AI not configured — knowledge search only'}</span>}
          <button className="btn sm ghost" onClick={() => { setConversationId(null); setMessages([]); }}>{lang === 'ar' ? 'محادثة جديدة' : 'New chat'}</button>
        </div>
      </div>
      <p className="small muted">{lang === 'ar' ? 'مساعد آلي يعتمد فقط على بيانات جهتك المصرح لك بها وعلى قاعدة المعرفة. لا ينفذ أي إجراء إلا بعد تأكيدك.' : 'An automated assistant using only your permitted data and the knowledge base. Actions require your confirmation.'}</p>
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, padding: '8px 0' }}>
        {messages.length === 0 && (
          <div className="row">{suggestions.map((s) => <button key={s} className="btn sm secondary" onClick={() => send.mutate(s)}>{s}</button>)}</div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-start' : 'flex-end', maxWidth: '80%' }}>
            <div className={`alert ${m.role === 'user' ? '' : m.mode === 'emergency' ? 'error' : m.mode === 'fallback' ? 'warn' : 'info'}`}
              style={m.role === 'user' ? { background: '#fff', borderColor: 'var(--line)', color: 'var(--ink)' } : undefined}>
              <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
              {(m.cards ?? []).map((c, j) => (
                <div key={j} className="small" style={{ marginTop: 6 }}>
                  {c.type === 'knowledge' && <>📄 {c.items.map((x: any) => x.title).join(' · ')}</>}
                  {c.type === 'tickets' && <>🎫 {c.items.map((x: any) => `#${x.ref} ${x.subject}`).join(' · ')}</>}
                  {c.type === 'contact' && <>☎ {c.phone ?? '—'} · {c.email ?? ''} {c.supportHours ? `· ${c.supportHours}` : ''}</>}
                </div>
              ))}
              {(m.actions ?? []).map((a) => (
                <div key={a.id} className="row" style={{ marginTop: 8 }}>
                  <span className="small">{a.summary}</span>
                  {decided[a.id] ? <span className="badge gray">{decided[a.id]}</span> : <>
                    <button className="btn sm" onClick={() => decide.mutate({ id: a.id, d: 'confirm' })}>{lang === 'ar' ? 'تأكيد' : 'Confirm'}</button>
                    <button className="btn sm ghost" onClick={() => decide.mutate({ id: a.id, d: 'cancel' })}>{lang === 'ar' ? 'إلغاء' : 'Cancel'}</button>
                  </>}
                </div>
              ))}
              {m.offerTicket && <div style={{ marginTop: 6 }}><Link to="/app/support">{lang === 'ar' ? 'فتح التذاكر' : 'Open tickets'}</Link></div>}
            </div>
          </div>
        ))}
        {send.isPending && <div className="muted small" style={{ alignSelf: 'flex-end' }}>{lang === 'ar' ? 'يكتب…' : 'Typing…'}</div>}
        <div ref={end} />
      </div>
      {(send.error || decide.error) && <ErrorBox error={send.error ?? decide.error} />}
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { send.mutate(text.trim()); setText(''); } }}>
        <input style={{ flex: 1 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={lang === 'ar' ? 'اكتب سؤالك…' : 'Ask a question…'} maxLength={2000} />
        <button className="btn" disabled={send.isPending || !text.trim()}>{lang === 'ar' ? 'إرسال' : 'Send'}</button>
      </form>
    </div>
  );
}
