import { useState, type FormEvent } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useI18n, fmtDateTime } from '../../i18n';
import { Empty, ErrorBox, Loading, Modal } from '../../components/ui';

/** إنشاء دعوة وعرض رابطها مرة واحدة (الإرسال بالبريد/SMS غير مُعدّ بعد — يُشارك يدويًا) */
export function InviteResult({ role: initialRole, studentIds = [], defaultName = '', onClose }: { role?: string; studentIds?: string[]; defaultName?: string; onClose: () => void }) {
  const { t, lang } = useI18n();
  const ctx = useOutletContext<{ role: string }>();
  const [f, setF] = useState({ role: initialRole ?? 'driver', fullName: defaultName, email: '', phone: '' });
  const [copied, setCopied] = useState(false);
  const m = useMutation({
    mutationFn: () => api('POST', '/tenant/invites', {
      role: f.role, fullName: f.fullName, studentIds,
      ...(f.email ? { email: f.email } : {}), ...(f.phone ? { phone: f.phone } : {}),
    }),
  });
  const roles = ctx?.role === 'tenant_admin' ? ['parent', 'driver', 'supervisor', 'tenant_admin'] : ['parent', 'driver'];
  return (
    <Modal title={lang === 'ar' ? 'دعوة مستخدم' : 'Invite user'} onClose={onClose}>
      {!m.data ? (
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
          {!initialRole && (
            <div className="field"><label>{lang === 'ar' ? 'الدور' : 'Role'}</label>
              <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{roles.map((r) => <option key={r} value={r}>{t(`role_${r}` as any)}</option>)}</select>
            </div>
          )}
          <div className="field"><label>{lang === 'ar' ? 'الاسم' : 'Name'}</label><input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} required minLength={2} /></div>
          <div className="field"><label>{lang === 'ar' ? 'البريد الإلكتروني (موصى به)' : 'Email (recommended)'}</label><input type="email" dir="ltr" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
            <span className="hint">{lang === 'ar' ? 'إن أُدخل، لا تُقبل الدعوة إلا بنفس البريد.' : 'If set, the invite can only be accepted with this email.'}</span></div>
          <div className="field"><label>{lang === 'ar' ? 'رقم الجوال' : 'Phone'}</label><input dir="ltr" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="+9665XXXXXXXX" /></div>
          {m.error && <ErrorBox error={m.error} />}
          <button className="btn" disabled={m.isPending}>{lang === 'ar' ? 'إنشاء الدعوة' : 'Create invite'}</button>
        </form>
      ) : (
        <div className="stack">
          <div className="alert info">{lang === 'ar' ? 'شارك هذا الرابط مع الشخص المعني فقط. يُعرض مرة واحدة، صالح لمرة واحدة، وينتهي في:' : 'Share this link only with the invitee. Shown once, single-use, expires:'} {fmtDateTime(m.data.invite.expiresAt, lang)}</div>
          <input readOnly dir="ltr" value={m.data.invite.inviteUrl} onFocus={(e) => e.target.select()} />
          <div className="row">
            <button className="btn" onClick={() => navigator.clipboard.writeText(m.data.invite.inviteUrl).then(() => setCopied(true))}>{copied ? '✓' : lang === 'ar' ? 'نسخ الرابط' : 'Copy link'}</button>
            <button className="btn secondary" onClick={onClose}>{t('close')}</button>
          </div>
          <div className="small muted">{lang === 'ar' ? 'الإرسال التلقائي بالبريد أو الرسائل النصية يتطلب ربط مزود خارجي (غير مُعدّ حاليًا).' : 'Automatic email/SMS delivery requires an external provider (not configured).'}</div>
        </div>
      )}
    </Modal>
  );
}

export function Team() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const ctx = useOutletContext<{ role: string }>();
  const [role, setRole] = useState('');
  const [inviting, setInviting] = useState(false);
  const members = useQuery({ queryKey: ['members', role], queryFn: () => api('GET', `/tenant/members${role ? `?role=${role}` : ''}`) });
  const invites = useQuery({ queryKey: ['invites'], queryFn: () => api('GET', '/tenant/invites') });
  const setStatus = useMutation({ mutationFn: (p: { id: string; status: string }) => api('PATCH', `/tenant/members/${p.id}`, { status: p.status }), onSuccess: () => qc.invalidateQueries({ queryKey: ['members'] }) });
  const revoke = useMutation({ mutationFn: (id: string) => api('POST', `/tenant/invites/${id}/revoke`), onSuccess: () => qc.invalidateQueries({ queryKey: ['invites'] }) });
  const isAdmin = ctx?.role === 'tenant_admin';
  return (
    <div className="stack">
      <div className="card">
        <div className="row between">
          <h2>{t('team')}</h2>
          <div className="row">
            <select value={role} onChange={(e) => setRole(e.target.value)} style={{ width: 180 }}>
              <option value="">{lang === 'ar' ? 'كل الأدوار' : 'All roles'}</option>
              {['tenant_admin', 'supervisor', 'driver', 'parent'].map((r) => <option key={r} value={r}>{t(`role_${r}` as any)}</option>)}
            </select>
            <button className="btn" onClick={() => setInviting(true)}>+ {lang === 'ar' ? 'دعوة' : 'Invite'}</button>
          </div>
        </div>
        {members.isLoading && <Loading />}
        {members.error && <ErrorBox error={members.error} />}
        {members.data && (members.data.members.length === 0 ? <Empty /> : (
          <div className="table-wrap"><table>
            <thead><tr><th>{lang === 'ar' ? 'الاسم' : 'Name'}</th><th>{lang === 'ar' ? 'الدور' : 'Role'}</th><th>{lang === 'ar' ? 'التواصل' : 'Contact'}</th><th>{lang === 'ar' ? 'الحالة' : 'Status'}</th><th></th></tr></thead>
            <tbody>{members.data.members.map((m: any) => (
              <tr key={m.id}>
                <td>{m.fullName}{m.role === 'parent' && <div className="small muted">{m.childrenCount} {lang === 'ar' ? 'أبناء' : 'children'}</div>}</td>
                <td>{t(`role_${m.role}` as any)}</td>
                <td dir="ltr" className="small">{m.phone ?? m.email}</td>
                <td><span className={`badge ${m.status === 'active' ? '' : 'gray'}`}>{m.status}</span></td>
                <td>{isAdmin && <button className="btn sm ghost" onClick={() => setStatus.mutate({ id: m.id, status: m.status === 'active' ? 'disabled' : 'active' })}>{m.status === 'active' ? (lang === 'ar' ? 'إيقاف' : 'Disable') : (lang === 'ar' ? 'تفعيل' : 'Enable')}</button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ))}
        {setStatus.error && <ErrorBox error={setStatus.error} />}
      </div>
      <div className="card">
        <h2>{lang === 'ar' ? 'الدعوات' : 'Invites'}</h2>
        {invites.data && (invites.data.invites.length === 0 ? <Empty /> : (
          <div className="table-wrap"><table><tbody>{invites.data.invites.map((i: any) => {
            const state = i.acceptedAt ? 'accepted' : i.revokedAt ? 'revoked' : new Date(i.expiresAt) < new Date() ? 'expired' : 'pending';
            return (
              <tr key={i.id}>
                <td>{i.fullName}</td><td>{t(`role_${i.role}` as any)}</td>
                <td><span className={`badge ${state === 'accepted' ? '' : state === 'pending' ? 'amber' : 'gray'}`}>{state}</span></td>
                <td className="small">{fmtDateTime(i.createdAt, lang)}</td>
                <td>{state === 'pending' && <button className="btn sm ghost" onClick={() => revoke.mutate(i.id)}>{lang === 'ar' ? 'إلغاء' : 'Revoke'}</button>}</td>
              </tr>
            );
          })}</tbody></table></div>
        ))}
      </div>
      {inviting && <InviteResult onClose={() => { setInviting(false); qc.invalidateQueries({ queryKey: ['invites'] }); }} />}
    </div>
  );
}
