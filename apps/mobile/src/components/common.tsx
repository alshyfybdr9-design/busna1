import { useEffect } from 'react';
import { router } from 'expo-router';
import { View } from 'react-native';
import { logout } from '../lib/session';
import { registerForPush, unregisterPush } from '../lib/push';
import { stopTracking } from '../lib/tracking';
import { useSession } from '../lib/SessionContext';
import { Btn, C, Card, T, s, timeText, useLang } from './ui';

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

/** رسائل إدارة النقل الجماعية خلال آخر 24 ساعة */
export function MessagesCard({ messages }: { messages?: Array<{ id: string; title: string; body: string; createdAt: string }> }) {
  const { tr, lang } = useLang();
  if (!messages?.length) return null;
  return (
    <Card style={{ borderColor: C.amber, borderWidth: 1, backgroundColor: C.amberBg }}>
      <T bold>{tr('رسائل من إدارة النقل', 'Messages from the transport office')}</T>
      {messages.map((m) => (
        <View key={m.id} style={{ gap: 2, paddingTop: 6 }}>
          <T bold size={15}>{m.title}</T>
          <T size={15}>{m.body}</T>
          <T muted size={12}>{timeText(m.createdAt, lang)}</T>
        </View>
      ))}
    </Card>
  );
}
