import { useEffect, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { publicApi } from '../../lib/session';
import { ErrorView, Loading, Screen, T, useLang } from '../../components/ui';
import { LoginForm, TenantHeader, routeAfterLogin } from '../../components/auth';

/** رابط الجهة (busna://t/CODE أو https://.../t/CODE): يعرض هوية الجهة العامة فقط ثم يطلب الدخول */
export default function TenantEntry() {
  const { code = '' } = useLocalSearchParams<{ code: string }>();
  const { tr, lang } = useLang();
  const [tenant, setTenant] = useState<{ name: string; nameEn: string | null; logoUrl: string | null } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    publicApi.resolveTenant(code).then((r) => setTenant(r.tenant), setErr);
  }, [code]);
  return (
    <Screen>
      {!tenant && !err && <Loading />}
      {err != null && <ErrorView error={err} />}
      {tenant && (
        <>
          <TenantHeader name={lang === 'en' && tenant.nameEn ? tenant.nameEn : tenant.name} logoUrl={tenant.logoUrl} />
          <T muted>{tr('سجّل الدخول للوصول إلى حسابك في هذه الجهة.', 'Sign in to access your account here.')}</T>
          <LoginForm tenantCode={code} onDone={routeAfterLogin} />
        </>
      )}
    </Screen>
  );
}
