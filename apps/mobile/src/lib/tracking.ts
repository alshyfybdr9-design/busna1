/**
 * تتبع موقع السائق أثناء الرحلة فقط — بما في ذلك في الخلفية والشاشة مقفلة.
 * أندرويد: خدمة أمامية (Foreground Service) بإشعار ظاهر طوال الرحلة.
 * iOS: وضع الموقع في الخلفية مع مؤشر الموقع الأزرق.
 * يتطلب Development/Production Build (لا يعمل التتبع بالخلفية في Expo Go).
 * يجب استيراد هذا الملف في أعلى شجرة التطبيق حتى تُعرَّف المهمة عند الإقلاع في الخلفية.
 */
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as SecureStore from 'expo-secure-store';
import { LOCATION_TASK } from './config';
import { enqueueLocations, flushLocations, dropTripLocations } from './queue';

const ACTIVE_TRIP_KEY = 'busna_active_trip';

TaskManager.defineTask<{ locations: Location.LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
  if (error || !data?.locations?.length) return;
  const tripId = await SecureStore.getItemAsync(ACTIVE_TRIP_KEY);
  if (!tripId) {
    // لا رحلة نشطة: لا نجمع موقعًا خارج الرحلة
    await stopTracking().catch(() => {});
    return;
  }
  await enqueueLocations(tripId, data.locations.map((l) => ({
    recordedAt: new Date(l.timestamp).toISOString(),
    lat: l.coords.latitude,
    lng: l.coords.longitude,
    accuracyM: l.coords.accuracy,
    speedMps: l.coords.speed,
    heading: l.coords.heading,
  })));
  try {
    const r = await flushLocations();
    if (r === 'trip_not_active') await stopTracking();
  } catch {
    // لا اتصال: النقاط محفوظة محليًا وتُرسل لاحقًا
  }
});

export type PermissionOutcome = 'background' | 'foreground_only' | 'denied' | 'services_off';

export async function ensureLocationPermissions(): Promise<PermissionOutcome> {
  if (!(await Location.hasServicesEnabledAsync())) return 'services_off';
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') return 'denied';
  const bg = await Location.requestBackgroundPermissionsAsync();
  return bg.status === 'granted' ? 'background' : 'foreground_only';
}

export async function startTracking(tripId: string, intervalSec: number) {
  await SecureStore.setItemAsync(ACTIVE_TRIP_KEY, tripId);
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.High,
    timeInterval: intervalSec * 1000,
    distanceInterval: 15,
    deferredUpdatesInterval: intervalSec * 1000,
    activityType: Location.ActivityType.AutomotiveNavigation,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'باصنا — رحلة جارية',
      notificationBody: 'يُشارك موقع الباص أثناء الرحلة فقط ويتوقف عند إنهائها.',
      notificationColor: '#16a34a',
      killServiceOnDestroy: false,
    },
  });
}

/** يوقف جمع الموقع فورًا ويحذف أي نقاط لم تُرسل لرحلة منتهية */
export async function stopTracking(tripId?: string) {
  await SecureStore.deleteItemAsync(ACTIVE_TRIP_KEY);
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
  if (tripId) await dropTripLocations(tripId);
}

export async function isTracking() {
  return Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
}

export async function activeTripId() {
  return SecureStore.getItemAsync(ACTIVE_TRIP_KEY);
}
