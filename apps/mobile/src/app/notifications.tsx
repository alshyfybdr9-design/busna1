import { Pressable } from 'react-native';
import { api } from '../lib/session';
import { Btn, C, Card, ErrorView, Loading, Screen, T, timeText, useLang, usePolling } from '../components/ui';

/** سجل الإشعارات داخل التطبيق — يعمل حتى بدون إعداد إشعارات الجوال */
export default function Notifications() {
  const { tr, lang } = useLang();
  const q = usePolling(() => api('GET', '/me/notifications'), 30_000);
  async function markAll() {
    await api('POST', '/me/notifications/read-all', {}).catch(() => {});
    q.reload();
  }
  return (
    <Screen>
      {q.loading && !q.data && <Loading />}
      {q.error != null && <ErrorView error={q.error} onRetry={q.reload} />}
      {q.data && q.data.notifications.length > 0 && <Btn kind="ghost" title={tr('تعليم الكل كمقروء', 'Mark all read')} onPress={markAll} />}
      {q.data && q.data.notifications.length === 0 && <Card><T muted>{tr('لا توجد إشعارات', 'No notifications')}</T></Card>}
      {q.data?.notifications.map((n: any) => (
        <Pressable key={n.id} onPress={() => !n.readAt && api('POST', `/me/notifications/${n.id}/read`, {}).then(q.reload).catch(() => {})}>
          <Card style={!n.readAt ? { borderColor: C.green, borderWidth: 2 } : undefined}>
            <T bold>{n.title}</T>
            <T>{n.body}</T>
            <T muted size={13}>{new Date(n.createdAt).toLocaleDateString(lang === 'ar' ? 'ar-SA-u-nu-latn-ca-gregory' : 'en-GB')} {timeText(n.createdAt, lang)}</T>
          </Card>
        </Pressable>
      ))}
    </Screen>
  );
}
