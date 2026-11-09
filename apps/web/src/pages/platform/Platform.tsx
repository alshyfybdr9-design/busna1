import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, selectContext } from '../../api';
import { useI18n, fmtDateTime } from '../../i18n';
import { Empty, ErrorBox, Loading, Modal } from '../../components/ui';

const SUB_STATUS: Record<string, { ar: string; cls: string }> = {
  trial: { ar: 'تجريبي', cls: 'blue' }, active: { ar: 'فعّال', cls: '' }, past_due: { ar: 'متأخر السداد', cls: 'amber' }, cancelled: { ar: 'ملغى', cls: 'red' },
};

function Usage({ used, max }: { used: number; max: number | null }) {
  const { lang } = useI18n();
  if (max == null) return <span>{lang === 'ar' ? `${used} (بلا حد)` : `${used} / ∞`}</span>;
  const pct = Math.min(100, Math.round((used / max) * 100));
  return (
    <div style={{ minWidth: 90 }}>
      <div className="small">{lang === 'ar' ? `${used} من ${max}` : `${used} / ${max}`}</div>
      <div style={{ height: 6, background: 'var(--line)', borderRadius: 4 }}>
        <div style={{ width: `${pct}%`, height: 6, borderRadius: 4, background: pct >= 100 ? 'var(--red)' : pct >= 80 ? 'var(--amber)' : 'var(--green-600)' }} />
      </div>
    </div>
  );
}

export function PlatformTenants() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [adding, setAdding] = useState(false);
  const [editingSub, setEditingSub] = useState<any>(null);
  const [accessFor, setAccessFor] = useState<any>(null);
  const [f, setF] = useState({ code: '', name: '', nameEn: '', kind: 'school', contactPhone: '', adminName: '', adminEmail: '', isDemo: false, planCode: 'trial' });
  const q = useQuery({ queryKey: ['p-tenants'], queryFn: () => api('GET', '/platform/tenants') });
  const plans = useQuery({ queryKey: ['p-plans'], queryFn: () => api('GET', '/platform/plans') });
  const create = useMutation({
    mutationFn: () => api('POST', '/platform/tenants', {
      code: f.code, name: f.name, nameEn: f.nameEn || undefined, kind: f.kind, contactPhone: f.contactPhone || undefined, isDemo: f.isDemo, planCode: f.planCode,
      admin: { fullName: f.adminName, email: f.adminEmail },
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['p-tenants'] }),
  });
  const status = useMutation({ mutationFn: (p: { id: string; status: string }) => api('PATCH', `/platform/tenants/${p.id}`, { status: p.status }), onSuccess: () => qc.invalidateQueries({ queryKey: ['p-tenants'] }) });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const canManage = !!q.data?.canManage;
  return (
    <div className="card">
      <div className="row between"><h2>{t('tenants')}</h2>{canManage && <button className="btn" onClick={() => { create.reset(); setAdding(true); }}>+ {t('add')}</button>}</div>
      <p className="small muted">{lang === 'ar' ? 'أعداد مجمعة فقط. الاطلاع على بيانات جهة يتطلب «وصول دعم مؤقت» بسبب مكتوب، للقراءة فقط، ويُسجَّل ويُبلَّغ به مدير الجهة.' : 'Aggregate counts only. Viewing an organization requires audited, read-only temporary access with a reason.'}</p>
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (q.data.tenants.length === 0 ? <Empty /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>{lang === 'ar' ? 'الجهة' : 'Organization'}</th><th>{lang === 'ar' ? 'الخطة' : 'Plan'}</th><th>{t('students')}</th><th>{t('buses')}</th><th>{lang === 'ar' ? 'سائقون' : 'Drivers'}</th><th>{lang === 'ar' ? 'رحلات اليوم' : 'Trips today'}</th><th>{lang === 'ar' ? 'الحالة' : 'Status'}</th><th></th></tr></thead>
          <tbody>{q.data.tenants.map((x: any) => (
            <tr key={x.id}>
              <td>{x.name} {x.isDemo && <span className="badge amber">demo</span>}<div className="small muted"><code>{x.code}</code> · {fmtDateTime(x.createdAt, lang)}</div></td>
              <td>
                {x.planName ?? '—'} {x.subscriptionStatus && <span className={`badge ${SUB_STATUS[x.subscriptionStatus]?.cls}`}>{SUB_STATUS[x.subscriptionStatus]?.ar}</span>}
                {x.periodEnd && <div className="small muted">{lang === 'ar' ? 'حتى' : 'until'} {x.periodEnd}</div>}
                {canManage && <div><button className="btn sm ghost" onClick={() => setEditingSub(x)}>{lang === 'ar' ? 'تعديل الاشتراك' : 'Edit'}</button></div>}
              </td>
              <td><Usage used={x.students ?? 0} max={x.maxStudents} /></td>
              <td><Usage used={x.buses ?? 0} max={x.maxBuses} /></td>
              <td><Usage used={x.drivers ?? 0} max={x.maxDrivers} /></td>
              <td>{x.tripsToday} ({x.activeTrips} {lang === 'ar' ? 'جارية' : 'active'})</td>
              <td>{canManage ? (
                <select value={x.status} onChange={(e) => confirm(lang === 'ar' ? 'تغيير حالة الجهة؟ الإيقاف يمنع جميع مستخدميها من الدخول.' : 'Change status?') && status.mutate({ id: x.id, status: e.target.value })} style={{ width: 120 }}>
                  <option value="active">active</option><option value="suspended">suspended</option></select>
              ) : x.status}</td>
              <td>{x.allowsSupportAccess
                ? <button className="btn sm secondary" onClick={() => setAccessFor(x)}>{lang === 'ar' ? 'وصول دعم مؤقت' : 'Support access'}</button>
                : <span className="small muted">{lang === 'ar' ? 'الجهة لا تسمح بالوصول' : 'Access disabled'}</span>}</td>
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
              <div className="row">
                <div className="field" style={{ flex: 1 }}><label>{lang === 'ar' ? 'هاتف التواصل' : 'Phone'}</label><input dir="ltr" value={f.contactPhone} onChange={set('contactPhone')} /></div>
                <div className="field" style={{ flex: 1 }}><label>{lang === 'ar' ? 'الخطة' : 'Plan'}</label>
                  <select value={f.planCode} onChange={set('planCode')}>{(plans.data?.plans ?? []).filter((p: any) => p.active).map((p: any) => <option key={p.id} value={p.code}>{p.name}</option>)}</select></div>
              </div>
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
      {editingSub && <SubscriptionModal tenant={editingSub} plans={plans.data?.plans ?? []} onClose={() => setEditingSub(null)} onSaved={() => { setEditingSub(null); qc.invalidateQueries({ queryKey: ['p-tenants'] }); }} />}
      {accessFor && <AccessModal tenant={accessFor} onClose={() => setAccessFor(null)} onGranted={async (gid) => { await selectContext({ accessGrantId: gid }); nav('/app'); }} />}
    </div>
  );
}

function SubscriptionModal({ tenant, plans, onClose, onSaved }: { tenant: any; plans: any[]; onClose: () => void; onSaved: () => void }) {
  const { lang } = useI18n();
  const [f, setF] = useState({ planId: tenant.planId ?? plans[0]?.id ?? '', status: tenant.subscriptionStatus ?? 'trial', currentPeriodEnd: tenant.periodEnd ?? '', notes: tenant.subscriptionNotes ?? '' });
  const m = useMutation({
    mutationFn: () => api('PUT', `/platform/tenants/${tenant.id}/subscription`, { planId: f.planId, status: f.status, currentPeriodEnd: f.currentPeriodEnd || null, notes: f.notes || null }),
    onSuccess: onSaved,
  });
  const plan = plans.find((p) => p.id === f.planId);
  const over = plan && ((plan.maxStudents != null && tenant.students > plan.maxStudents) || (plan.maxBuses != null && tenant.buses > plan.maxBuses) || (plan.maxDrivers != null && tenant.drivers > plan.maxDrivers));
  return (
    <Modal title={`${lang === 'ar' ? 'اشتراك' : 'Subscription'}: ${tenant.name}`} onClose={onClose}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
        <div className="field"><label>{lang === 'ar' ? 'الخطة' : 'Plan'}</label>
          <select value={f.planId} onChange={(e) => setF({ ...f, planId: e.target.value })}>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}{!p.active ? ' (غير نشطة)' : ''}</option>)}</select></div>
        {over && <div className="alert warn small">{lang === 'ar' ? 'استهلاك الجهة الحالي أعلى من حدود هذه الخطة: لن تُحذف بيانات، لكن ستُمنع الإضافات الجديدة حتى ينخفض الاستهلاك.' : 'Current usage exceeds this plan; nothing is deleted but new additions are blocked.'}</div>}
        <div className="row">
          <div className="field" style={{ flex: 1 }}><label>{lang === 'ar' ? 'الحالة' : 'Status'}</label>
            <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{Object.entries(SUB_STATUS).map(([k, v]) => <option key={k} value={k}>{v.ar}</option>)}</select></div>
          <div className="field" style={{ flex: 1 }}><label>{lang === 'ar' ? 'نهاية الفترة' : 'Period end'}</label><input type="date" value={f.currentPeriodEnd} onChange={(e) => setF({ ...f, currentPeriodEnd: e.target.value })} /></div>
        </div>
        <div className="field"><label>{lang === 'ar' ? 'ملاحظات (فوترة، عقد...)' : 'Notes'}</label><textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
        <p className="small muted">{lang === 'ar' ? 'تحصيل اشتراك المنصة يتم خارج النظام حاليًا (فواتير/تحويل). حالة "متأخر السداد" للمتابعة فقط ولا توقف الخدمة تلقائيًا؛ الإيقاف يدوي من حالة الجهة.' : 'Platform billing is collected outside the system for now.'}</p>
        {m.error && <ErrorBox error={m.error} />}
        <button className="btn" disabled={m.isPending || !f.planId}>{lang === 'ar' ? 'حفظ' : 'Save'}</button>
      </form>
    </Modal>
  );
}

function AccessModal({ tenant, onClose, onGranted }: { tenant: any; onClose: () => void; onGranted: (gid: string) => void }) {
  const { lang } = useI18n();
  const [f, setF] = useState({ reason: '', durationMinutes: 30, ticketRef: '' });
  const m = useMutation({
    mutationFn: () => api('POST', '/platform/access-grants', { tenantId: tenant.id, reason: f.reason, durationMinutes: Number(f.durationMinutes), ...(f.ticketRef ? { ticketRef: Number(f.ticketRef) } : {}) }),
    onSuccess: (r) => onGranted(r.grant.id),
  });
  return (
    <Modal title={`${lang === 'ar' ? 'وصول دعم مؤقت' : 'Temporary support access'}: ${tenant.name}`} onClose={onClose}>
      <div className="alert warn small" style={{ marginBottom: 12 }}>
        {lang === 'ar'
          ? 'وصول للقراءة فقط ولمدة محددة. سيُبلَّغ مدير الجهة فورًا، ويُسجَّل سببك وكل صفحة تطّلع عليها في سجل تدقيق الجهة، ويستطيع إنهاء الوصول في أي وقت. استخدمه فقط عند الحاجة الفعلية لحل مشكلة.'
          : 'Read-only and time-limited. The organization admin is notified, your reason and every page you view are logged, and they can revoke access anytime.'}
      </div>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
        <div className="field"><label>{lang === 'ar' ? 'السبب (إلزامي، 15 حرفًا على الأقل)' : 'Reason (required)'}</label><textarea rows={3} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} required minLength={15} /></div>
        <div className="row">
          <div className="field" style={{ flex: 1 }}><label>{lang === 'ar' ? 'المدة' : 'Duration'}</label>
            <select value={f.durationMinutes} onChange={(e) => setF({ ...f, durationMinutes: Number(e.target.value) })}>{[15, 30, 45, 60].map((n) => <option key={n} value={n}>{n} {lang === 'ar' ? 'دقيقة' : 'min'}</option>)}</select></div>
          <div className="field" style={{ flex: 1 }}><label>{lang === 'ar' ? 'رقم التذكرة المرتبطة (اختياري)' : 'Ticket # (optional)'}</label><input dir="ltr" value={f.ticketRef} onChange={(e) => setF({ ...f, ticketRef: e.target.value.replace(/\D/g, '') })} /></div>
        </div>
        {m.error && <ErrorBox error={m.error} />}
        <button className="btn" disabled={m.isPending || f.reason.trim().length < 15}>{lang === 'ar' ? 'فتح الوصول والانتقال للجهة' : 'Open access'}</button>
      </form>
    </Modal>
  );
}

export function PlatformPlans() {
  const { lang } = useI18n();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<any>(null);
  const q = useQuery({ queryKey: ['p-plans'], queryFn: () => api('GET', '/platform/plans') });
  const me = useQuery({ queryKey: ['p-tenants'], queryFn: () => api('GET', '/platform/tenants') });
  const canManage = !!me.data?.canManage;
  const lim = (v: number | null) => (v == null ? '∞' : v);
  return (
    <div className="card">
      <div className="row between"><h2>{lang === 'ar' ? 'خطط الاشتراك' : 'Subscription plans'}</h2>{canManage && <button className="btn" onClick={() => setEditing({})}>+ {lang === 'ar' ? 'خطة' : 'Plan'}</button>}</div>
      <p className="small muted">{lang === 'ar' ? 'الحدود تُفرض تلقائيًا في قاعدة البيانات عند إضافة طلاب أو باصات أو سائقين، وحد المساعد يومي للجهة. الأسعار للعرض والمتابعة فقط — حدّدها أنت.' : 'Limits are enforced automatically. Prices are for reference — set them yourself.'}</p>
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (
        <div className="table-wrap"><table>
          <thead><tr><th>{lang === 'ar' ? 'الخطة' : 'Plan'}</th><th>{lang === 'ar' ? 'طلاب' : 'Students'}</th><th>{lang === 'ar' ? 'باصات' : 'Buses'}</th><th>{lang === 'ar' ? 'سائقون' : 'Drivers'}</th><th>{lang === 'ar' ? 'رسائل المساعد/يوم' : 'Assistant/day'}</th><th>{lang === 'ar' ? 'السعر الشهري' : 'Monthly price'}</th><th>{lang === 'ar' ? 'جهات' : 'Orgs'}</th><th></th></tr></thead>
          <tbody>{q.data.plans.map((p: any) => (
            <tr key={p.id}>
              <td>{p.name} <code className="small">{p.code}</code> {!p.active && <span className="badge gray">{lang === 'ar' ? 'غير نشطة' : 'inactive'}</span>}</td>
              <td>{lim(p.maxStudents)}</td><td>{lim(p.maxBuses)}</td><td>{lim(p.maxDrivers)}</td><td>{lim(p.assistantDailyLimit)}</td>
              <td>{p.monthlyPrice == null ? <span className="muted">{lang === 'ar' ? 'غير محدد' : 'not set'}</span> : `${p.monthlyPrice} ${p.currency}`}</td>
              <td>{p.tenantCount}</td>
              <td>{canManage && <button className="btn sm secondary" onClick={() => setEditing(p)}>{lang === 'ar' ? 'تعديل' : 'Edit'}</button>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {editing && <PlanModal plan={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); qc.invalidateQueries({ queryKey: ['p-plans'] }); qc.invalidateQueries({ queryKey: ['p-tenants'] }); }} />}
    </div>
  );
}

function PlanModal({ plan, onClose, onSaved }: { plan: any; onClose: () => void; onSaved: () => void }) {
  const { lang } = useI18n();
  const n = (v: any) => (v == null ? '' : String(v));
  const [f, setF] = useState({
    code: plan.code ?? '', name: plan.name ?? '', maxStudents: n(plan.maxStudents), maxBuses: n(plan.maxBuses), maxDrivers: n(plan.maxDrivers),
    assistantDailyLimit: n(plan.assistantDailyLimit), monthlyPrice: n(plan.monthlyPrice), currency: plan.currency ?? 'SAR', active: plan.active ?? true,
  });
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  const m = useMutation({
    mutationFn: () => {
      const body = { name: f.name, maxStudents: num(f.maxStudents), maxBuses: num(f.maxBuses), maxDrivers: num(f.maxDrivers), assistantDailyLimit: num(f.assistantDailyLimit), monthlyPrice: num(f.monthlyPrice), currency: f.currency, active: f.active };
      return plan.id ? api('PATCH', `/platform/plans/${plan.id}`, body) : api('POST', '/platform/plans', { ...body, code: f.code });
    },
    onSuccess: onSaved,
  });
  const field = (k: keyof typeof f, label: string, hint?: string) => (
    <div className="field" style={{ flex: 1 }}><label>{label}</label><input type="number" min={0} value={f[k] as string} onChange={(e) => setF({ ...f, [k]: e.target.value })} />{hint && <span className="hint">{hint}</span>}</div>
  );
  return (
    <Modal title={plan.id ? (lang === 'ar' ? 'تعديل خطة' : 'Edit plan') : (lang === 'ar' ? 'خطة جديدة' : 'New plan')} onClose={onClose}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
        <div className="row">
          {!plan.id && <div className="field" style={{ flex: 1 }}><label>{lang === 'ar' ? 'الرمز (إنجليزي صغير)' : 'Code'}</label><input dir="ltr" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} required pattern="[a-z0-9_-]{2,30}" /></div>}
          <div className="field" style={{ flex: 2 }}><label>{lang === 'ar' ? 'الاسم' : 'Name'}</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></div>
        </div>
        <p className="small muted">{lang === 'ar' ? 'اترك الحقل فارغًا = بلا حد.' : 'Leave empty for unlimited.'}</p>
        <div className="row">{field('maxStudents', lang === 'ar' ? 'حد الطلاب' : 'Students')}{field('maxBuses', lang === 'ar' ? 'حد الباصات' : 'Buses')}{field('maxDrivers', lang === 'ar' ? 'حد السائقين' : 'Drivers')}</div>
        <div className="row">{field('assistantDailyLimit', lang === 'ar' ? 'رسائل المساعد يوميًا' : 'Assistant msgs/day')}{field('monthlyPrice', lang === 'ar' ? 'السعر الشهري' : 'Monthly price')}
          <div className="field" style={{ flex: 1 }}><label>{lang === 'ar' ? 'العملة' : 'Currency'}</label><input dir="ltr" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} maxLength={3} /></div></div>
        <label className="row" style={{ marginBottom: 12 }}><input type="checkbox" style={{ width: 'auto', minHeight: 0 }} checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />{lang === 'ar' ? 'نشطة (متاحة للجهات الجديدة)' : 'Active'}</label>
        {m.error && <ErrorBox error={m.error} />}
        <button className="btn" disabled={m.isPending}>{lang === 'ar' ? 'حفظ' : 'Save'}</button>
      </form>
    </Modal>
  );
}

export function PlatformStaff() {
  const { lang } = useI18n();
  const qc = useQueryClient();
  const [inviting, setInviting] = useState(false);
  const [f, setF] = useState({ fullName: '', email: '', role: 'support' });
  const q = useQuery({ queryKey: ['p-staff'], queryFn: () => api('GET', '/platform/staff') });
  const inv = useMutation({ mutationFn: () => api('POST', '/platform/staff/invites', f), onSuccess: () => qc.invalidateQueries({ queryKey: ['p-staff'] }) });
  const role = useMutation({ mutationFn: (p: { id: string; role: string | null }) => api('PATCH', `/platform/staff/${p.id}`, { role: p.role }), onSuccess: () => qc.invalidateQueries({ queryKey: ['p-staff'] }) });
  const revoke = useMutation({ mutationFn: (id: string) => api('POST', `/platform/staff/invites/${id}/revoke`, {}), onSuccess: () => qc.invalidateQueries({ queryKey: ['p-staff'] }) });
  const R: Record<string, string> = { admin: lang === 'ar' ? 'مدير المنصة' : 'Admin', support: lang === 'ar' ? 'دعم المنصة' : 'Support' };
  return (
    <div className="stack">
      <div className="card">
        <div className="row between"><h2>{lang === 'ar' ? 'فريق المنصة' : 'Platform team'}</h2><button className="btn" onClick={() => { inv.reset(); setInviting(true); }}>+ {lang === 'ar' ? 'دعوة' : 'Invite'}</button></div>
        <p className="small muted">{lang === 'ar' ? 'مدير المنصة: كل الصلاحيات. دعم المنصة: التذاكر، دليل التطبيق، عرض الجهات، وطلب وصول مؤقت للقراءة — دون إنشاء أو إيقاف جهات أو تعديل الاشتراكات.' : 'Admin: everything. Support: tickets, app guide, view organizations and request read-only access.'}</p>
        {q.isLoading && <Loading />}
        {q.error && <ErrorBox error={q.error} />}
        {role.error && <ErrorBox error={role.error} />}
        {q.data && (
          <table><tbody>{q.data.staff.map((u: any) => (
            <tr key={u.id}>
              <td>{u.fullName}<div className="small muted" dir="ltr">{u.email}</div></td>
              <td><select value={u.role} onChange={(e) => role.mutate({ id: u.id, role: e.target.value })} style={{ width: 150 }}>
                <option value="admin">{R.admin}</option><option value="support">{R.support}</option></select></td>
              <td><button className="btn sm ghost" onClick={() => confirm(lang === 'ar' ? 'إزالة من فريق المنصة؟' : 'Remove from team?') && role.mutate({ id: u.id, role: null })}>{lang === 'ar' ? 'إزالة' : 'Remove'}</button></td>
            </tr>
          ))}</tbody></table>
        )}
      </div>
      <div className="card">
        <h3>{lang === 'ar' ? 'الدعوات' : 'Invites'}</h3>
        {q.data && (q.data.invites.length === 0 ? <Empty /> : (
          <table><tbody>{q.data.invites.map((i: any) => {
            const state = i.acceptedAt ? 'accepted' : i.revokedAt ? 'revoked' : new Date(i.expiresAt) < new Date() ? 'expired' : 'pending';
            return (
              <tr key={i.id}><td>{i.fullName}<div className="small muted" dir="ltr">{i.email}</div></td><td>{R[i.role]}</td>
                <td><span className={`badge ${state === 'accepted' ? '' : state === 'pending' ? 'amber' : 'gray'}`}>{state}</span></td>
                <td>{state === 'pending' && <button className="btn sm ghost" onClick={() => revoke.mutate(i.id)}>{lang === 'ar' ? 'إلغاء' : 'Revoke'}</button>}</td></tr>
            );
          })}</tbody></table>
        ))}
      </div>
      {inviting && (
        <Modal title={lang === 'ar' ? 'دعوة لفريق المنصة' : 'Invite to platform team'} onClose={() => setInviting(false)}>
          {inv.data ? (
            <div className="stack">
              <div className="alert info">{lang === 'ar' ? 'أرسل الرابط للشخص المعني فقط (يُعرض مرة واحدة، ولا يُقبل إلا بنفس البريد):' : 'Share only with the invitee (shown once; requires the same email):'}</div>
              <input readOnly dir="ltr" value={inv.data.invite.inviteUrl} onFocus={(e) => e.target.select()} />
              <button className="btn" onClick={() => navigator.clipboard.writeText(inv.data.invite.inviteUrl)}>{lang === 'ar' ? 'نسخ' : 'Copy'}</button>
            </div>
          ) : (
            <form onSubmit={(e: FormEvent) => { e.preventDefault(); inv.mutate(); }}>
              <div className="field"><label>{lang === 'ar' ? 'الاسم' : 'Name'}</label><input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} required minLength={2} /></div>
              <div className="field"><label>{lang === 'ar' ? 'البريد' : 'Email'}</label><input type="email" dir="ltr" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></div>
              <div className="field"><label>{lang === 'ar' ? 'الدور' : 'Role'}</label><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="support">{R.support}</option><option value="admin">{R.admin}</option></select></div>
              {inv.error && <ErrorBox error={inv.error} />}
              <button className="btn" disabled={inv.isPending}>{lang === 'ar' ? 'إنشاء الدعوة' : 'Create invite'}</button>
            </form>
          )}
        </Modal>
      )}
    </div>
  );
}

export function PlatformAccessLog() {
  const { lang } = useI18n();
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['p-grants'], queryFn: () => api('GET', '/platform/access-grants'), refetchInterval: 30_000 });
  const revoke = useMutation({ mutationFn: (id: string) => api('POST', `/platform/access-grants/${id}/revoke`, {}), onSuccess: () => qc.invalidateQueries({ queryKey: ['p-grants'] }) });
  return (
    <div className="card">
      <h2>{lang === 'ar' ? 'سجل الوصول الاستثنائي' : 'Support access log'}</h2>
      <p className="small muted">{lang === 'ar' ? 'كل وصول مؤقت لبيانات جهة: من طلبه، لماذا، مدته، وعدد الصفحات المسجلة. مدير المنصة يرى كل السجل، وموظف الدعم يرى وصوله فقط.' : 'Every temporary access: who, why, how long, pages logged.'}</p>
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (q.data.grants.length === 0 ? <Empty /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>{lang === 'ar' ? 'الجهة' : 'Organization'}</th><th>{lang === 'ar' ? 'الموظف' : 'Staff'}</th><th>{lang === 'ar' ? 'السبب' : 'Reason'}</th><th>{lang === 'ar' ? 'الوقت' : 'Time'}</th><th>{lang === 'ar' ? 'صفحات' : 'Pages'}</th><th></th></tr></thead>
          <tbody>{q.data.grants.map((g: any) => (
            <tr key={g.id}>
              <td>{g.tenantName}{g.ticketRef && <div className="small muted">#{g.ticketRef}</div>}</td>
              <td>{g.userName}</td>
              <td className="small" style={{ maxWidth: 320 }}>{g.reason}</td>
              <td className="small">{fmtDateTime(g.createdAt, lang)}<div>{g.active ? <span className="badge red">{lang === 'ar' ? 'نشط حتى' : 'active until'} {fmtDateTime(g.expiresAt, lang)}</span> : g.revokedAt ? <span className="badge gray">{lang === 'ar' ? 'أُنهي' : 'revoked'}</span> : <span className="badge gray">{lang === 'ar' ? 'انتهى' : 'expired'}</span>}</div></td>
              <td>{g.viewsLogged}</td>
              <td className="row">{g.active && <>
                <button className="btn sm secondary" onClick={async () => { await selectContext({ accessGrantId: g.id }).catch(() => null); nav('/app'); }}>{lang === 'ar' ? 'فتح' : 'Open'}</button>
                <button className="btn sm ghost" onClick={() => revoke.mutate(g.id)}>{lang === 'ar' ? 'إنهاء' : 'End'}</button>
              </>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ))}
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
