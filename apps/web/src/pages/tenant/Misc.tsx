import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useI18n, fmtDateTime } from '../../i18n';
import { Empty, ErrorBox, Loading } from '../../components/ui';

export function Absences() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const [status, setStatus] = useState('pending');
  const q = useQuery({ queryKey: ['absences', status], queryFn: () => api('GET', `/tenant/absences?status=${status}`) });
  const review = useMutation({ mutationFn: (p: { id: string; decision: string }) => api('POST', `/tenant/absences/${p.id}/review`, { decision: p.decision }), onSuccess: () => qc.invalidateQueries({ queryKey: ['absences'] }) });
  return (
    <div className="card">
      <div className="row between">
        <h2>{t('absences')}</h2>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 180 }}>
          {['pending', 'approved', 'rejected', 'cancelled'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {review.error && <ErrorBox error={review.error} />}
      {q.data && (q.data.absences.length === 0 ? <Empty /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>{lang === 'ar' ? 'الطالب' : 'Student'}</th><th>{lang === 'ar' ? 'التاريخ' : 'Date'}</th><th>{lang === 'ar' ? 'الرحلة' : 'Trip'}</th><th>{lang === 'ar' ? 'السبب' : 'Reason'}</th><th>{lang === 'ar' ? 'مقدم الطلب' : 'Requested by'}</th><th></th></tr></thead>
          <tbody>{q.data.absences.map((a: any) => (
            <tr key={a.id}>
              <td>{a.studentName}</td><td>{a.date}</td><td>{t(`dir_${a.direction}` as any)}</td><td>{a.reason ?? '—'}</td><td>{a.requestedBy}</td>
              <td className="row">{a.status === 'pending' && <>
                <button className="btn sm" onClick={() => review.mutate({ id: a.id, decision: 'approved' })}>{lang === 'ar' ? 'اعتماد' : 'Approve'}</button>
                <button className="btn sm secondary" onClick={() => review.mutate({ id: a.id, decision: 'rejected' })}>{lang === 'ar' ? 'رفض' : 'Reject'}</button>
              </>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ))}
      <p className="small muted">{lang === 'ar' ? 'إن كانت سياسة الجهة "اعتماد تلقائي" (الإعدادات)، تُعتمد طلبات أولياء الأمور فورًا وتظهر هنا كمعتمدة.' : 'With auto-approve enabled in settings, parent requests are approved immediately.'}</p>
    </div>
  );
}

export function Settings() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['profile'], queryFn: () => api('GET', '/tenant/profile') });
  const [f, setF] = useState<any>(null);
  useEffect(() => {
    if (q.data) setF({ ...q.data.tenant, settings: { ...q.data.tenant.settings } });
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api('PATCH', '/tenant/profile', {
      name: f.name, nameEn: f.nameEn || null, logoUrl: f.logoUrl || null, contactPhone: f.contactPhone || null, contactEmail: f.contactEmail || null,
      settings: f.settings,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['profile'] }); qc.invalidateQueries({ queryKey: ['me'] }); },
  });
  if (q.isLoading || !f) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const s = f.settings;
  const setS = (k: string, v: unknown) => setF({ ...f, settings: { ...s, [k]: v } });
  const num = (k: string, label: string, hint?: string) => (
    <div className="field"><label>{label}</label><input type="number" value={s[k]} onChange={(e) => setS(k, Number(e.target.value))} />{hint && <span className="hint">{hint}</span>}</div>
  );
  const bool = (k: string, label: string) => (
    <label className="row" style={{ marginBottom: 12 }}><input type="checkbox" style={{ width: 'auto', minHeight: 0 }} checked={!!s[k]} onChange={(e) => setS(k, e.target.checked)} />{label}</label>
  );
  return (
    <div className="stack">
    <div className="grid cols-2">
      <div className="card">
        <h2>{lang === 'ar' ? 'بيانات الجهة والشعار' : 'Organization & branding'}</h2>
        <div className="field"><label>{lang === 'ar' ? 'الاسم' : 'Name'}</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div className="field"><label>{lang === 'ar' ? 'الاسم بالإنجليزية' : 'English name'}</label><input value={f.nameEn ?? ''} onChange={(e) => setF({ ...f, nameEn: e.target.value })} /></div>
        <div className="field"><label>{lang === 'ar' ? 'رابط الشعار (https)' : 'Logo URL (https)'}</label><input dir="ltr" value={f.logoUrl ?? ''} onChange={(e) => setF({ ...f, logoUrl: e.target.value })} />
          <span className="hint">{lang === 'ar' ? 'رفع الملفات مباشرة يتطلب إعداد تخزين ملفات (مرحلة لاحقة).' : 'Direct upload needs file storage (later phase).'}</span></div>
        <div className="field"><label>{lang === 'ar' ? 'هاتف مسؤول النقل (يظهر للسائق في الطوارئ)' : 'Transport contact phone (shown to drivers)'}</label><input dir="ltr" value={f.contactPhone ?? ''} onChange={(e) => setF({ ...f, contactPhone: e.target.value })} /></div>
        <div className="field"><label>{lang === 'ar' ? 'بريد التواصل' : 'Contact email'}</label><input dir="ltr" value={f.contactEmail ?? ''} onChange={(e) => setF({ ...f, contactEmail: e.target.value })} /></div>
        <div className="small muted">{lang === 'ar' ? 'رمز الجهة' : 'Code'}: <code>{f.code}</code> · {lang === 'ar' ? 'رابط الجهة' : 'Link'}: <code dir="ltr">{location.origin}/t/{f.code}</code></div>
      </div>
      <div className="card">
        <h2>{lang === 'ar' ? 'سياسات التشغيل' : 'Operating policies'}</h2>
        {num('locationIntervalSec', lang === 'ar' ? 'فاصل إرسال الموقع (ثوانٍ)' : 'Location interval (sec)', lang === 'ar' ? 'أقل = دقة أعلى واستهلاك بطارية أكبر' : 'Lower = more precise, more battery')}
        {num('staleAfterSec', lang === 'ar' ? 'يُعتبر الموقع قديمًا بعد (ثوانٍ)' : 'Location stale after (sec)')}
        {num('locationRetentionDays', lang === 'ar' ? 'مدة الاحتفاظ بإحداثيات الباص (أيام)' : 'Location retention (days)', lang === 'ar' ? 'تُحذف الإحداثيات الأقدم تلقائيًا' : 'Older points are deleted automatically')}
        {num('delayThresholdMin', lang === 'ar' ? 'حد التأخر في البدء (دقائق)' : 'Late-start threshold (min)')}
        {num('inspectionDeadlineMin', lang === 'ar' ? 'مهلة فحص خلو الباص بعد الرحلة (دقائق)' : 'Bus-check deadline (min)')}
        {num('locationLostAfterMin', lang === 'ar' ? 'تنبيه انقطاع الموقع بعد (دقائق)' : 'Location-lost alert after (min)')}
        <div className="field"><label>{lang === 'ar' ? 'رقم الطوارئ' : 'Emergency number'}</label><input dir="ltr" value={s.emergencyNumber} onChange={(e) => setS('emergencyNumber', e.target.value)} /></div>
        <div className="field"><label>{lang === 'ar' ? 'أوقات الدعم (نص يظهر لأولياء الأمور)' : 'Support hours'}</label><input value={s.supportHours ?? ''} onChange={(e) => setS('supportHours', e.target.value || null)} /></div>
        {bool('parentTrackingEnabled', lang === 'ar' ? 'السماح لأولياء الأمور بتتبع الباص أثناء الرحلة' : 'Allow parents to track bus during trips')}
        {num('approachAlertDefaultM', lang === 'ar' ? 'مسافة تنبيه «الباص اقترب» الافتراضية (متر، 0 = معطّل)' : 'Default "bus approaching" distance (m, 0 = off)', lang === 'ar' ? 'يستطيع ولي الأمر تغييرها لأبنائه من التطبيق' : 'Parents can change it per child in the app')}
        {bool('absenceAutoApprove', lang === 'ar' ? 'اعتماد طلبات الغياب تلقائيًا' : 'Auto-approve absence requests')}
        <h3 style={{ marginTop: 16 }}>{lang === 'ar' ? 'مساعد باصنا' : 'Assistant'}</h3>
        {bool('assistantEnabled', lang === 'ar' ? 'تفعيل المساعد الآلي لمستخدمي الجهة' : 'Enable the assistant')}
        {num('assistantDailyLimitPerUser', lang === 'ar' ? 'حد الرسائل اليومي لكل مستخدم' : 'Daily messages per user')}
        {num('assistantDailyLimitTenant', lang === 'ar' ? 'حد الرسائل اليومي للجهة (للتحكم بالتكلفة)' : 'Daily messages per organization (cost cap)')}
        {num('assistantRetentionDays', lang === 'ar' ? 'مدة الاحتفاظ بالمحادثات (أيام)' : 'Conversation retention (days)', lang === 'ar' ? 'تُحذف المحادثات الأقدم تلقائيًا' : 'Older conversations are deleted automatically')}
        {bool('requireRearQrScan', lang === 'ar' ? 'إلزام السائق بمسح رمز مؤخرة الباص في الفحص' : 'Require rear-of-bus QR scan in inspection')}
        {save.error && <ErrorBox error={save.error} />}
        {save.isSuccess && <div className="alert info">✓</div>}
        <button className="btn" onClick={() => save.mutate()} disabled={save.isPending}>{t('save')}</button>
      </div>
    </div>
    <div className="grid cols-2">
      <SubscriptionCard />
      <SupportAccessCard allowed={s.allowPlatformSupportAccess} onToggle={(v) => setS('allowPlatformSupportAccess', v)} />
    </div>
    </div>
  );
}

function Bar({ label, used, max }: { label: string; used: number; max: number | null }) {
  const { lang } = useI18n();
  const pct = max == null ? 0 : Math.min(100, Math.round((used / max) * 100));
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="row between small"><span>{label}</span><span>{lang === 'ar' ? max == null ? `${used} (بلا حد)` : `${used} من ${max}` : `${used} / ${max ?? '∞'}`}</span></div>
      {max != null && <div style={{ height: 8, background: 'var(--line)', borderRadius: 4 }}><div style={{ width: `${pct}%`, height: 8, borderRadius: 4, background: pct >= 100 ? 'var(--red)' : pct >= 80 ? 'var(--amber)' : 'var(--green-600)' }} /></div>}
    </div>
  );
}

/** الاشتراك في منصة باصنا واستهلاك الحدود */
function SubscriptionCard() {
  const { lang } = useI18n();
  const q = useQuery({ queryKey: ['subscription'], queryFn: () => api('GET', '/tenant/subscription') });
  const st: Record<string, string> = { trial: 'تجريبي', active: 'فعّال', past_due: 'متأخر السداد', cancelled: 'ملغى' };
  const sub = q.data?.subscription;
  return (
    <div className="card">
      <h2>{lang === 'ar' ? 'الاشتراك في منصة باصنا' : 'Busna subscription'}</h2>
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && !sub && <Empty>{lang === 'ar' ? 'لا يوجد اشتراك مسجل. تواصل مع إدارة منصة باصنا.' : 'No subscription on file.'}</Empty>}
      {sub && (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            <strong>{sub.plan_name}</strong><span className="badge">{st[sub.status] ?? sub.status}</span>
            {sub.current_period_end && <span className="small muted">{lang === 'ar' ? 'حتى' : 'until'} {sub.current_period_end}</span>}
          </div>
          <Bar label={lang === 'ar' ? 'الطلاب النشطون' : 'Active students'} used={sub.students} max={sub.max_students} />
          <Bar label={lang === 'ar' ? 'الباصات' : 'Buses'} used={sub.buses} max={sub.max_buses} />
          <Bar label={lang === 'ar' ? 'السائقون' : 'Drivers'} used={sub.drivers} max={sub.max_drivers} />
          <div className="small muted">{lang === 'ar' ? `رسائل المساعد اليومية للجهة: ${sub.assistant_daily_limit ?? 'بلا حد'}. للترقية تواصل مع دعم منصة باصنا من «تذاكر الدعم».` : `Assistant daily messages: ${sub.assistant_daily_limit ?? 'unlimited'}. Contact Busna support to upgrade.`}</div>
        </>
      )}
    </div>
  );
}

/** وصول دعم منصة باصنا لبيانات الجهة: شفافية كاملة وقدرة على الإنهاء أو المنع */
function SupportAccessCard({ allowed, onToggle }: { allowed: boolean; onToggle: (v: boolean) => void }) {
  const { lang } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['support-access'], queryFn: () => api('GET', '/tenant/support-access') });
  const revoke = useMutation({ mutationFn: (id: string) => api('POST', `/tenant/support-access/${id}/revoke`, {}), onSuccess: () => qc.invalidateQueries({ queryKey: ['support-access'] }) });
  return (
    <div className="card">
      <h2>{lang === 'ar' ? 'وصول دعم منصة باصنا' : 'Busna support access'}</h2>
      <p className="small muted">{lang === 'ar' ? 'عند حاجة فريق دعم باصنا للاطلاع على بياناتكم لحل مشكلة، يفتح وصولًا مؤقتًا (ساعة كحد أقصى) للقراءة فقط وبسبب مكتوب. يصلكم إشعار، وتُسجَّل كل صفحة في سجل التدقيق.' : 'Temporary, read-only, reasoned and audited access by Busna support.'}</p>
      <label className="row" style={{ marginBottom: 12 }}>
        <input type="checkbox" style={{ width: 'auto', minHeight: 0 }} checked={allowed} onChange={(e) => onToggle(e.target.checked)} />
        {lang === 'ar' ? 'السماح لدعم المنصة بطلب وصول مؤقت (احفظ الإعدادات بعد التغيير)' : 'Allow platform support to request temporary access (save settings)'}
      </label>
      {q.data && (q.data.grants.length === 0 ? <Empty>{lang === 'ar' ? 'لم يحدث أي وصول.' : 'No access so far.'}</Empty> : (
        <table><tbody>{q.data.grants.map((g: any) => (
          <tr key={g.id}>
            <td className="small">{g.reason}<div className="muted">{fmtDateTime(g.createdAt, lang)} · {g.viewsLogged} {lang === 'ar' ? 'صفحة مسجلة' : 'pages logged'}</div></td>
            <td>{g.active
              ? <button className="btn sm danger" onClick={() => revoke.mutate(g.id)}>{lang === 'ar' ? 'إنهاء الآن' : 'End now'}</button>
              : <span className="badge gray">{g.revokedAt ? (lang === 'ar' ? 'أُنهي' : 'revoked') : (lang === 'ar' ? 'انتهى' : 'expired')}</span>}</td>
          </tr>
        ))}</tbody></table>
      ))}
      {revoke.error && <ErrorBox error={revoke.error} />}
    </div>
  );
}

export function Audit() {
  const { t, lang } = useI18n();
  const q = useQuery({ queryKey: ['audit'], queryFn: () => api('GET', '/tenant/audit') });
  return (
    <div className="card">
      <h2>{t('audit')}</h2>
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (q.data.entries.length === 0 ? <Empty /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>{lang === 'ar' ? 'الوقت' : 'Time'}</th><th>{lang === 'ar' ? 'المنفذ' : 'Actor'}</th><th>{lang === 'ar' ? 'الإجراء' : 'Action'}</th><th>{lang === 'ar' ? 'التفاصيل' : 'Details'}</th></tr></thead>
          <tbody>{q.data.entries.map((e: any) => (
            <tr key={e.id}>
              <td className="small">{fmtDateTime(e.createdAt, lang)}</td>
              <td>{e.actorName ?? '—'}<div className="small muted">{e.actorRole}</div></td>
              <td><code className="small">{e.action}</code></td>
              <td className="small" style={{ maxWidth: 380, wordBreak: 'break-word' }}>{Object.keys(e.details ?? {}).length ? JSON.stringify(e.details) : ''}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ))}
    </div>
  );
}
