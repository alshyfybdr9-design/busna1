/**
 * إشعارات الجوال عبر Expo Push. تتطلب:
 *  - مشروع EAS (extra.eas.projectId في app.json)
 *  - بيانات FCM لأندرويد وAPNs لـ iOS مرفوعة في EAS
 *  - PUSH_PROVIDER=expo في الخادم
 * بدون ذلك تبقى الإشعارات داخل التطبيق فقط (سجل الإشعارات).
 */
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { api } from './session';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

let registeredToken: string | null = null;

export async function registerForPush(): Promise<'registered' | 'not_configured' | 'denied' | 'simulator'> {
  if (!Device.isDevice) return 'simulator';
  const projectId = (Constants.expoConfig?.extra as any)?.eas?.projectId;
  if (!projectId) return 'not_configured';
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', { name: 'باصنا', importance: Notifications.AndroidImportance.HIGH });
  }
  const perm = await Notifications.requestPermissionsAsync();
  if (perm.status !== 'granted') return 'denied';
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  await api('POST', '/me/push-tokens', { token, platform: Platform.OS === 'ios' ? 'ios' : 'android' });
  registeredToken = token;
  return 'registered';
}

/** عند تسجيل الخروج: إزالة الرمز حتى لا تصل إشعارات هذا الحساب لهذا الجهاز */
export async function unregisterPush() {
  if (registeredToken) await api('DELETE', '/me/push-tokens', { token: registeredToken }).catch(() => {});
  registeredToken = null;
}
