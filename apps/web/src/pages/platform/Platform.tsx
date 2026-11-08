import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useI18n, fmtDateTime } from '../../i18n';
import { Empty, ErrorBox, Loading, Modal } from '../../components/ui';

export function PlatformTenants() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ code: '', name: '', nameEn: '', kind: 'school', contactPhone: '', adminName: '', adminEmail: '', isDemo: false });
  const q = useQuery({ queryKey: ['p-tenants'], queryFn: () => api('GET', '/platform/tenants') });
  const create = useMutation({
    mutationFn: () => api('POST', '/platform/tenants', {
      code: f.code, name: f.name, nameEn: f.nameEn || undefined, kind: f.kind, contactPhone: f.contactPhone || undefined, isDemo: f.isDemo,
      admin: { fullName: f.adminName, email: f.adminEmail },
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['p-tenants'] }),
  });
  const status = useMutation({ mutationFn: (p: { id: string; status: string }) => api('PATCH', `/platform/tenants/${p.id}`, { status: p.status }), onSuccess: () => qc.invalidateQueries({ queryKey: ['p-tenants'] }) });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="card">
      <div className="row between"><h2>{t('tenants')}</h2><button className="btn" onClick={() => { create.reset(); setAdding(true); }}>+ {t('add')}</button></div>
      <p className="small muted">{lang === 'ar' ? 'تعرض هذه الصفحة أعدادًا مجمعة فقط. لا يملك مدير المنصة وصولًا لبيانات الطلاب داخل الجهات.' : 'Aggregate counts only — platform admins cannot read tenant student data.'}</p>
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (q.data.tenants.length === 0 ? <Empty /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>{lang === 'ar' ? 'الجهة' : 'Organization'}</th><th>{lang === 'ar' ? 'الرمز' : 'Code'}</th><th>{t('students')}</th><th>{t('buses')}</th><th>{lang === 'ar' ? 'سائقون' : 'Drivers'}</th><th>{lang === 'ar' ? 'رحلات اليوم' : 'Trips today'}</th><th>{lang === 'ar' ? 'الحالة' : 'Status'}</th></tr></thead>
          <tbody>{q.data.tenants.map((x: any) => (
            <tr key={x.id}>
              <td>{x.name} {x.isDemo && <span className="badge amber">demo</span>}<div className="small muted">{x.kind} · {fmtDateTime(x.createdAt, lang)}</div></td>
              <td><code>{x.code}</code></td><td>{x.students}</td><td>{x.buses}</td><td>{x.drivers}</td><td>{x.tripsToday} ({x.activeTrips} {lang === 'ar' ? 'جارية' : 'active'})</td>
              <td><select value={x.status} onChange={(e) => confirm(lang === 'ar' ? 'تغيير حالة الجهة؟ الإيقاف يمنع جميع مستخدميها من الدخول.' : 'Change status?') && status.mutate({ id: x.id, status: e.target.value })} style={{ width: 120 }}>
                <option value="active">active</option><option value="suspended">suspended</option></select></td>
            </tr>
          ))}</tbody>
        </table></div>
      ))}
      {adding && (
        <Modal title={lang === 'ar' ? 'جهة جديدة' : 'New organization'} onClose={() => setAdding(false)}>
          {create.data ? (
            <div className="stack">
              <div className="alert info">{lang === 'ar' ? 'أُنشئت الجهة. أرسل رابط الدعوة لمدير الجهة (يُعرض مرة واحدة):' : 'Created. Send this invite link to the organization admin (shown once):'}</div>
              <input readOnly dir="ltr" value={create.data.adminInvite.inviteUrl} onFocus={(e) => e.target.select()} />
              <button className="btn" onClick={() => navigator.clipboard.writeText(create.data.adminInvite.inviteUrl)}>{lang === 'ar' ? 'نسخ' : 'Copy'}</button>
            </div>
          ) : (
            <form onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
              <div className="row">
                <div className="field" style={{ flex: 1 }}><label>{lang === 'ar' ? 'الرمز (4-20 حرفًا/رقمًا)' : 'Code'}</label><input dir="ltr" value={f.code} onChange={set('code')} required pattern="[A-Za-z0-9-]{4,20}" /></div>
                <div className="field" style={{ flex: 1 }}><label>{lang === 'ar' ? 'النوع' : 'Kind'}</label><select value={f.kind} onChange={set('kind')}><option value="school">{lang === 'ar' ? 'مدرسة' : 'School'}</option><option value="transport_company">{lang === 'ar' ? 'شركة نقل' : 'Transport company'}</option></select></div>
              </div>
              <div className="field"><label>{lang === 'ar' ? 'الاسم' : 'Name'}</label><input value={f.name} onChange={set('name')} required /></div>
              <div className="field"><label>{lang === 'ar' ? 'الاسم بالإنجليزية' : 'English name'}</label><input value={f.nameEn} onChange={set('nameEn')} /></div>
              <div className="field"><label>{lang === 'ar' ? 'هاتف التواصل' : 'Phone'}</label><input dir="ltr" value={f.contactPhone} onChange={set('contactPhone')} /></div>
              <h3>{lang === 'ar' ? 'مدير الجهة' : 'Organization admin'}</h3>
              <div className="field"><label>{lang === 'ar' ? 'الاسم' : 'Name'}</label><input value={f.adminName} onChange={set('adminName')} required /></div>
              <div className="field"><label>{lang === 'ar' ? 'البريد' : 'Email'}</label><input type="email" dir="ltr" value={f.adminEmail} onChange={set('adminEmail')} required /></div>
              <label className="row" style={{ marginBottom: 12 }}><input type="checkbox" style={{ width: 'auto', minHeight: 0 }} checked={f.isDemo} onChange={(e) => setF({ ...f, isDemo: e.target.checked })} />{lang === 'ar' ? 'جهة تجريبية' : 'Demo organization'}</label>
              {create.error && <ErrorBox error={create.error} />}
              <button className="btn" disabled={create.isPending}>{t('save')}</button>
            </form>
          )}
        </Modal>
      )}
    </div>
  );
}

export function PlatformHealth() {
  const { t, lang } = useI18n();
  const q = useQuery({ queryKey: ['p-health'], queryFn: () => api('GET', '/platform/health'), refetchInterval: 15_000 });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const h = q.data;
  const yes = lang === 'ar' ? 'مُعدّ' : 'Configured';
  const no = lang === 'ar' ? 'غير مُعدّ' : 'Not configured';
  return (
    <div className="grid cols-2">
      <div className="card">
        <h2>{t('health')}</h2>
        <table><tbody>
          <tr><td>{lang === 'ar' ? 'قاعدة البيانات' : 'Database'}</td><td><span className="badge">{h.database}</span></td></tr>
          <tr><td>{lang === 'ar' ? 'أحداث بانتظار المعالجة' : 'Pending outbox'}</td><td>{h.outbox.pending}</td></tr>
          <tr><td>{lang === 'ar' ? 'أحداث فشلت' : 'Failed outbox'}</td><td>{h.outbox.failed ? <span className="badge red">{h.outbox.failed}</span> : 0}</td></tr>
          <tr><td>{lang === 'ar' ? 'آخر تشغيل للعامل الخلفي' : 'Worker last run'}</td><td>{h.worker.lastRunAt ? fmtDateTime(h.worker.lastRunAt, lang) : '—'}</td></tr>
          {h.worker.lastError && <tr><td colSpan={2}><div className="alert error small">{h.worker.lastError}</div></td></tr>}
        </tbody></table>
      </div>
      <div className="card">
        <h2>{lang === 'ar' ? 'التكاملات الخارجية' : 'Integrations'}</h2>
        <table><tbody>{Object.entries(h.integrations).map(([k, v]: [string, any]) => (
          <tr key={k}><td>{k}</td><td><span className={`badge ${v.configured ? '' : 'gray'}`}>{v.configured ? yes : no}</span> {v.provider && <code className="small">{v.provider}</code>}</td></tr>
        ))}</tbody></table>
      </div>
    </div>
  );
}
