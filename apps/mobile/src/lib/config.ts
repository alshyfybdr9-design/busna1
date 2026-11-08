import Constants from 'expo-constants';

/**
 * عنوان الـ API:
 *  1) EXPO_PUBLIC_API_URL إن ضُبط (يُضمَّن عند البناء) — إلزامي في الإنتاج ويجب أن يكون https.
 *  2) أثناء التطوير فقط: نفس الجهاز الذي يخدم التطبيق (خادم Expo) على المنفذ 4000،
 *     فيعمل على الجوال الحقيقي تلقائيًا دون ضبط عنوان IP يدويًا.
 *  3) احتياطي: http://localhost:4000 (محاكي iOS).
 */
function devHostApi(): string | null {
  if (!__DEV__) return null;
  const hostUri = Constants.expoConfig?.hostUri ?? (Constants as any).expoGoConfig?.debuggerHost ?? null;
  const host = typeof hostUri === 'string' ? hostUri.split(':')[0] : null;
  return host ? `http://${host}:4000` : null;
}

export const API_URL = (process.env.EXPO_PUBLIC_API_URL || devHostApi() || 'http://localhost:4000').replace(/\/$/, '');
export const WEB_URL = (process.env.EXPO_PUBLIC_WEB_URL ?? 'https://app.busna.example').replace(/\/$/, '');
export const LOCATION_TASK = 'busna-trip-location';
