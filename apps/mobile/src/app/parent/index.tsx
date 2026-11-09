import { View } from 'react-native';
import { router } from 'expo-router';
import { api } from '../../lib/session';
import { AccountActions, usePushRegistration } from '../../components/common';
import { Btn, C, Card, DIR_LABEL, ErrorView, Loading, Pill, RIDER_LABEL, Screen, T, TRIP_LABEL, s, timeText, useLang, usePolling } from '../../components/ui';

function tripLine(t: any, tr: (a: string, e: string) => string, lang: 'ar' | 'en') {
  if (t.tripStatus === 'scheduled') return t.riderStatus === 'absent' ? tr('مسجل غائب', 'Marked absent') : `${tr('مجدولة', 'Scheduled')} ${timeText(t.plannedStart, lang)}`;
  if (t.riderStatus === 'boarded') return `${tr('صعد الباص', 'Boarded')} ${timeText(t.boardedAt, lang)}`;
  if (t.riderStatus === 'alighted') return `${tr('نزل من الباص', 'Dropped off')} ${timeText(t.alightedAt, lang)}`;
  if (t.tripStatus === 'in_progress') return tr('الرحلة جارية — بانتظار الصعود', 'Trip in progress — awaiting pickup');
  return tr(...(RIDER_LABEL[t.riderStatus] ?? TRIP_LABEL[t.tripStatus]));
}

export default function ParentHome() {
  const { tr, lang } = useLang();
  usePushRegistration();
  const q = usePolling(() => api('GET', '/parent/children'), 20_000);
  const me = usePolling(() => api('GET', '/me'), 60_000);
  return (
    <Screen onRefresh={() => Promise.all([q.refresh(), me.refresh()])}>
      <View style={[s.row, { justifyContent: 'space-between' }]}>
        <T bold size={18}>{me.data?.tenant?.name ?? ''}</T>
        <Btn kind="secondary" title={`${tr('الإشعارات', 'Notifications')}${me.data?.unreadNotifications ? ` (${me.data.unreadNotifications})` : ''}`} onPress={() => router.push('/notifications')} />
      </View>
      <Btn kind="secondary" title={tr('اسأل مساعد باصنا', 'Ask Busna Assistant')} onPress={() => router.push('/assistant')} />
      {q.loading && !q.data && <Loading />}
      {q.error != null && <ErrorView error={q.error} onRetry={q.reload} />}
      {q.data && q.data.children.length === 0 && <Card><T muted>{tr('لا يوجد أبناء مرتبطون بحسابك. تواصل مع إدارة النقل.', 'No children linked to your account. Contact the transport office.')}</T></Card>}
      {q.data?.children.map((c: any) => {
        const active = c.today.find((t: any) => t.tripStatus === 'in_progress');
        return (
          <Card key={c.id} style={active ? { borderColor: C.green, borderWidth: 2 } : undefined}>
            <T bold size={20}>{c.fullName}</T>
            {c.grade && <T muted>{c.grade}</T>}
            {c.today.length === 0 && <T muted>{tr('لا رحلات اليوم', 'No trips today')}</T>}
            {c.today.map((t: any) => (
              <View key={t.tripId} style={[s.row, { justifyContent: 'space-between' }]}>
                <T>{tr(...DIR_LABEL[t.direction])}: {tripLine(t, tr, lang)}</T>
                {t.tripStatus === 'in_progress' && <Pill tone="blue" text={tr('جارية', 'Live trip')} />}
              </View>
            ))}
            <View style={s.row}>
              <Btn style={{ flex: 1 }} title={active ? tr('تتبع الباص', 'Track bus') : tr('التفاصيل', 'Details')} onPress={() => router.push(`/parent/child/${c.id}`)} />
              <Btn style={{ flex: 1 }} kind="secondary" title={tr('طلب غياب', 'Report absence')} onPress={() => router.push({ pathname: '/parent/absence', params: { studentId: c.id } })} />
            </View>
          </Card>
        );
      })}
      <AccountActions />
    </Screen>
  );
}
