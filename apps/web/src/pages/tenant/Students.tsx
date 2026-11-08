import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { api } from '../../api';
import { useI18n, fmtDateTime } from '../../i18n';
import { Empty, ErrorBox, Loading, Modal } from '../../components/ui';
import { InviteResult } from './Team';

export function Students() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const list = useQuery({ queryKey: ['students', q], queryFn: () => api('GET', `/tenant/students${q ? `?q=${encodeURIComponent(q)}` : ''}`) });
  return (
    <div className="card">
      <div className="row between">
        <h2>{t('students')}</h2>
        <div className="row">
          <input placeholder={t('search')} value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
          <button className="btn" onClick={() => setAdding(true)}>+ {t('add')}</button>
        </div>
      </div>
      {list.isLoading && <Loading />}
      {list.error && <ErrorBox error={list.error} onRetry={() => list.refetch()} />}
      {list.data && (list.data.students.length === 0 ? <Empty /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>{lang === 'ar' ? 'الاسم' : 'Name'}</th><th>{lang === 'ar' ? 'الصف' : 'Grade'}</th><th>{t('routes')}</th><th>{lang === 'ar' ? 'أولياء الأمور' : 'Guardians'}</th><th></th></tr></thead>
          <tbody>
            {list.data.students.map((s: any) => (
              <tr key={s.id}>
                <td><Link to={`/app/students/${s.id}`}>{s.fullName}</Link>{s.status !== 'active' && <span className="badge gray"> {s.status}</span>}</td>
                <td>{s.grade ?? '—'}</td>
                <td>{s.routes?.length ? s.routes.map((r: any) => <div key={r.routeId} className="small">{r.routeName} · {r.stopName}</div>) : <span className="badge amber">{lang === 'ar' ? 'غير معيّن' : 'Unassigned'}</span>}</td>
                <td>{s.guardianCount || <span className="badge amber">0</span>}</td>
                <td><Link to={`/app/students/${s.id}`}>{t('edit')}</Link></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      ))}
      {adding && <StudentForm onClose={() => setAdding(false)} onSaved={() => { setAdding(false); qc.invalidateQueries({ queryKey: ['students'] }); }} />}
    </div>
  );
}

function StudentForm({ initial, onClose, onSaved }: { initial?: any; onClose: () => void; onSaved: (id: string) => void }) {
  const { t, lang } = useI18n();
  const [f, setF] = useState({ fullName: initial?.fullName ?? '', grade: initial?.grade ?? '', schoolName: initial?.schoolName ?? '', studentCode: initial?.studentCode ?? '', notes: initial?.notes ?? '' });
  const m = useMutation({
    mutationFn: () => {
      const body = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim() || null]));
      return initial ? api('PATCH', `/tenant/students/${initial.id}`, body) : api('POST', '/tenant/students', body);
    },
    onSuccess: (r: any) => onSaved(r.student?.id ?? initial?.id),
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title={initial ? t('edit') : lang === 'ar' ? 'إضافة طالب' : 'Add student'} onClose={onClose}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
        <div className="field"><label>{lang === 'ar' ? 'الاسم الكامل *' : 'Full name *'}</label><input value={f.fullName} onChange={set('fullName')} required minLength={2} /></div>
        <div className="row">
          <div className="field" style={{ flex: 1 }}><label>{lang === 'ar' ? 'الصف' : 'Grade'}</label><input value={f.grade} onChange={set('grade')} /></div>
          <div className="field" style={{ flex: 1 }}><label>{lang === 'ar' ? 'الرقم المدرسي' : 'Student ID'}</label><input value={f.studentCode} onChange={set('studentCode')} /></div>
        </div>
        <div className="field"><label>{lang === 'ar' ? 'المدرسة (لشركات النقل)' : 'School (for transport companies)'}</label><input value={f.schoolName} onChange={set('schoolName')} /></div>
        <div className="field"><label>{lang === 'ar' ? 'ملاحظات للإدارة (لا تظهر للسائق)' : 'Admin notes (hidden from driver)'}</label><textarea rows={2} value={f.notes} onChange={set('notes')} /></div>
        {m.error && <ErrorBox error={m.error} />}
        <button className="btn" disabled={m.isPending}>{t('save')}</button>
      </form>
    </Modal>
  );
}

function QrCard({ studentName, token, tenantName }: { studentName: string; token: string; tenantName: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    // البطاقة تحمل رمزًا عشوائيًا فقط — بدون اسم أو رقم هوية داخل الرمز
    QRCode.toDataURL(token, { margin: 1, width: 400 }).then(setSrc);
  }, [token]);
  return (
    <div className="qr-card">
      <div style={{ fontWeight: 700 }}>{tenantName}</div>
      {src && <img src={src} alt="QR" />}
      <div>{studentName.split(' ')[0]}</div>
      <div className="small muted">بطاقة نقل — معرّف مساعد فقط</div>
    </div>
  );
}

export function StudentDetail() {
  const { id = '' } = useParams();
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const q = useQuery({ queryKey: ['student', id], queryFn: () => api('GET', `/tenant/students/${id}`) });
  const me = useQuery({ queryKey: ['me-lite'], queryFn: () => api('GET', '/me') });
  const unlink = useMutation({ mutationFn: (userId: string) => api('DELETE', `/tenant/students/${id}/guardians/${userId}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['student', id] }) });
  const rotate = useMutation({ mutationFn: () => api('POST', `/tenant/students/${id}/rotate-qr`), onSuccess: () => qc.invalidateQueries({ queryKey: ['student', id] }) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const { student, guardians, routes, pendingInvites } = q.data;
  return (
    <div className="stack">
      <Link to="/app/students">← {t('students')}</Link>
      <div className="card">
        <div className="row between">
          <h2>{student.fullName}</h2>
          <div className="row">
            <button className="btn secondary" onClick={() => setShowQr(true)}>QR</button>
            <button className="btn secondary" onClick={() => setEditing(true)}>{t('edit')}</button>
          </div>
        </div>
        <div className="muted">{student.grade ?? ''} {student.schoolName ? `· ${student.schoolName}` : ''} {student.studentCode ? `· #${student.studentCode}` : ''}</div>
        {student.notes && <p className="small">{student.notes}</p>}
      </div>
      <div className="grid cols-2">
        <div className="card">
          <div className="row between"><h3>{lang === 'ar' ? 'أولياء الأمور' : 'Guardians'}</h3><button className="btn sm" onClick={() => setInviting(true)}>+ {lang === 'ar' ? 'دعوة ولي أمر' : 'Invite guardian'}</button></div>
          {guardians.length === 0 && pendingInvites.length === 0 && <Empty>{lang === 'ar' ? 'لا يوجد ولي أمر مرتبط' : 'No guardian linked'}</Empty>}
          <table><tbody>
            {guardians.map((g: any) => (
              <tr key={g.userId}><td>{g.fullName}<div className="small muted" dir="ltr">{g.phone ?? g.email}</div></td>
                <td><button className="btn sm ghost" onClick={() => confirm(lang === 'ar' ? 'إلغاء ربط ولي الأمر؟' : 'Unlink guardian?') && unlink.mutate(g.userId)}>{lang === 'ar' ? 'إلغاء الربط' : 'Unlink'}</button></td></tr>
            ))}
            {pendingInvites.map((i: any) => (
              <tr key={i.id}><td>{i.fullName}</td><td><span className="badge amber">{lang === 'ar' ? 'دعوة معلقة' : 'Invite pending'}</span></td></tr>
            ))}
          </tbody></table>
        </div>
        <div className="card">
          <h3>{lang === 'ar' ? 'المسارات' : 'Routes'}</h3>
          {routes.length === 0 ? <Empty>{lang === 'ar' ? 'غير معيّن لأي مسار — عيّنه من صفحة المسار' : 'Not assigned — assign from a route page'}</Empty> : (
            <table><tbody>{routes.map((r: any) => (
              <tr key={r.id}><td><Link to={`/app/routes/${r.routeId}`}>{r.routeName}</Link></td><td>{t(`dir_${r.direction}` as any)}</td><td>{r.stopName}</td></tr>
            ))}</tbody></table>
          )}
        </div>
      </div>
      <div className="small muted">{lang === 'ar' ? 'أُضيف' : 'Created'}: {fmtDateTime(student.createdAt, lang)}</div>
      {editing && <StudentForm initial={student} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); qc.invalidateQueries({ queryKey: ['student', id] }); }} />}
      {inviting && <InviteResult role="parent" studentIds={[id]} defaultName="" onClose={() => { setInviting(false); qc.invalidateQueries({ queryKey: ['student', id] }); }} />}
      {showQr && (
        <Modal title={lang === 'ar' ? 'بطاقة QR' : 'QR card'} onClose={() => setShowQr(false)}>
          <div className="stack" style={{ display: 'grid', placeItems: 'center' }}>
            <QrCard studentName={student.fullName} token={student.qrToken} tenantName={me.data?.tenant?.name ?? ''} />
            <p className="small muted">{lang === 'ar' ? 'الرمز عشوائي ولا يحتوي بيانات شخصية. يساعد السائق في التعرف على الطالب، ولا يُعد إثبات هوية — التسجيل يتطلب تأكيد السائق.' : 'Random token, no personal data. A helper for the driver, not proof of identity.'}</p>
            <div className="row no-print">
              <button className="btn" onClick={() => window.print()}>{lang === 'ar' ? 'طباعة' : 'Print'}</button>
              <button className="btn secondary" onClick={() => confirm(lang === 'ar' ? 'سيتوقف الرمز القديم عن العمل. متابعة؟' : 'Old card will stop working. Continue?') && rotate.mutate()}>{lang === 'ar' ? 'إصدار رمز جديد' : 'Rotate code'}</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
