import { Linking, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import { useSession } from '../lib/SessionContext';
import { currentMembership, logout } from '../lib/session';
import { Btn, Card, Loading, Screen, T, useLang } from '../components/ui';
import { WEB_URL } from '../lib/config';

export default function Index() {
  const { session, ready, offlineStart, retry } = useSession();
  const { tr } = useLang();
  if (!ready) return <Loading />;
  if (!session && offlineStart) {
    return (
      <Screen>
        <Card>
          <T bold size={18}>{tr('لا يوجد اتصال بالإنترنت', 'No internet connection')}</T>
          <T muted>{tr('تعذر التحقق من حسابك. اتصل بالإنترنت ثم أعد المحاولة.', 'Could not verify your account. Connect and retry.')}</T>
          <Btn title={tr('إعادة المحاولة', 'Retry')} onPress={retry} />
        </Card>
      </Screen>
    );
  }
  if (!session) return <Redirect href="/welcome" />;
  const m = currentMembership(session);
  if (!m) return <Redirect href="/select" />;
  if (m.role === 'driver') return <Redirect href="/driver" />;
  if (m.role === 'parent') return <Redirect href="/parent" />;
  return (
    <Screen>
      <Card>
        <T bold size={18}>{tr('لوحة الإدارة متاحة عبر الويب', 'The admin dashboard is on the web')}</T>
        <T muted>{tr('حسابات الإدارة والمشرفين تستخدم لوحة الويب.', 'Admin and supervisor accounts use the web dashboard.')}</T>
        <Btn title={tr('فتح لوحة الويب', 'Open web dashboard')} onPress={() => Linking.openURL(WEB_URL)} />
        <View style={{ height: 8 }} />
        {session.contexts.memberships.length > 1 && <Btn kind="secondary" title={tr('تبديل الجهة/الدور', 'Switch')} onPress={() => router.push('/select')} />}
        <Btn kind="ghost" title={tr('تسجيل الخروج', 'Sign out')} onPress={() => logout()} />
      </Card>
    </Screen>
  );
}
