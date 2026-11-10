import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useI18n, fmtDateTime } from '../../i18n';
import { Empty, ErrorBox, Loading, Modal } from '../../components/ui';
import { useSession, currentMembership } from '../../session';

export const CATEGORY_LABEL: Record<string, [string, string]> = {
  delay: ['تأخير', 'Delay'],
  breakdown: ['عطل باص', 'Breakdown'],
  route_change: ['تغيير مسار', 'Route change'],
  weather: ['ظروف جوية', 'Weather'],
  early_dismissal: ['خروج مبكر', 'Early dismissal'],
  general: ['إعلان عام', 'General'],
};

const TEMPLATES: Record<string, { title: string; body: string }> = {
  delay: { title: 'تأخير في رحلة اليوم', body: 'نعتذر، ستتأخر الرحلة اليوم بسبب الازدحام. أبناؤكم بأمان، وسنوافيكم بأي مستجدات.' },
  breakdown: { title: 'عطل في الباص', body: 'تعطّل الباص أثناء الرحلة، والطلاب بأمان مع السائق. يجري إرسال باص بديل وسنوافيكم بالمستجدات.' },
  route_change: { title: 'تغيير مؤقت في المسار', body: 'بسبب أعمال طرق سيتغير مسار الباص اليوم، وقد تتغير أوقات الوصول قليلًا.' },
  weather: { title: 'تنبيه بسبب الأحوال الجوية', body: 'بسبب الأحوال الجوية قد تتأخر الرحلات اليوم. نرجو تجهيز الطلاب في الموعد المعتاد والمتابعة عبر التطبيق.' },
  early_dismissal: { title: 'خروج مبكر اليوم', body: 'ستبدأ رحلة العودة اليوم مبكرًا الساعة __:__. نرجو التواجد عند نقطة النزول.' },
  general: { title: '', body: '' },
};

const AUDIENCE_LABEL: Record<string, [string, string]> = {
  all_parents: ['كل أولياء الأمور', 'All parents'],
  routes: ['أولياء أمور مسارات محددة', 'Parents of selected routes'],
  trips: ['أولياء أمور رحلات اليوم المحددة', 'Parents of selected trips today'],
  drivers: ['السائقون', 'Drivers'],
  everyone: ['الجميع (أولياء الأمور والسائقون)', 'Everyone'],
};

export function Messages() {
  const { lang } = useI18n();
  const { session } = useSession();
  const canSend = ['tenant_admin', 'supervisor'].includes(currentMembership(session)?.role ?? '');
  const [composing, setComposing] = useState(false);
  const q = useQuery({ queryKey: ['broadcasts'], queryFn: () => api('GET', '/tenant/broadcasts'), refetchInterval: 15_000 });
  const L = (x: [string, string] | undefined, fallback: string) => (x ? (lang === 'ar' ? x[0] : x[1]) : fallback);
  return (
    <div className="card">
      <div className="row between">
        <div>
          <h2 style={{ marginBottom: 4 }}>{lang === 'ar' ? 'الرسائل الجماعية' : 'Broadcast messages'}</h2>
          <div className="small muted">{lang === 'ar' ? 'تصل إشعارًا في تطبيق أولياء الأمور أو السائقين. نص شاشة القفل عام ولا يحتوي تفاصيل.' : 'Delivered as in-app notifications. Lock-screen text stays generic.'}</div>
        </div>
        {canSend && <button className="btn" onClick={() => setComposing(true)}>+ {lang === 'ar' ? 'رسالة جديدة' : 'New message'}</button>}
      </div>
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (q.data.broadcasts.length === 0 ? <Empty>{lang === 'ar' ? 'لم تُرسل رسائل بعد' : 'No messages yet'}</Empty> : (
        <div className="table-wrap"><table>
          <thead><tr>
            <th>{lang === 'ar' ? 'الوقت' : 'Time'}</th><th>{lang === 'ar' ? 'النوع' : 'Type'}</th><th>{lang === 'ar' ? 'الرسالة' : 'Message'}</th>
            <th>{lang === 'ar' ? 'المستلمون' : 'Recipients'}</th><th>{lang === 'ar' ? 'المرسل' : 'Sent by'}</th>
          </tr></thead>
          <tbody>{q.data.broadcasts.map((b: any) => (
            <tr key={b.id}>
              <td className="small">{fmtDateTime(b.createdAt, lang)}</td>
              <td><span className={`badge ${b.category === 'delay' || b.category === 'breakdown' ? 'amber' : 'blue'}`}>{L(CATEGORY_LABEL[b.category], b.category)}</span></td>
              <td><strong>{b.title}</strong><div className="small muted" style={{ whiteSpace: 'pre-wrap' }}>{b.body}</div>
                {b.delayMinutes && <div className="small">{lang === 'ar' ? `التأخير المتوقع: ${b.delayMinutes} دقيقة` : `Expected delay: ${b.delayMinutes} min`}</div>}</td>
              <td className="small">{L(AUDIENCE_LABEL[b.audience], b.audience)}
                <div className="muted">{b.recipientCount == null ? (lang === 'ar' ? 'جارٍ الإرسال…' : 'Sending…') : `${b.recipientCount} ${lang === 'ar' ? 'مستلم' : 'recipients'}`}</div></td>
              <td className="small">{b.createdBy}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ))}
      {composing && <ComposeModal onClose={() => setComposing(false)} />}
    </div>
  );
}

export function ComposeModal({ onClose, preset }: { onClose: () => void; preset?: { audience: string; tripIds?: string[]; routeIds?: string[]; category?: string; label?: string } }) {
  const { lang } = useI18n();
  const qc = useQueryClient();
  const initialCat = preset?.category ?? 'delay';
  const [f, setF] = useState({
    audience: preset?.audience ?? 'routes',
    routeIds: preset?.routeIds ?? ([] as string[]),
    tripIds: preset?.tripIds ?? ([] as string[]),
    category: initialCat,
    title: TEMPLATES[initialCat].title,
    body: TEMPLATES[initialCat].body,
    delayMinutes: '' as string,
  });
  const routes = useQuery({ queryKey: ['routes'], queryFn: () => api('GET', '/tenant/routes'), enabled: f.audience === 'routes' && !preset });
  const trips = useQuery({ queryKey: ['trips', 'today'], queryFn: () => api('GET', '/tenant/trips'), enabled: f.audience === 'trips' && !preset });
  const send = useMutation({
    mutationFn: () => api('POST', '/tenant/broadcasts', {
      audience: f.audience, routeIds: f.audience === 'routes' ? f.routeIds : [], tripIds: f.audience === 'trips' ? f.tripIds : [],
      category: f.category, title: f.title, body: f.body, delayMinutes: f.category === 'delay' && f.delayMinutes ? Number(f.delayMinutes) : null,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['broadcasts'] }); onClose(); },
  });
  const pickCategory = (c: string) => {
    const changedByUser = f.title !== TEMPLATES[f.category].title || f.body !== TEMPLATES[f.category].body;
    setF({ ...f, category: c, ...(changedByUser ? {} : TEMPLATES[c]) });
  };
  const toggle = (k: 'routeIds' | 'tripIds', id: string) =>
    setF({ ...f, [k]: f[k].includes(id) ? f[k].filter((x) => x !== id) : [...f[k], id] });
  const missingTarget = (f.audience === 'routes' && f.routeIds.length === 0) || (f.audience === 'trips' && f.tripIds.length === 0);
  return (
    <Modal title={lang === 'ar' ? 'رسالة جماعية' : 'Broadcast message'} onClose={onClose}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (confirm(lang === 'ar' ? 'إرسال الرسالة الآن؟ لا يمكن سحبها بعد الإرسال.' : 'Send now? It cannot be recalled.')) send.mutate(); }}>
        {preset ? (
          <div className="alert info">{lang === 'ar' ? 'إلى' : 'To'}: {preset.label ?? AUDIENCE_LABEL[preset.audience]?.[lang === 'ar' ? 0 : 1]}</div>
        ) : (
          <div className="field"><label>{lang === 'ar' ? 'إلى' : 'To'}</label>
            <select value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })}>
              {Object.entries(AUDIENCE_LABEL).map(([k, v]) => <option key={k} value={k}>{lang === 'ar' ? v[0] : v[1]}</option>)}
            </select>
          </div>
        )}
        {!preset && f.audience === 'routes' && (
          <div className="field"><label>{lang === 'ar' ? 'المسارات' : 'Routes'}</label>
            {routes.isLoading && <Loading />}
            <div className="stack" style={{ gap: 4, maxHeight: 180, overflow: 'auto' }}>
              {(routes.data?.routes ?? []).filter((r: any) => r.status === 'active').map((r: any) => (
                <label key={r.id} className="row"><input type="checkbox" style={{ width: 'auto', minHeight: 0 }} checked={f.routeIds.includes(r.id)} onChange={() => toggle('routeIds', r.id)} />
                  {r.name} <span className="small muted">({r.riderCount} {lang === 'ar' ? 'طالب' : 'students'})</span></label>
              ))}
            </div>
          </div>
        )}
        {!preset && f.audience === 'trips' && (
          <div className="field"><label>{lang === 'ar' ? 'رحلات اليوم' : 'Today’s trips'}</label>
            {trips.isLoading && <Loading />}
            {trips.data?.trips.length === 0 && <div className="small muted">{lang === 'ar' ? 'لا توجد رحلات اليوم' : 'No trips today'}</div>}
            <div className="stack" style={{ gap: 4, maxHeight: 180, overflow: 'auto' }}>
              {(trips.data?.trips ?? []).filter((t: any) => t.status !== 'cancelled').map((t: any) => (
                <label key={t.id} className="row"><input type="checkbox" style={{ width: 'auto', minHeight: 0 }} checked={f.tripIds.includes(t.id)} onChange={() => toggle('tripIds', t.id)} />
                  {t.routeName} <span className="small muted">{t.busLabel ?? t.busPlate ?? ''}</span></label>
              ))}
            </div>
          </div>
        )}
        <div className="field"><label>{lang === 'ar' ? 'النوع' : 'Type'}</label>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
              <button type="button" key={k} className={`btn sm ${f.category === k ? '' : 'secondary'}`} onClick={() => pickCategory(k)}>{lang === 'ar' ? v[0] : v[1]}</button>
            ))}
          </div>
        </div>
        <div className="field"><label>{lang === 'ar' ? 'العنوان *' : 'Title *'}</label><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required minLength={2} maxLength={120} /></div>
        <div className="field"><label>{lang === 'ar' ? 'النص *' : 'Message *'}</label><textarea rows={4} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} required minLength={2} maxLength={1000} />
          <span className="hint">{lang === 'ar' ? 'لا تكتب أسماء طلاب أو بيانات حساسة في الرسائل الجماعية.' : 'Do not include student names or sensitive data.'}</span></div>
        {f.category === 'delay' && (
          <div className="field"><label>{lang === 'ar' ? 'التأخير المتوقع (دقائق، اختياري)' : 'Expected delay (min, optional)'}</label>
            <input type="number" min={1} max={240} value={f.delayMinutes} onChange={(e) => setF({ ...f, delayMinutes: e.target.value })} style={{ width: 140 }} /></div>
        )}
        <div className="msg-preview">
          <div className="small muted">{lang === 'ar' ? 'هكذا تظهر في التطبيق:' : 'In-app preview:'}</div>
          <strong>{f.category !== 'general' ? `${CATEGORY_LABEL[f.category][0]}: ` : ''}{f.title || '…'}</strong>
          <div style={{ whiteSpace: 'pre-wrap' }}>{f.body || '…'}{f.category === 'delay' && f.delayMinutes ? `\n(التأخير المتوقع: نحو ${f.delayMinutes} دقيقة)` : ''}</div>
        </div>
        {send.error && <ErrorBox error={send.error} />}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" disabled={send.isPending || missingTarget}>{lang === 'ar' ? 'إرسال' : 'Send'}</button>
          {missingTarget && <span className="small muted">{lang === 'ar' ? 'اختر مسارًا أو رحلة واحدة على الأقل' : 'Pick at least one'}</span>}
        </div>
      </form>
    </Modal>
  );
}
