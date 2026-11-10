import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { ComposeModal } from './Messages';
import { useI18n, fmtTime, fmtDateTime } from '../../i18n';
import { Empty, ErrorBox, Freshness, Loading, Modal, RiderStatus, TripStatus } from '../../components/ui';
import { MapView } from '../../components/MapView';
import { ALERT_LABELS, SeverityBadge } from './Alerts';

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());

export function Trips() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const [date, setDate] = useState(today());
  const [creating, setCreating] = useState(false);
  const [routeId, setRouteId] = useState('');
  const q = useQuery({ queryKey: ['trips', date], queryFn: () => api('GET', `/tenant/trips?date=${date}`), refetchInterval: 15_000 });
  const routes = useQuery({ queryKey: ['routes'], queryFn: () => api('GET', '/tenant/routes') });
  const gen = useMutation({ mutationFn: () => api('POST', '/tenant/trips/generate', { date }), onSuccess: () => qc.invalidateQueries({ queryKey: ['trips'] }) });
  const create = useMutation({ mutationFn: () => api('POST', '/tenant/trips', { routeId, date }), onSuccess: () => { setCreating(false); qc.invalidateQueries({ queryKey: ['trips'] }); } });
  return (
    <div className="card">
      <div className="row between">
        <h2>{t('trips')}</h2>
        <div className="row">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 170 }} />
          <button className="btn secondary" onClick={() => gen.mutate()} disabled={gen.isPending}>{lang === 'ar' ? 'توليد من الجداول' : 'Generate from schedules'}</button>
          <button className="btn" onClick={() => setCreating(true)}>+ {lang === 'ar' ? 'رحلة' : 'Trip'}</button>
        </div>
      </div>
      {gen.data && <div className="alert info" style={{ marginBottom: 12 }}>{lang === 'ar' ? `أُنشئت ${gen.data.created.length} رحلة` : `Created ${gen.data.created.length} trip(s)`}{gen.data.skipped.length ? ` · ${lang === 'ar' ? 'تُخطّي' : 'skipped'} ${gen.data.skipped.length} (${[...new Set(gen.data.skipped.map((s: any) => s.reason))].join(', ')})` : ''}</div>}
      {gen.error && <ErrorBox error={gen.error} />}
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (q.data.trips.length === 0 ? <Empty /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>{lang === 'ar' ? 'المسار' : 'Route'}</th><th>{lang === 'ar' ? 'الموعد' : 'Planned'}</th><th>{lang === 'ar' ? 'الحالة' : 'Status'}</th><th>{lang === 'ar' ? 'الحضور' : 'Riders'}</th><th>{lang === 'ar' ? 'الفحص' : 'Check'}</th></tr></thead>
          <tbody>{q.data.trips.map((x: any) => (
            <tr key={x.id}>
              <td><Link to={`/app/trips/${x.id}`}>{x.routeName}</Link><div className="small muted">{t(`dir_${x.direction}` as any)} · {x.driverName} · {x.busLabel ?? x.busPlate}</div></td>
              <td>{fmtTime(x.plannedStart, lang)}</td>
              <td><TripStatus status={x.status} /></td>
              <td className="small">{x.counts ? Object.entries(x.counts).map(([k, v]) => `${t(`rider_${k}` as any)}: ${v}`).join(' · ') : '—'}</td>
              <td>{x.inspectionStatus !== 'not_required' && <span className={`badge ${x.inspectionStatus === 'completed' ? '' : x.inspectionStatus === 'pending' ? 'amber' : 'red'}`}>{t(`insp_${x.inspectionStatus}` as any)}</span>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ))}
      {creating && (
        <Modal title={lang === 'ar' ? 'إنشاء رحلة' : 'Create trip'} onClose={() => setCreating(false)}>
          <div className="field"><label>{t('routes')}</label>
            <select value={routeId} onChange={(e) => setRouteId(e.target.value)}>
              <option value="">—</option>
              {(routes.data?.routes ?? []).filter((r: any) => r.status === 'active').map((r: any) => <option key={r.id} value={r.id}>{r.name} ({t(`dir_${r.direction}` as any)})</option>)}
            </select></div>
          <div className="muted small">{lang === 'ar' ? 'التاريخ:' : 'Date:'} {date}. {lang === 'ar' ? 'تُنسخ قائمة الطلاب من المسار، ويُعلَّم الغائبون (غياب معتمد) تلقائيًا.' : 'Riders are copied from the route; approved absences are applied.'}</div>
          {create.error && <ErrorBox error={create.error} />}
          <button className="btn" style={{ marginTop: 12 }} disabled={!routeId || create.isPending} onClick={() => create.mutate()}>{t('confirm')}</button>
        </Modal>
      )}
    </div>
  );
}

const CHECK_LABEL: Record<string, { ar: string; en: string }> = {
  walkedToRear: { ar: 'مشى حتى آخر الباص', en: 'Walked to the rear' },
  checkedSeats: { ar: 'فحص كل المقاعد', en: 'Checked every seat' },
  checkedUnderSeats: { ar: 'فحص أسفل المقاعد', en: 'Checked under seats' },
  checkedBackRow: { ar: 'فحص الصف الأخير', en: 'Checked back row' },
  noBelongingsLeft: { ar: 'لا أغراض متروكة', en: 'No belongings left' },
  rearScanVerified: { ar: 'مسح رمز مؤخرة الباص', en: 'Rear-of-bus code scanned' },
};

const EVENT_LABEL: Record<string, string> = { boarded: 'صعود', alighted: 'نزول', absent: 'غياب', no_show: 'لم يحضر', correction: 'تصحيح' };

export function TripDetail() {
  const { id = '' } = useParams();
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['trip', id], queryFn: () => api('GET', `/tenant/trips/${id}`), refetchInterval: (query) => (query.state.data?.trip?.status === 'in_progress' ? 10_000 : false) });
  const [correcting, setCorrecting] = useState<any>(null);
  const [corr, setCorr] = useState({ status: 'boarded', reason: '' });
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [messaging, setMessaging] = useState(false);
  const inv = () => qc.invalidateQueries({ queryKey: ['trip', id] });
  const correct = useMutation({ mutationFn: () => api('POST', `/tenant/trips/${id}/riders/${correcting.id}/correct`, corr), onSuccess: () => { setCorrecting(null); setCorr({ status: 'boarded', reason: '' }); inv(); } });
  const verify = useMutation({ mutationFn: () => api('POST', `/tenant/trips/${id}/inspection/verify`, {}), onSuccess: inv });
  const cancel = useMutation({ mutationFn: () => api('POST', `/tenant/trips/${id}/cancel`, { reason: cancelReason }), onSuccess: () => { setCancelling(false); inv(); } });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const { trip, stops, riders, events, trail, inspection, alerts, counts, location } = q.data;
  const markers = [
    ...stops.map((s: any) => ({ id: s.id, lat: s.lat, lng: s.lng, label: s.kind === 'school' ? '🏫' : `${s.seq}`, color: s.kind === 'school' ? '#1d4ed8' : '#64748b', popup: s.name })),
    ...(location && trip.status === 'in_progress' ? [{ id: 'bus', lat: location.lat, lng: location.lng, label: `🚌 ${trip.busLabel ?? ''}`, color: location.isStale ? '#a16207' : '#16a34a' }] : []),
  ];
  return (
    <div className="stack">
      <Link to="/app/trips">← {t('trips')}</Link>
      <div className="card">
        <div className="row between">
          <div>
            <h2 style={{ marginBottom: 4 }}>{trip.routeName}</h2>
            <div className="muted small">{trip.serviceDate} · {t(`dir_${trip.direction}` as any)} · {trip.driverName} <span dir="ltr">{trip.driverPhone}</span> · {trip.busLabel ?? trip.busPlate}</div>
          </div>
          <div className="row">
            <TripStatus status={trip.status} />
            {trip.status === 'in_progress' && <Freshness location={location} />}
            {(trip.status === 'scheduled' || trip.status === 'in_progress') && <button className="btn sm secondary" onClick={() => setMessaging(true)}>{lang === 'ar' ? 'رسالة لأولياء الأمور' : 'Message parents'}</button>}
            {trip.status === 'scheduled' && <button className="btn sm danger" onClick={() => setCancelling(true)}>{lang === 'ar' ? 'إلغاء الرحلة' : 'Cancel trip'}</button>}
          </div>
        </div>
        <div className="row small" style={{ marginTop: 8 }}>
          <span>{lang === 'ar' ? 'مخطط' : 'Planned'}: {fmtTime(trip.plannedStart, lang)}</span>
          <span>· {lang === 'ar' ? 'بدأت' : 'Started'}: {fmtTime(trip.startedAt, lang)}</span>
          <span>· {lang === 'ar' ? 'انتهت' : 'Ended'}: {fmtTime(trip.endedAt, lang)}</span>
          {trip.cancelledReason && <span>· {trip.cancelledReason}</span>}
        </div>
      </div>

      {alerts.length > 0 && (
        <div className="card">
          {alerts.map((a: any) => (
            <div key={a.id} className={`alert ${a.severity === 'critical' ? 'error' : 'warn'}`} style={{ marginBottom: 8 }}>
              <SeverityBadge s={a.severity} /> {ALERT_LABELS[a.kind]?.[lang] ?? a.kind} — {a.status}
              {a.details?.students && <div className="small">{a.details.students.map((s: any) => s.fullName).join('، ')}</div>}
            </div>
          ))}
        </div>
      )}

      <div className="grid cols-2">
        <div className="card">
          <MapView markers={markers} trail={trail.map((p: any) => [p.lat, p.lng] as [number, number])} />
          {trip.status !== 'in_progress' && trail.length > 0 && <div className="small muted">{lang === 'ar' ? 'مسار الرحلة المسجل (يُحذف حسب سياسة الاحتفاظ).' : 'Recorded trail (deleted per retention policy).'}</div>}
        </div>
        <div className="card">
          <div className="row">{Object.entries(counts).map(([k, v]) => <span key={k} className="badge gray">{t(`rider_${k}` as any)}: {v as number}</span>)}</div>
          <div className="table-wrap"><table>
            <tbody>{riders.map((r: any) => (
              <tr key={r.id}>
                <td>{r.fullName}<div className="small muted">{stops.find((s: any) => s.id === r.stopId)?.name}</div></td>
                <td><RiderStatus status={r.status} /></td>
                <td className="small">{r.boardedAt && `↑ ${fmtTime(r.boardedAt, lang)}`} {r.alightedAt && `↓ ${fmtTime(r.alightedAt, lang)}`}</td>
                <td><button className="btn sm ghost" onClick={() => setCorrecting(r)}>{lang === 'ar' ? 'تصحيح' : 'Correct'}</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>{lang === 'ar' ? 'سجل الأحداث' : 'Event log'}</h3>
          {events.length === 0 ? <Empty /> : (
            <table><tbody>{events.map((e: any) => (
              <tr key={e.id}>
                <td className="small">{fmtTime(e.recordedAt, lang)}</td>
                <td>{e.studentName}</td>
                <td>{EVENT_LABEL[e.type] ?? e.type}{e.type === 'correction' && <> → <RiderStatus status={e.newStatus} /></>}</td>
                <td className="small muted">{e.source === 'qr' ? 'QR' : e.source === 'system' ? (lang === 'ar' ? 'النظام' : 'System') : e.recordedBy}{e.reason && <div>{e.reason}</div>}
                  {e.handoverTo && <div style={{ color: 'var(--green-700)' }}>{lang === 'ar' ? 'سُلّم إلى' : 'Handed to'}: {e.handoverTo}</div>}</td>
              </tr>
            ))}</tbody></table>
          )}
        </div>
        <div className="card">
          <h3>{lang === 'ar' ? 'فحص خلو الباص' : 'Bus-empty check'}</h3>
          {!inspection ? (
            trip.inspectionStatus === 'pending' ? <div className="alert warn">{lang === 'ar' ? 'بانتظار إكمال السائق للفحص.' : 'Waiting for driver to complete the check.'}</div> : <Empty />
          ) : (
            <div className="stack">
              <div><span className={`badge ${inspection.result === 'bus_empty' ? '' : 'red'}`}>{inspection.result}</span> <span className="small">{fmtDateTime(inspection.completedAt, lang)}</span></div>
              <div className="small">{Object.entries(inspection.checklist).map(([k, v]) => <div key={k}>{v ? '✓' : '✗'} {CHECK_LABEL[k]?.[lang] ?? k}</div>)}</div>
              <div className="alert warn small">{lang === 'ar' ? 'هذه قائمة يقرّ بها السائق بنفسه، وليست دليلًا مستقلًا على خلو الباص. يُنصح بتحقق موظف ثانٍ.' : 'This is a driver self-declaration, not independent proof. A second-person check is recommended.'}</div>
              {inspection.verifiedAt
                ? <div className="small">✓ {lang === 'ar' ? 'تحقق مستقل بواسطة' : 'Verified by'} {inspection.verifiedBy} — {fmtDateTime(inspection.verifiedAt, lang)}</div>
                : <button className="btn secondary" onClick={() => verify.mutate()}>{lang === 'ar' ? 'تأكيد التحقق المستقل (فحصت الباص بنفسي)' : 'Record independent verification'}</button>}
            </div>
          )}
        </div>
      </div>

      {correcting && (
        <Modal title={`${lang === 'ar' ? 'تصحيح حالة' : 'Correct status'}: ${correcting.fullName}`} onClose={() => setCorrecting(null)}>
          <div className="field"><label>{lang === 'ar' ? 'الحالة الصحيحة' : 'Correct status'}</label>
            <select value={corr.status} onChange={(e) => setCorr({ ...corr, status: e.target.value })}>
              {['expected', 'boarded', 'alighted', 'absent', 'no_show'].map((s) => <option key={s} value={s}>{t(`rider_${s}` as any)}</option>)}
            </select></div>
          <div className="field"><label>{lang === 'ar' ? 'السبب (يُحفظ في السجل)' : 'Reason (recorded)'}</label><textarea rows={3} value={corr.reason} onChange={(e) => setCorr({ ...corr, reason: e.target.value })} /></div>
          {correct.error && <ErrorBox error={correct.error} />}
          <button className="btn" disabled={corr.reason.trim().length < 5 || correct.isPending} onClick={() => correct.mutate()}>{t('confirm')}</button>
        </Modal>
      )}
      {messaging && <ComposeModal onClose={() => setMessaging(false)} preset={{ audience: 'trips', tripIds: [trip.id], category: 'delay', label: `${lang === 'ar' ? 'أولياء أمور طلاب رحلة' : 'Parents on trip'} ${trip.routeName}` }} />}
      {cancelling && (
        <Modal title={lang === 'ar' ? 'إلغاء الرحلة' : 'Cancel trip'} onClose={() => setCancelling(false)}>
          <p className="small">{lang === 'ar' ? 'سيُبلَّغ أولياء أمور الطلاب المسجلين في الرحلة.' : 'Parents of riders will be notified.'}</p>
          <div className="field"><label>{lang === 'ar' ? 'السبب' : 'Reason'}</label><input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} /></div>
          {cancel.error && <ErrorBox error={cancel.error} />}
          <button className="btn danger" disabled={cancelReason.trim().length < 3} onClick={() => cancel.mutate()}>{t('confirm')}</button>
        </Modal>
      )}
    </div>
  );
}
