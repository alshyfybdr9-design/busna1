import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useI18n, fmtDateTime } from '../../i18n';
import { Empty, ErrorBox, Loading, Modal } from '../../components/ui';

export const ALERT_LABELS: Record<string, { ar: string; en: string }> = {
  unresolved_riders: { ar: 'طلاب لم يُسجَّل نزولهم بعد انتهاء الرحلة', en: 'Students not dropped off at trip end' },
  unrecorded_riders: { ar: 'طلاب بلا تسجيل حضور في رحلة منتهية', en: 'Students with no attendance record' },
  inspection_overdue: { ar: 'فحص خلو الباص متأخر', en: 'Bus-empty check overdue' },
  child_found: { ar: 'العثور على طفل داخل الباص', en: 'Child found on bus' },
  emergency: { ar: 'بلاغ طوارئ من السائق', en: 'Driver emergency' },
  issue: { ar: 'بلاغ مشكلة من السائق', en: 'Driver issue report' },
  location_lost: { ar: 'انقطاع الموقع أثناء الرحلة', en: 'Location lost during trip' },
};

const CATEGORY: Record<string, string> = {
  accident: 'حادث', medical: 'حالة طبية', breakdown: 'عطل', traffic: 'ازدحام', student_behavior: 'سلوك طالب',
  child_left_on_bus: 'طفل داخل الباص', other: 'أخرى', damage: 'تلف', cleanliness: 'نظافة', lost_item: 'مفقودات',
};

export function SeverityBadge({ s }: { s: string }) {
  const map: Record<string, [string, string]> = { critical: ['red', 'حرج'], high: ['amber', 'مرتفع'], medium: ['blue', 'متوسط'], low: ['gray', 'منخفض'] };
  const [cls, label] = map[s] ?? ['gray', s];
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function Alerts() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const [status, setStatus] = useState<string>('');
  const [resolving, setResolving] = useState<any>(null);
  const [note, setNote] = useState('');
  const q = useQuery({ queryKey: ['alerts', status], queryFn: () => api('GET', `/tenant/alerts${status ? `?status=${status}` : ''}`), refetchInterval: 15_000 });
  const ack = useMutation({ mutationFn: (id: string) => api('POST', `/tenant/alerts/${id}/ack`), onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }) });
  const resolve = useMutation({
    mutationFn: () => api('POST', `/tenant/alerts/${resolving.id}/resolve`, { note }),
    onSuccess: () => { setResolving(null); setNote(''); qc.invalidateQueries({ queryKey: ['alerts'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); },
  });
  return (
    <div className="card">
      <div className="row between">
        <h2>{t('alerts')}</h2>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 200 }}>
          <option value="">{lang === 'ar' ? 'الكل' : 'All'}</option>
          <option value="open">{lang === 'ar' ? 'مفتوحة' : 'Open'}</option>
          <option value="acknowledged">{lang === 'ar' ? 'قيد المتابعة' : 'Acknowledged'}</option>
          <option value="resolved">{lang === 'ar' ? 'محلولة' : 'Resolved'}</option>
        </select>
      </div>
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {q.data && (q.data.alerts.length === 0 ? <Empty /> : (
        <div className="table-wrap"><table>
          <thead><tr><th></th><th>{lang === 'ar' ? 'التنبيه' : 'Alert'}</th><th>{t('routes')}</th><th>{lang === 'ar' ? 'الوقت' : 'Time'}</th><th>{lang === 'ar' ? 'الحالة' : 'Status'}</th><th></th></tr></thead>
          <tbody>
            {q.data.alerts.map((a: any) => (
              <tr key={a.id}>
                <td><SeverityBadge s={a.severity} /></td>
                <td>
                  {ALERT_LABELS[a.kind]?.[lang] ?? a.kind}
                  {a.details?.category && <div className="small muted">{CATEGORY[a.details.category] ?? a.details.category}</div>}
                  {a.details?.students && <div className="small muted">{a.details.students.map((s: any) => s.fullName).join('، ')}</div>}
                  {a.resolutionNote && <div className="small">✓ {a.resolutionNote}</div>}
                </td>
                <td>{a.tripId ? <Link to={`/app/trips/${a.tripId}`}>{a.routeName}</Link> : '—'}</td>
                <td className="small">{fmtDateTime(a.createdAt, lang)}</td>
                <td><span className={`badge ${a.status === 'resolved' ? '' : a.status === 'open' ? 'red' : 'amber'}`}>{a.status}</span></td>
                <td className="row">
                  {a.status === 'open' && <button className="btn sm secondary" onClick={() => ack.mutate(a.id)}>{lang === 'ar' ? 'استلام' : 'Acknowledge'}</button>}
                  {a.status !== 'resolved' && <button className="btn sm" onClick={() => setResolving(a)}>{lang === 'ar' ? 'إغلاق' : 'Resolve'}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      ))}
      {resolving && (
        <Modal title={lang === 'ar' ? 'إغلاق التنبيه' : 'Resolve alert'} onClose={() => setResolving(null)}>
          <p>{ALERT_LABELS[resolving.kind]?.[lang]}</p>
          <div className="field">
            <label>{lang === 'ar' ? 'ما الإجراء المتخذ؟ (مطلوب للتوثيق)' : 'What action was taken? (required)'}</label>
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          {resolve.error && <ErrorBox error={resolve.error} />}
          <button className="btn" disabled={note.trim().length < 5 || resolve.isPending} onClick={() => resolve.mutate()}>{t('confirm')}</button>
        </Modal>
      )}
    </div>
  );
}
