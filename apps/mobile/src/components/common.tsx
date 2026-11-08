import { useEffect } from 'react';
import { router } from 'expo-router';
import { View } from 'react-native';
import { logout } from '../lib/session';
import { registerForPush, unregisterPush } from '../lib/push';
import { stopTracking } from '../lib/tracking';
import { useSession } from '../lib/SessionContext';
import { Btn, s, useLang } from './ui';

/** تسجيل إشعارات الجوال مرة عند فتح الشاشة الرئيسية (يتجاهل بهدوء إن لم تُعدّ) */
export function usePushRegistration() {
  useEffect(() => {
    registerForPush().catch(() => {});
  }, []);
}

export function AccountActions() {
  const { tr, lang, setLang } = useLang();
  const { session } = useSession();
  return (
    <View style={[s.row, { justifyContent: 'center' }]}>
      <Btn kind="ghost" title={tr('الإشعارات', 'Notifications')} onPress={() => router.push('/notifications')} />
      <Btn kind="ghost" title={tr('الدعم', 'Support')} onPress={() => router.push('/support')} />
      {session && session.contexts.memberships.length > 1 && <Btn kind="ghost" title={tr('تبديل الدور', 'Switch role')} onPress={() => router.push('/select')} />}
      <Btn kind="ghost" title={lang === 'ar' ? 'English' : 'العربية'} onPress={() => setLang(lang === 'ar' ? 'en' : 'ar')} />
      <Btn kind="ghost" title={tr('تسجيل الخروج', 'Sign out')} onPress={async () => {
        await stopTracking().catch(() => {});
        await unregisterPush();
        await logout();
        router.replace('/welcome');
      }} />
    </View>
  );
}
