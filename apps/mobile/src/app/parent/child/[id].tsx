import { Linking, Platform, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { api } from '../../../lib/session';
import { Btn, C, Card, DIR_LABEL, ErrorView, Loading, Pill, RIDER_LABEL, Screen, T, TRIP_LABEL, ageText, s, timeText, useLang, usePolling } from '../../../components/ui';

const EVENT: Record<string, [string, string]> = {
  boarded: ['صعد', 'Boarded'], alighted: ['نزل', 'Dropped off'], absent: ['غائب', 'Absent'], no_show: ['لم يحضر', 'No-show'], correction: ['تصحيح من الإدارة', 'Corrected by staff'],
};

function openInMaps(lat: number, lng: number, label: string) {
  const url = Platform.OS === 'ios' ? `maps://?ll=${lat},${lng}&q=${encodeURIComponent(label)}` : `geo:${lat},${lng}?q=${lat},${lng}(${encodeURIComponent(label)})`;
  Linking.openURL(url).catch(() => Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${lat},${lng}`));
}

export default function ChildStatus() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const { tr, lang } = useLang();
  const q = usePolling(() => api('GET', `/parent/children/${id}/status`), 15_000, [id]);
  const h = usePolling(() => api('GET', `/parent/children/${id}/history`), 0, [id]);
  if (q.loading && !q.data) return <Loading />;
  if (!q.data) return <Screen><ErrorView error={q.error} onRetry={q.reload} /></Screen>;
  const { child, trip, tracking, eta } = q.data;
  const loc = tracking?.location;
  return (
    <Screen>
      <T bold size={22}>{child.fullName}</T>
      {q.error != null && <ErrorView error={q.error} onRetry={q.reload} />}
      {!trip && <Card><T muted>{tr('لا توجد رحلة لهذا اليوم.', 'No trip today.')}</T></Card>}
      {trip && (
        <>
          <Card>
            <View style={[s.row, { justifyContent: 'space-between' }]}>
              <T bold>{tr('رحلة', 'Trip')} {tr(...DIR_LABEL[trip.direction])}</T>
              <Pill text={tr(...TRIP_LABEL[trip.status])} tone={trip.status === 'in_progress' ? 'blue' : 'gray'} />
            </View>
            <T size={20} bold style={{ color: C.greenDark }}>{tr(...RIDER_LABEL[trip.riderStatus])}</T>
            {trip.bus && <T muted>{tr('الباص', 'Bus')}: {trip.bus.label ?? trip.bus.plate}</T>}
            {trip.stop && <T muted>{tr('نقطة التوقف', 'Stop')}: {trip.stop.name}</T>}
          </Card>

          <Card>
            <T bold>{tr('موقع الباص', 'Bus location')}</T>
            {loc ? (
              <>
                {loc.isStale
                  ? <Pill tone="amber" text={`${tr('آخر تحديث', 'Last update')} ${ageText(loc.ageSeconds, lang)}`} />
                  : <Pill text={`● ${tr('مباشر', 'Live')} · ${ageText(loc.ageSeconds, lang)}`} />}
                {loc.isStale && <T muted size={14}>{tr('لم يصل تحديث حديث من الباص؛ الموقع المعروض قد لا يكون الحالي.', 'No recent update; the shown position may not be current.')}</T>}
                <Btn kind="secondary" title={tr('عرض الموقع على الخريطة', 'Show on map')} onPress={() => openInMaps(loc.lat, loc.lng, tr('الباص', 'Bus'))} />
              </>
            ) : (
              <T muted>
                {tracking?.reason === 'trip_not_active' ? tr('يظهر موقع الباص أثناء الرحلة الجارية فقط.', 'The bus location is shown only during an active trip.')
                  : tracking?.reason === 'disabled_by_tenant' ? tr('التتبع غير مفعّل من إدارة النقل.', 'Tracking is disabled by the transport office.')
                  : tr('لم يصل موقع من الباص بعد.', 'No location received yet.')}
              </T>
            )}
            <T muted size={13}>
              {eta?.available ? `${tr('وصول تقديري خلال', 'Estimated arrival in')} ${Math.round(eta.seconds / 60)} ${tr('دقيقة (تقديري)', 'min (estimate)')}`
                : tr('وقت الوصول التقديري غير متاح حاليًا.', 'Estimated arrival time is not available.')}
            </T>
          </Card>

          <Card>
            <T bold>{tr('سجل الرحلة', 'Trip log')}</T>
            {trip.events.length === 0 && <T muted>{tr('لا أحداث بعد', 'No events yet')}</T>}
            {trip.events.map((e: any, i: number) => (
              <T key={i}>{timeText(e.recordedAt, lang)} — {tr(...(EVENT[e.type] ?? [e.type, e.type]))}{e.type === 'correction' ? ` (${tr(...RIDER_LABEL[e.newStatus])})` : ''}</T>
            ))}
          </Card>
        </>
      )}
      <Card>
        <T bold>{tr('سجل النقل', 'Transport history')}</T>
        {(h.data?.history ?? []).slice(0, 20).map((r: any) => (
          <View key={r.tripId} style={[s.row, { justifyContent: 'space-between' }]}>
            <T size={14}>{r.serviceDate} · {tr(...DIR_LABEL[r.direction])}</T>
            <T size={14} muted>{tr(...(r.tripStatus === 'cancelled' ? TRIP_LABEL.cancelled : RIDER_LABEL[r.riderStatus]))}</T>
          </View>
        ))}
        {h.data && h.data.history.length === 0 && <T muted>{tr('لا يوجد سجل', 'No history')}</T>}
      </Card>
    </Screen>
  );
}
