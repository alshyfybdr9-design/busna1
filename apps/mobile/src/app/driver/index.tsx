import { router } from 'expo-router';
import { Pressable, View } from 'react-native';
import { api } from '../../lib/session';
import { AccountActions, MessagesCard, usePushRegistration } from '../../components/common';
import { C, Card, DIR_LABEL, ErrorView, Loading, Pill, Screen, T, TRIP_LABEL, s, timeText, useLang, usePolling } from '../../components/ui';

export default function DriverHome() {
  const { tr, lang } = useLang();
  usePushRegistration();
  const q = usePolling(() => api('GET', '/driver/trips'), 30_000);
  return (
    <Screen onRefresh={q.refresh}>
      {q.loading && !q.data && <Loading />}
      {q.error != null && <ErrorView error={q.error} onRetry={q.reload} />}
      <MessagesCard messages={q.data?.messages} />
      {q.data?.myRole === 'attendant' && <T muted size={13}>{tr('رحلاتك كمرافق اليوم. افتح الرحلة لتسجيل الصعود والنزول.', 'Your trips as attendant today. Open a trip to record boarding and drop-off.')}</T>}
      {q.data && q.data.trips.length === 0 && (
        <Card><T muted>{tr('لا توجد رحلات معيّنة لك اليوم.', 'No trips assigned to you today.')}</T></Card>
      )}
      {q.data?.trips.map((t: any) => {
        const needsInspection = t.status === 'completed' && t.inspectionStatus === 'pending';
        return (
          <Pressable key={t.id} onPress={() => router.push(needsInspection ? `/driver/end/${t.id}` : `/driver/trip/${t.id}`)}>
            <Card style={{ borderColor: t.status === 'in_progress' ? C.green : needsInspection ? C.amber : C.line, borderWidth: t.status === 'in_progress' || needsInspection ? 2 : 1 }}>
              <View style={[s.row, { justifyContent: 'space-between' }]}>
                <T bold size={20}>{t.routeName}</T>
                <Pill text={tr(...TRIP_LABEL[t.status])} tone={t.status === 'in_progress' ? 'blue' : t.status === 'completed' ? 'green' : t.status === 'cancelled' ? 'red' : 'gray'} />
              </View>
              <T muted>{tr(...DIR_LABEL[t.direction])} · {t.busLabel ?? t.busPlate} · {t.riderCount} {tr('طالب', 'students')}</T>
              <T>{tr('الموعد', 'Planned')}: {timeText(t.plannedStart, lang)}</T>
              {needsInspection && <Pill tone="amber" text={tr('مطلوب: فحص خلو الباص', 'Required: bus-empty check')} />}
            </Card>
          </Pressable>
        );
      })}
      <AccountActions />
    </Screen>
  );
}
