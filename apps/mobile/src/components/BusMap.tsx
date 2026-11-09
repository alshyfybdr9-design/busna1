import { View } from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import { C, T, useLang } from './ui';

/**
 * خريطة مدمجة لولي الأمر: موقع الباص (أخضر إن كان حديثًا، برتقالي إن كان قديمًا) ونقطة توقف الطفل فقط.
 * iOS: خرائط Apple. أندرويد: خرائط Google (في Expo Go تعمل مباشرة؛ في النسخة المبنية تحتاج مفتاحًا).
 */
export function BusMap({ bus, stop }: {
  bus: { lat: number; lng: number; isStale: boolean };
  stop?: { name: string; lat: number; lng: number } | null;
}) {
  const { tr } = useLang();
  const lats = [bus.lat, ...(stop ? [stop.lat] : [])];
  const lngs = [bus.lng, ...(stop ? [stop.lng] : [])];
  const pad = 0.01;
  const region = {
    latitude: (Math.min(...lats) + Math.max(...lats)) / 2,
    longitude: (Math.min(...lngs) + Math.max(...lngs)) / 2,
    latitudeDelta: Math.max(0.01, (Math.max(...lats) - Math.min(...lats)) * 1.6 + pad),
    longitudeDelta: Math.max(0.01, (Math.max(...lngs) - Math.min(...lngs)) * 1.6 + pad),
  };
  return (
    <View style={{ height: 260, borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: C.line }}>
      <MapView style={{ flex: 1 }} region={region} rotateEnabled={false} pitchEnabled={false} toolbarEnabled={false}>
        <Marker coordinate={{ latitude: bus.lat, longitude: bus.lng }} title={tr('الباص', 'Bus')}
          description={bus.isStale ? tr('آخر موقع معروف — قد لا يكون الحالي', 'Last known position — may not be current') : undefined}
          pinColor={bus.isStale ? 'orange' : 'green'} />
        {stop && <Marker coordinate={{ latitude: stop.lat, longitude: stop.lng }} title={stop.name} description={tr('نقطة توقف ابنك', "Your child's stop")} pinColor="blue" />}
      </MapView>
      {bus.isStale && (
        <View style={{ position: 'absolute', top: 8, left: 8, right: 8, backgroundColor: C.amberBg, borderRadius: 8, padding: 6 }}>
          <T size={13} style={{ color: C.amber, textAlign: 'center' }}>{tr('آخر موقع معروف — ليس مباشرًا', 'Last known position — not live')}</T>
        </View>
      )}
    </View>
  );
}
