import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { acceptInvite, login, publicApi, selectContext, logout, ApiError, type Session } from '../api';
import { useI18n } from '../i18n';
import { useSession } from '../session';
import { BrandMark, ErrorBox, Loading } from '../components/ui';

const APP_SCHEME = (import.meta.env.VITE_APP_SCHEME as string | undefined) ?? 'busna';

function homeFor(s: Session) {
  if (s.context.kind === 'platform') return '/platform';
  if (s.context.kind === 'grant') return '/app';
  if (s.context.kind === 'membership') {
    const mid = s.context.mid;
    const m = s.contexts.memberships.find((x) => x.membershipId === mid);
    if (m && (m.role === 'driver' || m.role === 'attendant' || m.role === 'parent')) return '/mobile-only';
    return '/app';
  }
  return '/select';
}

function TenantHeader({ tenant }: { tenant: { name: string; nameEn: string | null; logoUrl: string | null } }) {
  const { lang } = useI18n();
  return (
    <div className="tenant-head">
      {tenant.logoUrl ? <img src={tenant.logoUrl} alt="" /> : <div style={{ width: 48, height: 48 }}><BrandMark /></div>}
      <div>
        <div style={{ fontWeight: 700, fontSize: '1.1rem' }}>{lang === 'en' && tenant.nameEn ? tenant.nameEn : tenant.name}</div>
      </div>
    </div>
  );
}

function LangToggle() {
  const { lang, setLang } = useI18n();
  return (
    <button className="btn ghost sm" onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}>
      {lang === 'ar' ? 'English' : 'العربية'}
    </button>
  );
}

function LoginForm({ onDone }: { onDone: (s: Session) => void }) {
  const { t } = useI18n();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      onDone(await login(identifier.trim(), password));
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit}>
      <div className="field">
        <label htmlFor="id">{t('identifier')}</label>
        <input id="id" autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required dir="ltr" />
      </div>
      <div className="field">
        <label htmlFor="pw">{t('password')}</label>
        <input id="pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required dir="ltr" />
      </div>
      {err != null && <ErrorBox error={err} />}
      <button className="btn" style={{ width: '100%', marginTop: 8 }} disabled={busy}>{busy ? t('loading') : t('login')}</button>
    </form>
  );
}

/** الصفحة الرئيسية: إدخال رمز الجهة أو الدخول مباشرة */
export function EntryPage() {
  const { t } = useI18n();
  const nav = useNavigate();
  const { session } = useSession();
  const [code, setCode] = useState('');
  useEffect(() => {
    if (session) nav(homeFor(session), { replace: true });
  }, [session, nav]);
  return (
    <div className="center-page">
      <div className="card auth-card">
        <div className="row between">
          <div className="brand" style={{ padding: 0 }}><BrandMark /> {t('appName')}</div>
          <LangToggle />
        </div>
        <p className="muted">{t('tagline')}</p>
        <form onSubmit={(e) => { e.preventDefault(); if (code.trim()) nav(`/t/${encodeURIComponent(code.trim().toUpperCase())}`); }}>
          <div className="field">
            <label htmlFor="code">{t('enterTenantCode')}</label>
            <input id="code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="DEMO01" dir="ltr" />
            <span className="hint">{t('tenantCodeHint')}</span>
          </div>
          <button className="btn" style={{ width: '100%' }}>{t('continue')}</button>
        </form>
        <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '20px 0' }} />
        <h3>{t('login')}</h3>
        <LoginForm onDone={(s) => nav(homeFor(s))} />
      </div>
    </div>
  );
}

/** رابط الجهة /t/:code — يعرض هوية الجهة فقط ثم يطلب المصادقة */
export function TenantLinkPage() {
  const { code = '' } = useParams();
  const { t } = useI18n();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['tenant-resolve', code], queryFn: () => publicApi.resolveTenant(code), retry: false });
  async function done(s: Session) {
    // إن كان للمستخدم عضوية في هذه الجهة نختارها تلقائيًا؛ الخادم يتحقق منها
    const ms = s.contexts.memberships.filter((m) => m.tenantCode.toUpperCase() === code.toUpperCase());
    if (ms.length === 1) {
      const s2 = await selectContext({ membershipId: ms[0].membershipId });
      if (s2) return nav(homeFor(s2));
    }
    nav(homeFor(s));
  }
  return (
    <div className="center-page">
      <div className="card auth-card">
        <div className="row between"><Link to="/">← {t('appName')}</Link><LangToggle /></div>
        {q.isLoading && <Loading />}
        {q.error && <ErrorBox error={q.error} />}
        {q.data && (
          <>
            <TenantHeader tenant={q.data.tenant} />
            <p className="muted small">{t('tenantCodeHint')}</p>
            <LoginForm onDone={done} />
          </>
        )}
      </div>
    </div>
  );
}

/** رابط الدعوة /invite/:token — يفتح التطبيق إن توفر، مع بديل ويب لإكمال التسجيل */
export function InvitePage() {
  const { token = '' } = useParams();
  const { t, lang } = useI18n();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['invite', token], queryFn: () => publicApi.invitePreview(token), retry: false });
  const [mode, setMode] = useState<'register' | 'login'>('register');
  const [form, setForm] = useState({ fullName: '', email: '', phone: '', password: '', identifier: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const body = mode === 'register'
        ? { mode, fullName: form.fullName, password: form.password, ...(form.email ? { email: form.email } : {}), ...(form.phone ? { phone: form.phone } : {}) }
        : { mode, identifier: form.identifier, password: form.password };
      const s = await acceptInvite(token, body);
      nav(homeFor(s));
    } catch (e2) {
      setErr(e2);
      if (e2 instanceof ApiError && e2.code === 'account_exists') setMode('login');
    } finally {
      setBusy(false);
    }
  }

  const inv = q.data?.invite;
  const mobileRole = inv && (inv.role === 'driver' || inv.role === 'attendant' || inv.role === 'parent');
  return (
    <div className="center-page">
      <div className="card auth-card">
        <div className="row between"><Link to="/">← {t('appName')}</Link><LangToggle /></div>
        {q.isLoading && <Loading />}
        {q.error && <ErrorBox error={q.error} />}
        {inv && (
          <>
            <TenantHeader tenant={inv.tenant} />
            <p>
              {lang === 'ar' ? 'دعوة للانضمام بدور: ' : 'You are invited as: '}
              <strong>{inv.role === 'platform_support' ? (lang === 'ar' ? 'دعم منصة باصنا' : 'Busna platform support') : t(`role_${inv.role}` as any)}</strong>
            </p>
            {mobileRole && (
              <div className="alert info" style={{ marginBottom: 12 }}>
                {lang === 'ar' ? 'هذا الدور يُستخدم عبر تطبيق باصنا للجوال.' : 'This role uses the Busna mobile app.'}{' '}
                <a href={`${APP_SCHEME}://invite/${token}`}>{lang === 'ar' ? 'افتح في التطبيق' : 'Open in app'}</a>
                <div className="small muted">{lang === 'ar' ? 'أو أكمل التسجيل هنا ثم سجّل الدخول في التطبيق.' : 'Or finish sign-up here, then sign in from the app.'}</div>
              </div>
            )}
            <div className="row" style={{ marginBottom: 12 }}>
              <button className={`btn sm ${mode === 'register' ? '' : 'secondary'}`} onClick={() => setMode('register')}>{lang === 'ar' ? 'حساب جديد' : 'New account'}</button>
              <button className={`btn sm ${mode === 'login' ? '' : 'secondary'}`} onClick={() => setMode('login')}>{lang === 'ar' ? 'لدي حساب' : 'I have an account'}</button>
            </div>
            <form onSubmit={submit}>
              {mode === 'register' ? (
                <>
                  <div className="field"><label>{lang === 'ar' ? 'الاسم الكامل' : 'Full name'}</label><input value={form.fullName} onChange={set('fullName')} required /></div>
                  {(inv.requiresEmail || !inv.requiresPhone) && (
                    <div className="field">
                      <label>{lang === 'ar' ? 'البريد الإلكتروني' : 'Email'}</label>
                      <input type="email" value={form.email} onChange={set('email')} required={inv.requiresEmail} dir="ltr" />
                      {inv.requiresEmail && <span className="hint">{lang === 'ar' ? 'استخدم البريد الذي وصلتك عليه الدعوة' : 'Use the email the invite was sent to'}</span>}
                    </div>
                  )}
                  {!inv.requiresEmail && (
                    <div className="field"><label>{lang === 'ar' ? 'رقم الجوال' : 'Phone'}</label><input value={form.phone} onChange={set('phone')} required={inv.requiresPhone} dir="ltr" placeholder="+9665XXXXXXXX" /></div>
                  )}
                  <div className="field">
                    <label>{t('password')}</label>
                    <input type="password" value={form.password} onChange={set('password')} required minLength={8} autoComplete="new-password" dir="ltr" />
                    <span className="hint">{lang === 'ar' ? '8 أحرف على الأقل تتضمن حروفًا وأرقامًا' : 'At least 8 characters with letters and digits'}</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="field"><label>{t('identifier')}</label><input value={form.identifier} onChange={set('identifier')} required dir="ltr" /></div>
                  <div className="field"><label>{t('password')}</label><input type="password" value={form.password} onChange={set('password')} required dir="ltr" /></div>
                </>
              )}
              {err != null && <ErrorBox error={err} />}
              <button className="btn" style={{ width: '100%', marginTop: 8 }} disabled={busy}>{busy ? t('loading') : t('confirm')}</button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

/** شاشة اختيار الجهة/الدور عند تعدد العضويات */
export function ContextPicker() {
  const { t, lang } = useI18n();
  const nav = useNavigate();
  const { session, ready } = useSession();
  const [params] = useSearchParams();
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    if (ready && !session) nav('/', { replace: true });
  }, [ready, session, nav]);
  if (!session) return <div className="center-page"><Loading /></div>;
  async function pick(want: { membershipId?: string; platform?: boolean; accessGrantId?: string }) {
    try {
      const s = await selectContext(want);
      if (s) nav(params.get('next') ?? homeFor(s));
    } catch (e) {
      setErr(e);
    }
  }
  return (
    <div className="center-page">
      <div className="card auth-card stack">
        <h2>{t('chooseContext')}</h2>
        {err != null && <ErrorBox error={err} />}
        {session.contexts.platformAdmin && (
          <button className="btn secondary" style={{ width: '100%', justifyContent: 'space-between' }} onClick={() => pick({ platform: true })}>
            <span>{t('platformAdmin')}</span><span className="badge">{session.contexts.platformRole === 'support' ? (lang === 'ar' ? 'دعم المنصة' : 'Platform support') : t('role_platform_admin')}</span>
          </button>
        )}
        {session.contexts.memberships.map((m) => (
          <button key={m.membershipId} className="btn secondary" style={{ width: '100%', justifyContent: 'space-between' }} onClick={() => pick({ membershipId: m.membershipId })}>
            <span>{lang === 'en' && m.tenantNameEn ? m.tenantNameEn : m.tenantName}</span>
            <span className="badge">{t(`role_${m.role}` as any)}</span>
          </button>
        ))}
        {(session.contexts.accessGrants ?? []).map((g) => (
          <button key={g.grantId} className="btn secondary" style={{ width: '100%', justifyContent: 'space-between' }} onClick={() => pick({ accessGrantId: g.grantId })}>
            <span>{g.tenantName}</span><span className="badge amber">{lang === 'ar' ? 'وصول دعم مؤقت — قراءة فقط' : 'Temporary support access'}</span>
          </button>
        ))}
        {!session.contexts.platformAdmin && session.contexts.memberships.length === 0 && (
          <div className="alert warn">{lang === 'ar' ? 'لا توجد عضوية نشطة مرتبطة بحسابك. تواصل مع إدارة الجهة.' : 'No active membership. Contact your organization.'}</div>
        )}
        <button className="btn ghost" onClick={() => logout().then(() => nav('/'))}>{t('logout')}</button>
      </div>
    </div>
  );
}

/** السائق وولي الأمر يستخدمان تطبيق الجوال */
export function MobileOnlyPage() {
  const { t, lang } = useI18n();
  const nav = useNavigate();
  const { session } = useSession();
  return (
    <div className="center-page">
      <div className="card auth-card stack">
        <div className="brand" style={{ padding: 0 }}><BrandMark /> {t('appName')}</div>
        <p>
          {lang === 'ar'
            ? 'تم تسجيل حسابك بنجاح. واجهات السائق والمرافق وولي الأمر متاحة عبر تطبيق باصنا للجوال (يدعم تتبع الرحلة والإشعارات).'
            : 'Your account is ready. Driver and parent features are available in the Busna mobile app.'}
        </p>
        <a className="btn" href={`${APP_SCHEME}://`}>{lang === 'ar' ? 'افتح التطبيق' : 'Open the app'}</a>
        {session && (session.contexts.memberships.length > 1 || session.contexts.platformAdmin) && (
          <button className="btn secondary" onClick={() => nav('/select')}>{t('chooseContext')}</button>
        )}
        <button className="btn ghost" onClick={() => logout().then(() => nav('/'))}>{t('logout')}</button>
      </div>
    </div>
  );
}
