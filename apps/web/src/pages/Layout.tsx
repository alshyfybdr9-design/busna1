import { useEffect } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, logout, selectContext } from '../api';
import { useI18n, fmtTime } from '../i18n';
import { useSession, currentTenantContext } from '../session';
import { BrandMark, Loading, useOnline } from '../components/ui';

export function TenantLayout() {
  const { t, lang, setLang } = useI18n();
  const nav = useNavigate();
  const { session, ready } = useSession();
  const online = useOnline();
  const m = currentTenantContext(session);
  const me = useQuery({ queryKey: ['me', m?.id], queryFn: () => api('GET', '/me'), enabled: !!m });
  useEffect(() => {
    if (!ready) return;
    if (!session) nav('/', { replace: true });
    else if (session.context.kind === 'platform') nav('/platform', { replace: true });
    else if (!m) nav('/select', { replace: true });
    else if (m.role === 'driver' || m.role === 'parent') nav('/mobile-only', { replace: true });
  }, [ready, session, m, nav]);
  if (!m) return <div className="center-page"><Loading /></div>;
  const isAdmin = m.role === 'tenant_admin';
  const tenant = me.data?.tenant;
  // إنهاء الوصول المؤقت: العودة لسياق المنصة ثم إلغاء الوصول
  async function endSupportAccess() {
    await selectContext({ platform: true });
    await api('POST', `/platform/access-grants/${m!.id}/revoke`, {}).catch(() => {});
    nav('/platform/access');
  }
  return (
    <>
      {!online && <div className="offline-bar">{t('offline')}</div>}
      {m.readOnly && (
        <div className="offline-bar" style={{ background: 'var(--red-bg)', color: 'var(--red)', display: 'flex', gap: 12, justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap' }}>
          <span>{lang === 'ar' ? `وصول دعم مؤقت — قراءة فقط — يُسجَّل كل ما تطّلع عليه في سجل الجهة — ينتهي ${fmtTime(m.expiresAt, lang)}` : `Temporary support access — read-only — audited — ends ${fmtTime(m.expiresAt, lang)}`}</span>
          <button className="btn sm danger" onClick={endSupportAccess}>{lang === 'ar' ? 'إنهاء الوصول' : 'End access'}</button>
        </div>
      )}
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            {tenant?.logoUrl ? <img src={tenant.logoUrl} alt="" /> : <BrandMark />}
            <span>{t('appName')}</span>
          </div>
          <nav className="nav">
            <NavLink to="/app" end>{t('dashboard')}</NavLink>
            <NavLink to="/app/trips">{t('trips')}</NavLink>
            <NavLink to="/app/alerts">{t('alerts')}</NavLink>
            <NavLink to="/app/absences">{t('absences')}</NavLink>
            <NavLink to="/app/support">{lang === 'ar' ? 'تذاكر الدعم' : 'Support tickets'}</NavLink>
            <NavLink to="/app/assistant">{lang === 'ar' ? 'مساعد باصنا' : 'Assistant'}</NavLink>
            <NavLink to="/app/students">{t('students')}</NavLink>
            <NavLink to="/app/routes">{t('routes')}</NavLink>
            <NavLink to="/app/buses">{t('buses')}</NavLink>
            <NavLink to="/app/team">{t('team')}</NavLink>
            <NavLink to="/app/knowledge">{lang === 'ar' ? 'قاعدة المعرفة' : 'Knowledge'}</NavLink>
            {isAdmin && <NavLink to="/app/settings">{t('settings')}</NavLink>}
            {isAdmin && <NavLink to="/app/audit">{t('audit')}</NavLink>}
          </nav>
          <div className="sidebar-foot stack small">
            <div>
              <div style={{ fontWeight: 600 }}>{session?.user.fullName}</div>
              <div className="muted">{m.readOnly ? (lang === 'ar' ? 'دعم المنصة (قراءة فقط)' : 'Platform support (read-only)') : t(`role_${m.role}` as any)}</div>
            </div>
            <div className="row">
              <button className="btn ghost sm" onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}>{lang === 'ar' ? 'EN' : 'ع'}</button>
              {(session!.contexts.memberships.length > 1 || session!.contexts.platformAdmin) && (
                <button className="btn ghost sm" onClick={() => nav('/select')}>⇄</button>
              )}
              <button className="btn ghost sm" onClick={() => logout().then(() => nav('/'))}>{t('logout')}</button>
            </div>
          </div>
        </aside>
        <main className="main">
          <div className="topbar">
            <div className="row">
              <h1 style={{ margin: 0 }}>{lang === 'en' && tenant?.nameEn ? tenant.nameEn : tenant?.name ?? m.tenantName}</h1>
              {tenant?.isDemo && <span className="demo-ribbon">{lang === 'ar' ? 'بيئة تجريبية — بيانات مصطنعة' : 'Demo — synthetic data'}</span>}
            </div>
          </div>
          <Outlet context={{ role: m.role, me: me.data, readOnly: m.readOnly }} />
        </main>
      </div>
    </>
  );
}

export function PlatformLayout() {
  const { t, lang, setLang } = useI18n();
  const nav = useNavigate();
  const { session, ready } = useSession();
  useEffect(() => {
    if (!ready) return;
    if (!session) nav('/', { replace: true });
    else if (session.context.kind === 'grant') nav('/app', { replace: true });
    else if (session.context.kind !== 'platform') nav('/select', { replace: true });
  }, [ready, session, nav]);
  if (!session || session.context.kind !== 'platform') return <div className="center-page"><Loading /></div>;
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><BrandMark /><span>{t('platformAdmin')}</span></div>
        <div className="small muted" style={{ padding: '0 8px 8px' }}>{session.user.fullName} · {session.contexts.platformRole === 'support' ? (lang === 'ar' ? 'دعم المنصة' : 'Platform support') : (lang === 'ar' ? 'مدير المنصة' : 'Platform admin')}</div>
        <nav className="nav">
          <NavLink to="/platform" end>{t('tenants')}</NavLink>
          <NavLink to="/platform/plans">{lang === 'ar' ? 'الخطط' : 'Plans'}</NavLink>
          {session.contexts.platformRole === 'admin' && <NavLink to="/platform/staff">{lang === 'ar' ? 'فريق المنصة' : 'Platform team'}</NavLink>}
          <NavLink to="/platform/access">{lang === 'ar' ? 'سجل الوصول الاستثنائي' : 'Support access log'}</NavLink>
          <NavLink to="/platform/support">{lang === 'ar' ? 'تذاكر الدعم' : 'Support tickets'}</NavLink>
          <NavLink to="/platform/knowledge">{lang === 'ar' ? 'دليل التطبيق' : 'App guide'}</NavLink>
          <NavLink to="/platform/health">{t('health')}</NavLink>
        </nav>
        <div className="sidebar-foot row small">
          <button className="btn ghost sm" onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}>{lang === 'ar' ? 'EN' : 'ع'}</button>
          {session.contexts.memberships.length > 0 && <button className="btn ghost sm" onClick={() => nav('/select')}>⇄</button>}
          <button className="btn ghost sm" onClick={() => logout().then(() => nav('/'))}>{t('logout')}</button>
        </div>
      </aside>
      <main className="main"><Outlet /></main>
    </div>
  );
}
