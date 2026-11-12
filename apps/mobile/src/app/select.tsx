import { useState } from 'react';
import { router } from 'expo-router';
import { useSession } from '../lib/SessionContext';
import { logout, selectMembership } from '../lib/session';
import { Btn, Card, ErrorView, Pill, Screen, T, useLang } from '../components/ui';

const ROLE: Record<string, [string, string]> = {
  driver: ['سائق', 'Driver'], attendant: ['مرافق', 'Bus attendant'], parent: ['ولي أمر', 'Parent'], supervisor: ['مشرف نقل', 'Supervisor'], tenant_admin: ['مدير الجهة', 'Admin'],
};

/** اختيار الجهة/الدور بعد الدخول عند تعدد العضويات — الصلاحيات تُحدد في الخادم */
export default function Select() {
  const { session } = useSession();
  const { tr, lang } = useLang();
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!session) return null;
  return (
    <Screen>
      <T muted>{tr('حسابك مرتبط بأكثر من جهة أو دور. اختر للمتابعة:', 'Your account has several roles. Choose one:')}</T>
      {session.contexts.memberships.map((m) => (
        <Card key={m.membershipId}>
          <T bold size={18}>{lang === 'en' && m.tenantNameEn ? m.tenantNameEn : m.tenantName}</T>
          <Pill text={tr(...(ROLE[m.role] ?? [m.role, m.role]))} />
          <Btn title={tr('متابعة', 'Continue')} busy={busy === m.membershipId} onPress={async () => {
            setBusy(m.membershipId);
            try {
              await selectMembership(m.membershipId);
              router.replace('/');
            } catch (e) {
              setErr(e);
            } finally {
              setBusy(null);
            }
          }} />
        </Card>
      ))}
      {session.contexts.memberships.length === 0 && <T>{tr('لا توجد عضوية نشطة. تواصل مع إدارة الجهة.', 'No active membership.')}</T>}
      {err != null && <ErrorView error={err} />}
      <Btn kind="ghost" title={tr('تسجيل الخروج', 'Sign out')} onPress={() => logout().then(() => router.replace('/welcome'))} />
    </Screen>
  );
}
