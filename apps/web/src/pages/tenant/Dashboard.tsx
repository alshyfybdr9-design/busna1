import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { useI18n, fmtTime, formatAge } from '../../i18n';
import { Empty, ErrorBox, Freshness, Loading } from '../../components/ui';
import { MapView } from '../../components/MapView';
import { ALERT_LABELS, SeverityBadge } from './Alerts';

export function Dashboard() {
  const { t, lang } = useI18n();
  // تحديث دوري (Polling) كل 10 ثوانٍ
  const dash = useQuery({ queryKey: ['dashboard'], queryFn: () => api('GET', '/tenant/dashboard'), refetchInterval: 10_000 });
  const live = useQuery({ queryKey: ['live'], queryFn: () => api('GET', '/tenant/live'), refetchInterval: 10_000 });
  if (dash.isLoading) return <Loading />;
  if (dash.error) return <ErrorBox error={dash.error} onRetry={() => dash.refetch()} />;
  const d = dash.data;
  const trips = live.data?.trips ?? [];
  const att = d.attendance ?? {};
  const markers = trips.filter((x: any) => x.location).map((x: any) => ({
    id: x.id, lat: x.location.lat, lng: x.location.lng,
    label: x.busLabel ?? x.busPlate ?? '🚌',
    color: x.location.isStale ? '#a16207' : '#16a34a',
    popup: <div><strong>{x.routeName}</strong><br />{x.driverName}<br /><Freshness location={x.location} /></div>,
  }));
  return (
    <div className="stack">
      <div className="grid cols-4">
        <div className="card"><div className="muted small">{t('activeTrips')}</div><div className="stat">{d.trips.in_progress ?? 0}</div></div>
        <div className="card"><div className="muted small">{t('delayedTrips')}</div><div className="stat" style={{ color: d.delayed.length ? 'var(--amber)' : undefined }}>{d.delayed.length}</div></div>
        <div className="card"><div className="muted small">{t('operationalAlerts')}</div><div className="stat" style={{ color: d.alerts.some((a: any) => a.severity === 'critical') ? 'var(--red)' : undefined }}>{d.alerts.length}</div></div>
        <div className="card"><div className="muted small">{t('pendingInspections')}</div><div className="stat">{d.pendingInspections}</div></div>
      </div>

      {d.alerts.length > 0 && (
        <div className="card">
          <div className="row between"><h2>{t('operationalAlerts')}</h2><Link to="/app/alerts">{t('alerts')} ←</Link></div>
          <div className="table-wrap"><table><tbody>
            {d.alerts.slice(0, 8).map((a: any) => (
              <tr key={a.id}>
                <td><SeverityBadge s={a.severity} /></td>
                <td>{ALERT_LABELS[a.kind]?.[lang] ?? a.kind}{a.details?.students && <div className="small muted">{a.details.students.map((s: any) => s.fullName).join('، ')}</div>}</td>
                <td>{a.routeName ?? '—'}</td>
                <td className="muted small">{formatAge((Date.now() - new Date(a.createdAt).getTime()) / 1000 | 0, lang)}</td>
                <td>{a.tripId && <Link to={`/app/trips/${a.tripId}`}>{t('trips')}</Link>}</td>
              </tr>
            ))}
          </tbody></table></div>
        </div>
      )}

      <div className="grid cols-2">
        <div className="card">
          <h2>{t('busMap')}</h2>
          {live.error && <ErrorBox error={live.error} />}
          <MapView markers={markers} />
          {trips.length > 0 && markers.length < trips.length && (
            <div className="small muted" style={{ marginTop: 6 }}>{lang === 'ar' ? `${trips.length - markers.length} رحلة جارية بدون موقع بعد` : `${trips.length - markers.length} active trip(s) without location yet`}</div>
          )}
        </div>
        <div className="card">
          <h2>{t('activeTrips')}</h2>
          {trips.length === 0 ? <Empty /> : (
            <div className="table-wrap"><table><tbody>
              {trips.map((x: any) => (
                <tr key={x.id}>
                  <td><Link to={`/app/trips/${x.id}`}>{x.routeName}</Link><div className="small muted">{x.driverName} · {x.busLabel ?? x.busPlate}</div></td>
                  <td><Freshness location={x.location} /></td>
                </tr>
              ))}
            </tbody></table></div>
          )}
          <h2 style={{ marginTop: 20 }}>{t('delayedTrips')}</h2>
          {d.delayed.length === 0 ? <Empty /> : (
            <table><tbody>
              {d.delayed.map((x: any) => (
                <tr key={x.id}>
                  <td><Link to={`/app/trips/${x.id}`}>{x.routeName}</Link><div className="small muted">{x.driverName}</div></td>
                  <td>{fmtTime(x.plannedStart, lang)}</td>
                  <td><span className="badge amber">+{x.minutesLate} {lang === 'ar' ? 'د' : 'min'}</span></td>
                </tr>
              ))}
            </tbody></table>
          )}
          <div className="small muted">{lang === 'ar' ? `"متأخرة" = لم تبدأ بعد ${d.delayThresholdMin} دقائق من موعدها المخطط.` : `"Late" = not started ${d.delayThresholdMin} min after planned time.`}</div>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>{t('attendanceToday')}</h2>
          <div className="grid cols-4">
            {(['expected', 'boarded', 'alighted', 'absent', 'no_show'] as const).map((k) => (
              <div key={k}><div className="muted small">{t(`rider_${k}`)}</div><div className="stat" style={{ fontSize: '1.4rem' }}>{att[k] ?? 0}</div></div>
            ))}
          </div>
        </div>
        <div className="card stack">
          <div className="row between"><h2 style={{ margin: 0 }}>{t('pendingAbsences')}</h2><Link to="/app/absences">{d.pendingAbsences}</Link></div>
          <div className="row between"><h2 style={{ margin: 0 }}>{t('supportTickets')}</h2><span className="badge gray">{t('comingPhase')}</span></div>
        </div>
      </div>
    </div>
  );
}
