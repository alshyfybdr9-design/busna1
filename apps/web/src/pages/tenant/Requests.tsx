import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useI18n, fmtDateTime } from '../../i18n';
import { Empty, ErrorBox, Loading, Modal } from '../../components/ui';
import { StatusBadge } from './Students';
import { useSession, currentMembership } from '../../session';

const DIR: Record<string, [string, string]> = {
  to_school: ['الذهاب', 'To school'], from_school: ['العودة', 'From school'], both: ['الذهاب والعودة', 'Both'],
};

/** طلبات أولياء الأمور لتغيير العنوان / نقطة التوقف */
export function StopChangeRequests() {
  const { lang } = useI18n();
  const { session } = useSession();
  const canReview = ['tenant_admin', 'supervisor'].includes(currentMembership(session)?.role ?? '');
  const [status, setStatus] = useState('pending');
  const [reviewing, setReviewing] = useState<any>(null);
  const q = useQuery({ queryKey: ['stop-changes', status], queryFn: () => api('GET', `/tenant/stop-changes?status=${status}`) });
  const L = (x: [string, string]) => (lang === 'ar' ? x[0] : x[1]);
  return (
    <div className="card">
      <div className="row between">
        <div>
          <h2 style={{ marginBottom: 4 }}>{lang === 'ar' ? 'طلبات تغيير العنوان' : 'Address change requests'}</h2>
          <div className="small muted">{lang === 'ar' ? 'يرسلها ولي الأمر من التطبيق (دائم أو مؤقت حتى 60 يومًا). عند الاعتماد تحدد المسار ونقطة التوقف.' : 'Sent by parents from the app. Choose the route and stop when approving.'}</div>
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 200 }}>
          <option value="pending">{lang === 'ar' ? 'بانتظار المراجعة' : 'Pending'}</option>
          <option value="approved">{lang === 'ar' ? 'معتمدة' : 'Approved'}</option>
          <option value="rejected">{lang === 'ar' ? 'مرفوضة' : 'Rejected'}</option>
          <option value="cancelled">{lang === 'ar' ? 'ملغاة' : 'Cancelled'}</option>
        </select>
      </div>
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (q.data.requests.length === 0 ? <Empty>{lang === 'ar' ? 'لا توجد طلبات' : 'No requests'}</Empty> : (
        <div className="table-wrap"><table>
          <thead><tr>
            <th>{lang === 'ar' ? 'الطالب' : 'Student'}</th><th>{lang === 'ar' ? 'الطلب' : 'Request'}</th><th>{lang === 'ar' ? 'العنوان الجديد' : 'New address'}</th>
            <th>{lang === 'ar' ? 'التعيين الحالي' : 'Current'}</th><th>{lang === 'ar' ? 'مقدم الطلب' : 'Requested by'}</th><th></th>
          </tr></thead>
          <tbody>{q.data.requests.map((r: any) => (
            <tr key={r.id}>
              <td><Link to={`/app/students/${r.studentId}`}>{r.studentName}</Link><div className="small muted">{r.grade ?? ''}</div></td>
              <td>
                <span className={`badge ${r.kind === 'temporary' ? 'blue' : ''}`}>{r.kind === 'temporary' ? (lang === 'ar' ? 'مؤقت' : 'Temporary') : (lang === 'ar' ? 'دائم' : 'Permanent')}</span>
                <div className="small">{L(DIR[r.direction])}</div>
                <div className="small muted">{lang === 'ar' ? 'من' : 'From'} {r.startDate}{r.endDate ? ` ${lang === 'ar' ? 'إلى' : 'to'} ${r.endDate}` : ''}</div>
              </td>
              <td>{r.address}
                {r.lat != null && <div><a className="small" target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${r.lat}&mlon=${r.lng}#map=17/${r.lat}/${r.lng}`}>{lang === 'ar' ? 'عرض الموقع على الخريطة' : 'View on map'}</a></div>}
                {r.note && <div className="small muted">{r.note}</div>}</td>
              <td className="small">{(r.currentRoutes ?? []).map((c: any) => <div key={c.routeId}>{c.routeName} · {c.stopName}</div>)}{!r.currentRoutes && '—'}</td>
              <td className="small">{r.requestedBy}<div className="muted" dir="ltr">{r.requesterPhone ?? ''}</div><div className="muted">{fmtDateTime(r.createdAt, lang)}</div></td>
              <td>{r.status === 'pending' && canReview
                ? <button className="btn sm" onClick={() => setReviewing(r)}>{lang === 'ar' ? 'مراجعة' : 'Review'}</button>
                : <><StatusBadge status={r.status} />{r.reviewNote && <div className="small muted">{r.reviewNote}</div>}</>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ))}
      {reviewing && <ReviewModal request={reviewing} onClose={() => setReviewing(null)} />}
    </div>
  );
}

function StopPicker({ direction, value, onChange }: { direction: 'to_school' | 'from_school'; value: { routeId: string; stopId: string }; onChange: (v: { routeId: string; stopId: string }) => void }) {
  const { lang } = useI18n();
  const routes = useQuery({ queryKey: ['routes'], queryFn: () => api('GET', '/tenant/routes') });
  const detail = useQuery({ queryKey: ['route', value.routeId], queryFn: () => api('GET', `/tenant/routes/${value.routeId}`), enabled: !!value.routeId });
  const list = (routes.data?.routes ?? []).filter((r: any) => r.direction === direction && r.status === 'active');
  return (
    <div className="row" style={{ alignItems: 'flex-end' }}>
      <div className="field" style={{ flex: 1 }}>
        <label>{lang === 'ar' ? `مسار ${DIR[direction][0]}` : `${DIR[direction][1]} route`}</label>
        <select value={value.routeId} onChange={(e) => onChange({ routeId: e.target.value, stopId: '' })}>
          <option value="">—</option>
          {list.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>
      <div className="field" style={{ flex: 1 }}>
        <label>{lang === 'ar' ? 'نقطة التوقف' : 'Stop'}</label>
        <select value={value.stopId} onChange={(e) => onChange({ ...value, stopId: e.target.value })} disabled={!value.routeId}>
          <option value="">—</option>
          {(detail.data?.stops ?? []).filter((s: any) => s.kind === 'stop').map((s: any) => <option key={s.id} value={s.id}>{s.seq}. {s.name}</option>)}
        </select>
      </div>
    </div>
  );
}

function ReviewModal({ request: r, onClose }: { request: any; onClose: () => void }) {
  const { lang } = useI18n();
  const qc = useQueryClient();
  const dirs: Array<'to_school' | 'from_school'> = r.direction === 'both' ? ['to_school', 'from_school'] : [r.direction];
  const current = (d: string) => (r.currentRoutes ?? []).find((c: any) => c.direction === d);
  const [sel, setSel] = useState<Record<string, { routeId: string; stopId: string }>>(
    Object.fromEntries(dirs.map((d) => [d, { routeId: current(d)?.routeId ?? '', stopId: '' }])),
  );
  const [note, setNote] = useState('');
  const done = () => { qc.invalidateQueries({ queryKey: ['stop-changes'] }); onClose(); };
  const decide = useMutation({
    mutationFn: (decision: 'approved' | 'rejected') => api('POST', `/tenant/stop-changes/${r.id}/review`, {
      decision, note: note || null,
      assignments: decision === 'approved' ? dirs.map((d) => ({ direction: d, ...sel[d] })) : [],
    }),
    onSuccess: done,
  });
  const complete = dirs.every((d) => sel[d].routeId && sel[d].stopId);
  return (
    <Modal title={`${lang === 'ar' ? 'مراجعة طلب' : 'Review'}: ${r.studentName}`} onClose={onClose}>
      <div className="stack">
        <div className="alert info">
          <strong>{r.kind === 'temporary' ? (lang === 'ar' ? 'تغيير مؤقت' : 'Temporary change') : (lang === 'ar' ? 'تغيير دائم' : 'Permanent change')}</strong>
          {' · '}{lang === 'ar' ? DIR[r.direction][0] : DIR[r.direction][1]}
          <div>{r.address}</div>
          <div className="small">{lang === 'ar' ? 'من' : 'From'} {r.startDate}{r.endDate ? ` ${lang === 'ar' ? 'إلى' : 'to'} ${r.endDate}` : ''}</div>
          {r.lat != null && <a className="small" target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${r.lat}&mlon=${r.lng}#map=17/${r.lat}/${r.lng}`}>{lang === 'ar' ? 'الموقع الذي حدده ولي الأمر' : 'Pinned location'}</a>}
        </div>
        <p className="small muted" style={{ margin: 0 }}>{r.kind === 'temporary'
          ? (lang === 'ar' ? 'يُطبّق على رحلات الفترة فقط، ويعود الطالب لتعيينه المعتاد بعدها تلقائيًا.' : 'Applies to trips in the period only.')
          : (lang === 'ar' ? 'يُحدّث التعيين الدائم فورًا، ويُطبّق على الرحلات المجدولة التي لم تبدأ.' : 'Updates the regular assignment immediately.')}
          {' '}{lang === 'ar' ? 'إن لم تجد نقطة مناسبة، أضفها أولًا من صفحة المسار.' : 'Add a stop on the route page if needed.'}</p>
        {dirs.map((d) => (
          <div key={d}>
            {current(d) && <div className="small muted">{lang === 'ar' ? 'الحالي' : 'Current'}: {current(d).routeName} · {current(d).stopName}</div>}
            <StopPicker direction={d} value={sel[d]} onChange={(v) => setSel({ ...sel, [d]: v })} />
          </div>
        ))}
        <div className="field"><label>{lang === 'ar' ? 'ملاحظة لولي الأمر (اختياري)' : 'Note to parent (optional)'}</label><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></div>
        {decide.error && <ErrorBox error={decide.error} />}
        <div className="row">
          <button className="btn" disabled={!complete || decide.isPending} onClick={() => decide.mutate('approved')}>{lang === 'ar' ? 'اعتماد' : 'Approve'}</button>
          <button className="btn secondary" disabled={decide.isPending} onClick={() => decide.mutate('rejected')}>{lang === 'ar' ? 'رفض' : 'Reject'}</button>
        </div>
      </div>
    </Modal>
  );
}
