import { useEffect, useState, type FormEvent } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useI18n } from '../../i18n';
import { Empty, ErrorBox, Loading, Modal } from '../../components/ui';
import { MapView } from '../../components/MapView';

const DAYS_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const DAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function useFleet() {
  const buses = useQuery({ queryKey: ['buses'], queryFn: () => api('GET', '/tenant/buses') });
  const drivers = useQuery({ queryKey: ['members', 'driver'], queryFn: () => api('GET', '/tenant/members?role=driver') });
  return { buses: buses.data?.buses ?? [], drivers: (drivers.data?.members ?? []).filter((d: any) => d.status === 'active') };
}

export function RoutesPage() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const ctx = useOutletContext<{ role: string }>();
  const [adding, setAdding] = useState(false);
  const q = useQuery({ queryKey: ['routes'], queryFn: () => api('GET', '/tenant/routes') });
  const { buses, drivers } = useFleet();
  const [f, setF] = useState({ name: '', direction: 'to_school', busId: '', driverUserId: '' });
  const create = useMutation({
    mutationFn: () => api('POST', '/tenant/routes', { name: f.name, direction: f.direction, busId: f.busId || null, driverUserId: f.driverUserId || null }),
    onSuccess: () => { setAdding(false); qc.invalidateQueries({ queryKey: ['routes'] }); },
  });
  return (
    <div className="card">
      <div className="row between">
        <h2>{t('routes')}</h2>
        {ctx?.role === 'tenant_admin' && <button className="btn" onClick={() => setAdding(true)}>+ {t('add')}</button>}
      </div>
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (q.data.routes.length === 0 ? <Empty /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>{lang === 'ar' ? 'المسار' : 'Route'}</th><th>{lang === 'ar' ? 'الاتجاه' : 'Direction'}</th><th>{t('buses')}</th><th>{t('role_driver')}</th><th>{lang === 'ar' ? 'النقاط' : 'Stops'}</th><th>{t('students')}</th></tr></thead>
          <tbody>{q.data.routes.map((r: any) => (
            <tr key={r.id}>
              <td><Link to={`/app/routes/${r.id}`}>{r.name}</Link>{r.status !== 'active' && <span className="badge gray"> {r.status}</span>}</td>
              <td>{t(`dir_${r.direction}` as any)}</td>
              <td>{r.busLabel ?? r.busPlate ?? <span className="badge amber">—</span>}</td>
              <td>{r.driverName ?? <span className="badge amber">—</span>}</td>
              <td>{r.stopCount}</td><td>{r.riderCount}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ))}
      {adding && (
        <Modal title={lang === 'ar' ? 'مسار جديد' : 'New route'} onClose={() => setAdding(false)}>
          <form onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
            <div className="field"><label>{lang === 'ar' ? 'اسم المسار' : 'Name'}</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} /></div>
            <div className="field"><label>{lang === 'ar' ? 'الاتجاه' : 'Direction'}</label>
              <select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}><option value="to_school">{t('dir_to_school')}</option><option value="from_school">{t('dir_from_school')}</option></select></div>
            <div className="field"><label>{t('buses')}</label>
              <select value={f.busId} onChange={(e) => setF({ ...f, busId: e.target.value })}><option value="">—</option>{buses.map((b: any) => <option key={b.id} value={b.id}>{b.label ?? b.plateNumber}</option>)}</select></div>
            <div className="field"><label>{t('role_driver')}</label>
              <select value={f.driverUserId} onChange={(e) => setF({ ...f, driverUserId: e.target.value })}><option value="">—</option>{drivers.map((d: any) => <option key={d.userId} value={d.userId}>{d.fullName}</option>)}</select></div>
            {create.error && <ErrorBox error={create.error} />}
            <button className="btn" disabled={create.isPending}>{t('save')}</button>
          </form>
        </Modal>
      )}
    </div>
  );
}

type StopDraft = { id?: string; name: string; kind: 'stop' | 'school'; lat: number; lng: number; plannedTime: string | null };

export function RouteDetail() {
  const { id = '' } = useParams();
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const ctx = useOutletContext<{ role: string }>();
  const isAdmin = ctx?.role === 'tenant_admin';
  const q = useQuery({ queryKey: ['route', id], queryFn: () => api('GET', `/tenant/routes/${id}`) });
  const students = useQuery({ queryKey: ['students', ''], queryFn: () => api('GET', '/tenant/students') });
  const { buses, drivers } = useFleet();
  const [stops, setStops] = useState<StopDraft[] | null>(null);
  const [assign, setAssign] = useState({ studentId: '', stopId: '' });
  const [sched, setSched] = useState({ days: [0, 1, 2, 3, 4], time: '06:30' });
  useEffect(() => {
    if (q.data) setStops(q.data.stops.map((s: any) => ({ ...s, plannedTime: s.plannedTime?.slice(0, 5) ?? null })));
  }, [q.data]);
  const inv = () => { qc.invalidateQueries({ queryKey: ['route', id] }); qc.invalidateQueries({ queryKey: ['routes'] }); };
  const saveStops = useMutation({ mutationFn: () => api('PUT', `/tenant/routes/${id}/stops`, { stops }), onSuccess: inv });
  const updateRoute = useMutation({ mutationFn: (body: any) => api('PATCH', `/tenant/routes/${id}`, body), onSuccess: inv });
  const addRider = useMutation({ mutationFn: () => api('PUT', `/tenant/routes/${id}/riders/${assign.studentId}`, { stopId: assign.stopId }), onSuccess: () => { setAssign({ studentId: '', stopId: '' }); inv(); } });
  const removeRider = useMutation({ mutationFn: (sid: string) => api('DELETE', `/tenant/routes/${id}/riders/${sid}`), onSuccess: inv });
  const addSched = useMutation({ mutationFn: () => api('POST', `/tenant/routes/${id}/schedules`, { daysOfWeek: sched.days, departureTime: sched.time }), onSuccess: inv });
  const delSched = useMutation({ mutationFn: (sid: string) => api('DELETE', `/tenant/schedules/${sid}`), onSuccess: inv });

  if (q.isLoading || !stops) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const { route, riders, schedules } = q.data;
  const dirty = JSON.stringify(stops) !== JSON.stringify(q.data.stops.map((s: any) => ({ ...s, plannedTime: s.plannedTime?.slice(0, 5) ?? null })));
  const assigned = new Set(riders.map((r: any) => r.studentId));
  const pickupStops = q.data.stops.filter((s: any) => s.kind === 'stop');
  const days = lang === 'ar' ? DAYS_AR : DAYS_EN;
  return (
    <div className="stack">
      <Link to="/app/routes">← {t('routes')}</Link>
      <div className="card">
        <div className="row between"><h2>{route.name}</h2><span className="badge">{t(`dir_${route.direction}` as any)}</span></div>
        <div className="row">
          <label className="small">{t('buses')}</label>
          <select style={{ width: 180 }} value={route.busId ?? ''} onChange={(e) => updateRoute.mutate({ busId: e.target.value || null })}>
            <option value="">—</option>{buses.map((b: any) => <option key={b.id} value={b.id}>{b.label ?? b.plateNumber}</option>)}
          </select>
          <label className="small">{t('role_driver')}</label>
          <select style={{ width: 200 }} value={route.driverUserId ?? ''} onChange={(e) => updateRoute.mutate({ driverUserId: e.target.value || null })}>
            <option value="">—</option>{drivers.map((d: any) => <option key={d.userId} value={d.userId}>{d.fullName}</option>)}
          </select>
        </div>
        {updateRoute.error && <ErrorBox error={updateRoute.error} />}
        <div className="small muted" style={{ marginTop: 6 }}>{lang === 'ar' ? 'تغيير الباص/السائق يسري على الرحلات التي تُنشأ لاحقًا.' : 'Bus/driver changes apply to trips created afterwards.'}</div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>{lang === 'ar' ? 'نقاط التوقف' : 'Stops'}</h3>
          {isAdmin && <p className="small muted">{lang === 'ar' ? 'انقر على الخريطة لإضافة نقطة. رتّب النقاط بالأسهم ثم احفظ.' : 'Click the map to add a stop, reorder, then save.'}</p>}
          <MapView
            markers={stops.map((s, i) => ({ id: `${i}`, lat: s.lat, lng: s.lng, label: s.kind === 'school' ? '🏫' : `${i + 1}`, color: s.kind === 'school' ? '#1d4ed8' : '#16a34a', popup: s.name }))}
            trail={stops.map((s) => [s.lat, s.lng] as [number, number])}
            fit={!dirty}
            onMapClick={isAdmin ? (lat, lng) => setStops([...stops, { name: `${lang === 'ar' ? 'نقطة' : 'Stop'} ${stops.length + 1}`, kind: 'stop', lat: +lat.toFixed(6), lng: +lng.toFixed(6), plannedTime: null }]) : undefined}
          />
          <table style={{ marginTop: 10 }}><tbody>
            {stops.map((s, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td><input value={s.name} disabled={!isAdmin} onChange={(e) => setStops(stops.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} /></td>
                <td style={{ width: 110 }}><input type="time" value={s.plannedTime ?? ''} disabled={!isAdmin} onChange={(e) => setStops(stops.map((x, j) => j === i ? { ...x, plannedTime: e.target.value || null } : x))} /></td>
                <td style={{ width: 110 }}>
                  <select value={s.kind} disabled={!isAdmin} onChange={(e) => setStops(stops.map((x, j) => j === i ? { ...x, kind: e.target.value as any } : x))}>
                    <option value="stop">{lang === 'ar' ? 'توقف' : 'Stop'}</option><option value="school">{lang === 'ar' ? 'المدرسة' : 'School'}</option>
                  </select>
                </td>
                {isAdmin && <td className="row" style={{ flexWrap: 'nowrap' }}>
                  <button className="btn sm ghost" disabled={i === 0} onClick={() => { const c = [...stops]; [c[i - 1], c[i]] = [c[i], c[i - 1]]; setStops(c); }}>↑</button>
                  <button className="btn sm ghost" disabled={i === stops.length - 1} onClick={() => { const c = [...stops]; [c[i + 1], c[i]] = [c[i], c[i + 1]]; setStops(c); }}>↓</button>
                  <button className="btn sm ghost" onClick={() => setStops(stops.filter((_, j) => j !== i))}>✕</button>
                </td>}
              </tr>
            ))}
          </tbody></table>
          {saveStops.error && <ErrorBox error={saveStops.error} />}
          {isAdmin && <button className="btn" disabled={!dirty || saveStops.isPending} onClick={() => saveStops.mutate()}>{t('save')}</button>}
        </div>

        <div className="stack">
          <div className="card">
            <h3>{lang === 'ar' ? 'الطلاب المعيّنون' : 'Assigned students'} ({riders.length})</h3>
            {pickupStops.length === 0 ? <div className="alert warn">{lang === 'ar' ? 'أضف نقاط توقف واحفظها أولًا.' : 'Add and save stops first.'}</div> : (
              <form className="row" onSubmit={(e) => { e.preventDefault(); addRider.mutate(); }}>
                <select style={{ flex: 2 }} value={assign.studentId} onChange={(e) => setAssign({ ...assign, studentId: e.target.value })} required>
                  <option value="">{lang === 'ar' ? 'اختر طالبًا' : 'Select student'}</option>
                  {(students.data?.students ?? []).filter((s: any) => s.status === 'active' && !assigned.has(s.id)).map((s: any) => <option key={s.id} value={s.id}>{s.fullName}</option>)}
                </select>
                <select style={{ flex: 1 }} value={assign.stopId} onChange={(e) => setAssign({ ...assign, stopId: e.target.value })} required>
                  <option value="">{lang === 'ar' ? 'النقطة' : 'Stop'}</option>
                  {pickupStops.map((s: any) => <option key={s.id} value={s.id}>{s.seq}. {s.name}</option>)}
                </select>
                <button className="btn" disabled={addRider.isPending}>{t('add')}</button>
              </form>
            )}
            {addRider.error && <ErrorBox error={addRider.error} />}
            <table><tbody>{riders.map((r: any) => (
              <tr key={r.id}>
                <td><Link to={`/app/students/${r.studentId}`}>{r.fullName}</Link></td>
                <td>{q.data.stops.find((s: any) => s.id === r.stopId)?.name}</td>
                <td><button className="btn sm ghost" onClick={() => removeRider.mutate(r.studentId)}>✕</button></td>
              </tr>
            ))}</tbody></table>
          </div>
          <div className="card">
            <h3>{lang === 'ar' ? 'الجدول' : 'Schedule'}</h3>
            <table><tbody>{schedules.filter((s: any) => s.status === 'active').map((s: any) => (
              <tr key={s.id}><td>{s.daysOfWeek.map((d: number) => days[d]).join('، ')}</td><td dir="ltr">{s.departureTime.slice(0, 5)}</td>
                <td>{isAdmin && <button className="btn sm ghost" onClick={() => delSched.mutate(s.id)}>✕</button>}</td></tr>
            ))}</tbody></table>
            {isAdmin && (
              <div className="stack">
                <div className="row">{days.map((d, i) => (
                  <label key={i} className="row small" style={{ gap: 4 }}>
                    <input type="checkbox" style={{ width: 'auto', minHeight: 0 }} checked={sched.days.includes(i)} onChange={(e) => setSched({ ...sched, days: e.target.checked ? [...sched.days, i] : sched.days.filter((x) => x !== i) })} />{d}
                  </label>
                ))}</div>
                <div className="row">
                  <input type="time" value={sched.time} onChange={(e) => setSched({ ...sched, time: e.target.value })} style={{ width: 140 }} />
                  <button className="btn secondary" disabled={!sched.days.length} onClick={() => addSched.mutate()}>{t('add')}</button>
                </div>
                {addSched.error && <ErrorBox error={addSched.error} />}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function Buses() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const ctx = useOutletContext<{ role: string }>();
  const [f, setF] = useState({ plateNumber: '', label: '', capacity: '' });
  const q = useQuery({ queryKey: ['buses'], queryFn: () => api('GET', '/tenant/buses') });
  const add = useMutation({
    mutationFn: () => api('POST', '/tenant/buses', { plateNumber: f.plateNumber, label: f.label || null, capacity: f.capacity ? Number(f.capacity) : null }),
    onSuccess: () => { setF({ plateNumber: '', label: '', capacity: '' }); qc.invalidateQueries({ queryKey: ['buses'] }); },
  });
  const upd = useMutation({ mutationFn: (p: { id: string; status: string }) => api('PATCH', `/tenant/buses/${p.id}`, { status: p.status }), onSuccess: () => qc.invalidateQueries({ queryKey: ['buses'] }) });
  const isAdmin = ctx?.role === 'tenant_admin';
  return (
    <div className="card">
      <h2>{t('buses')}</h2>
      {isAdmin && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); add.mutate(); }} style={{ marginBottom: 12 }}>
          <input placeholder={lang === 'ar' ? 'رقم اللوحة *' : 'Plate *'} value={f.plateNumber} onChange={(e) => setF({ ...f, plateNumber: e.target.value })} required style={{ width: 160 }} />
          <input placeholder={lang === 'ar' ? 'الاسم (مثل باص 3)' : 'Label'} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} style={{ width: 160 }} />
          <input type="number" min={1} max={120} placeholder={lang === 'ar' ? 'السعة' : 'Capacity'} value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} style={{ width: 110 }} />
          <button className="btn" disabled={add.isPending}>{t('add')}</button>
        </form>
      )}
      {add.error && <ErrorBox error={add.error} />}
      {q.isLoading && <Loading />}
      {q.data && (q.data.buses.length === 0 ? <Empty /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>{lang === 'ar' ? 'الباص' : 'Bus'}</th><th>{lang === 'ar' ? 'اللوحة' : 'Plate'}</th><th>{lang === 'ar' ? 'السعة' : 'Capacity'}</th><th>{lang === 'ar' ? 'الحالة' : 'Status'}</th><th>{lang === 'ar' ? 'رمز مؤخرة الباص (للفحص)' : 'Rear-of-bus code (inspection)'}</th></tr></thead>
          <tbody>{q.data.buses.map((b: any) => (
            <tr key={b.id}>
              <td>{b.label ?? '—'}</td><td dir="ltr">{b.plateNumber}</td><td>{b.capacity ?? '—'}</td>
              <td>{isAdmin ? (
                <select value={b.status} onChange={(e) => upd.mutate({ id: b.id, status: e.target.value })} style={{ width: 130 }}>
                  <option value="active">{lang === 'ar' ? 'في الخدمة' : 'Active'}</option><option value="maintenance">{lang === 'ar' ? 'صيانة' : 'Maintenance'}</option><option value="retired">{lang === 'ar' ? 'خارج الخدمة' : 'Retired'}</option>
                </select>) : b.status}</td>
              <td><code className="small">{b.rearQrToken}</code></td>
            </tr>
          ))}</tbody>
        </table></div>
      ))}
      <p className="small muted">{lang === 'ar' ? 'يُطبع رمز مؤخرة الباص كملصق QR في آخر الباص؛ يمسحه السائق أثناء فحص الخلو كدليل مساعد على وصوله لآخر الباص.' : 'Print the rear code as a QR sticker at the back of the bus; the driver scans it during the empty-bus check.'}</p>
    </div>
  );
}
