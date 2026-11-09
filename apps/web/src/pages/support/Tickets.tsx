import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useI18n, fmtDateTime } from '../../i18n';
import { Empty, ErrorBox, Loading, Modal } from '../../components/ui';

export const TICKET_STATUS: Record<string, { ar: string; en: string; cls: string }> = {
  open: { ar: 'مفتوحة', en: 'Open', cls: 'red' },
  in_progress: { ar: 'قيد المعالجة', en: 'In progress', cls: 'blue' },
  waiting_user: { ar: 'بانتظار صاحب الطلب', en: 'Waiting on requester', cls: 'amber' },
  resolved: { ar: 'تم الحل', en: 'Resolved', cls: '' },
  closed: { ar: 'مغلقة', en: 'Closed', cls: 'gray' },
};
export const CATEGORY: Record<string, { ar: string; en: string }> = {
  app_usage: { ar: 'استخدام التطبيق', en: 'App usage' },
  account: { ar: 'الحساب', en: 'Account' },
  trip: { ar: 'الرحلات', en: 'Trips' },
  absence: { ar: 'الغياب', en: 'Absence' },
  payment: { ar: 'الرسوم', en: 'Fees' },
  safety: { ar: 'السلامة', en: 'Safety' },
  other: { ar: 'أخرى', en: 'Other' },
};
const PRIORITY: Record<string, { ar: string; cls: string }> = { urgent: { ar: 'عاجلة', cls: 'red' }, high: { ar: 'مرتفعة', cls: 'amber' }, normal: { ar: 'عادية', cls: 'gray' } };
const ROLE_AR: Record<string, string> = { parent: 'ولي أمر', driver: 'سائق', supervisor: 'مشرف', tenant_admin: 'مدير الجهة' };

export function StatusBadge({ s }: { s: string }) {
  const { lang } = useI18n();
  const st = TICKET_STATUS[s];
  return <span className={`badge ${st?.cls ?? 'gray'}`}>{st?.[lang] ?? s}</span>;
}

/** قائمة التذاكر — base: '/app/support' أو '/platform/support' */
export function TicketsPage({ base, platform = false }: { base: string; platform?: boolean }) {
  const { lang } = useI18n();
  const qc = useQueryClient();
  const [status, setStatus] = useState('active');
  const [scope, setScope] = useState<'queue' | 'mine'>('queue');
  const [creating, setCreating] = useState(false);
  const q = useQuery({
    queryKey: ['tickets', scope, status],
    queryFn: () => api('GET', `/support/tickets?scope=${scope}${status ? `&status=${status}` : ''}`),
    refetchInterval: 20_000,
  });
  return (
    <div className="card">
      <div className="row between">
        <h2>{platform ? (lang === 'ar' ? 'تذاكر دعم المنصة' : 'Platform support tickets') : (lang === 'ar' ? 'تذاكر الدعم' : 'Support tickets')}</h2>
        <div className="row">
          {!platform && (
            <select value={scope} onChange={(e) => setScope(e.target.value as any)} style={{ width: 190 }}>
              <option value="queue">{lang === 'ar' ? 'طابور الجهة' : 'Organization queue'}</option>
              <option value="mine">{lang === 'ar' ? 'تذاكري لدعم باصنا' : 'My tickets to Busna'}</option>
            </select>
          )}
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 170 }}>
            <option value="active">{lang === 'ar' ? 'النشطة' : 'Active'}</option>
            <option value="">{lang === 'ar' ? 'الكل' : 'All'}</option>
            {Object.entries(TICKET_STATUS).map(([k, v]) => <option key={k} value={k}>{v[lang]}</option>)}
          </select>
          {!platform && <button className="btn secondary" onClick={() => setCreating(true)}>{lang === 'ar' ? 'تواصل مع دعم باصنا' : 'Contact Busna support'}</button>}
        </div>
      </div>
      {!platform && scope === 'queue' && (
        <p className="small muted">{lang === 'ar' ? 'هنا طلبات أولياء الأمور والسائقين الخاصة بتشغيل النقل. مشاكل استخدام التطبيق تُحوَّل تلقائيًا لدعم منصة باصنا.' : 'Transport-operations requests from parents and drivers. App-usage issues are routed to Busna platform support.'}</p>
      )}
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (q.data.tickets.length === 0 ? <Empty /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>#</th><th>{lang === 'ar' ? 'الموضوع' : 'Subject'}</th><th>{lang === 'ar' ? 'التصنيف' : 'Category'}</th>{scope === 'queue' && <th>{lang === 'ar' ? 'صاحب الطلب' : 'Requester'}</th>}<th>{lang === 'ar' ? 'الحالة' : 'Status'}</th><th>{lang === 'ar' ? 'آخر نشاط' : 'Last activity'}</th></tr></thead>
          <tbody>{q.data.tickets.map((t: any) => (
            <tr key={t.id}>
              <td>{t.ref}</td>
              <td>
                <Link to={`${base}/${t.id}`}>{t.subject}</Link>
                {t.priority !== 'normal' && <> <span className={`badge ${PRIORITY[t.priority].cls}`}>{PRIORITY[t.priority].ar}</span></>}
                {t.source === 'assistant' && <> <span className="badge blue">{lang === 'ar' ? 'من المساعد' : 'via assistant'}</span></>}
              </td>
              <td>{CATEGORY[t.category]?.[lang]}</td>
              {scope === 'queue' && <td>{t.requesterName ?? '—'}<div className="small muted">{ROLE_AR[t.requesterRole] ?? t.requesterRole}{platform && ` · ${t.tenantName}`}</div></td>}
              <td><StatusBadge s={t.status} /></td>
              <td className="small">{fmtDateTime(t.lastActivityAt, lang)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ))}
      {creating && <NewTicketModal onClose={() => setCreating(false)} onDone={() => { setCreating(false); setScope('mine'); qc.invalidateQueries({ queryKey: ['tickets'] }); }} />}
    </div>
  );
}

function NewTicketModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { lang } = useI18n();
  const [f, setF] = useState({ category: 'app_usage', subject: '', body: '' });
  const m = useMutation({ mutationFn: () => api('POST', '/support/tickets', { ...f, source: 'web' }), onSuccess: onDone });
  return (
    <Modal title={lang === 'ar' ? 'تذكرة إلى دعم منصة باصنا' : 'Ticket to Busna support'} onClose={onClose}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
        <div className="field"><label>{lang === 'ar' ? 'التصنيف' : 'Category'}</label>
          <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            <option value="app_usage">{CATEGORY.app_usage[lang]}</option><option value="account">{CATEGORY.account[lang]}</option>
          </select></div>
        <div className="field"><label>{lang === 'ar' ? 'الموضوع' : 'Subject'}</label><input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} required minLength={3} /></div>
        <div className="field"><label>{lang === 'ar' ? 'التفاصيل' : 'Details'}</label><textarea rows={5} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} required minLength={3} /></div>
        {m.error && <ErrorBox error={m.error} />}
        <button className="btn" disabled={m.isPending}>{lang === 'ar' ? 'إرسال' : 'Send'}</button>
      </form>
    </Modal>
  );
}

export function TicketDetailPage({ base }: { base: string }) {
  const { id = '' } = useParams();
  const { lang } = useI18n();
  const qc = useQueryClient();
  const [reply, setReply] = useState('');
  const [internal, setInternal] = useState(false);
  const q = useQuery({ queryKey: ['ticket', id], queryFn: () => api('GET', `/support/tickets/${id}`), refetchInterval: 15_000 });
  const inv = () => { qc.invalidateQueries({ queryKey: ['ticket', id] }); qc.invalidateQueries({ queryKey: ['tickets'] }); };
  const send = useMutation({ mutationFn: () => api('POST', `/support/tickets/${id}/messages`, { body: reply, internal }), onSuccess: () => { setReply(''); setInternal(false); inv(); } });
  const patch = useMutation({ mutationFn: (body: any) => api('PATCH', `/support/tickets/${id}`, body), onSuccess: inv });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const { ticket: t, messages } = q.data;
  const kindLabel: Record<string, string> = { requester: lang === 'ar' ? 'صاحب الطلب' : 'Requester', agent: lang === 'ar' ? 'الدعم' : 'Support', assistant: lang === 'ar' ? 'المساعد' : 'Assistant', system: lang === 'ar' ? 'النظام' : 'System' };
  return (
    <div className="stack">
      <Link to={base}>← {lang === 'ar' ? 'التذاكر' : 'Tickets'}</Link>
      <div className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>#{t.ref} — {t.subject}</h2>
          <StatusBadge s={t.status} />
        </div>
        <div className="small muted" style={{ marginTop: 6 }}>
          {CATEGORY[t.category]?.[lang]} · {t.requesterName ?? '—'} ({ROLE_AR[t.requesterRole] ?? t.requesterRole}) · {t.tenantName}
          {t.studentName && ` · ${lang === 'ar' ? 'الطالب' : 'Student'}: ${t.studentName}`} · {fmtDateTime(t.createdAt, lang)}
          {t.source === 'assistant' && ` · ${lang === 'ar' ? 'أُنشئت عبر المساعد' : 'created via assistant'}`}
        </div>
        {t.isAgent && (
          <div className="row" style={{ marginTop: 10 }}>
            <label className="small">{lang === 'ar' ? 'الحالة' : 'Status'}</label>
            <select value={t.status} onChange={(e) => patch.mutate({ status: e.target.value })} style={{ width: 200 }}>
              {Object.entries(TICKET_STATUS).map(([k, v]) => <option key={k} value={k}>{v[lang]}</option>)}
            </select>
            <label className="small">{lang === 'ar' ? 'الأولوية' : 'Priority'}</label>
            <select value={t.priority} onChange={(e) => patch.mutate({ priority: e.target.value })} style={{ width: 140 }}>
              {Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v.ar}</option>)}
            </select>
            <button className="btn sm secondary" onClick={() => patch.mutate({ assignToMe: true })}>{lang === 'ar' ? 'إسنادها لي' : 'Assign to me'}</button>
          </div>
        )}
        {patch.error && <ErrorBox error={patch.error} />}
      </div>
      <div className="card stack">
        {messages.map((m: any) => (
          <div key={m.id} className={`alert ${m.internal ? 'warn' : m.authorKind === 'agent' ? 'info' : ''}`} style={m.authorKind === 'requester' ? { background: '#fff', borderColor: 'var(--line)', color: 'var(--ink)' } : undefined}>
            <div className="small" style={{ fontWeight: 600 }}>
              {m.internal ? (lang === 'ar' ? '🔒 ملاحظة داخلية' : '🔒 Internal note') : kindLabel[m.authorKind]}{m.authorName ? ` — ${m.authorName}` : ''} · {fmtDateTime(m.createdAt, lang)}
            </div>
            <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{m.body}</div>
          </div>
        ))}
        {t.status !== 'closed' ? (
          <form onSubmit={(e) => { e.preventDefault(); send.mutate(); }} className="stack">
            <textarea rows={3} value={reply} onChange={(e) => setReply(e.target.value)} placeholder={lang === 'ar' ? 'اكتب ردك…' : 'Write a reply…'} />
            <div className="row">
              {t.isAgent && (
                <label className="row small"><input type="checkbox" style={{ width: 'auto', minHeight: 0 }} checked={internal} onChange={(e) => setInternal(e.target.checked)} />{lang === 'ar' ? 'ملاحظة داخلية (لا يراها صاحب الطلب)' : 'Internal note'}</label>
              )}
              <button className="btn" disabled={!reply.trim() || send.isPending}>{lang === 'ar' ? 'إرسال' : 'Send'}</button>
            </div>
            {send.error && <ErrorBox error={send.error} />}
          </form>
        ) : <div className="muted small">{lang === 'ar' ? 'التذكرة مغلقة.' : 'Ticket closed.'}</div>}
      </div>
    </div>
  );
}
