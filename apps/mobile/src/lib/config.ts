/**
 * عنوان الـ API يُضبط عند البناء عبر EXPO_PUBLIC_API_URL.
 * للتطوير: محاكي أندرويد يصل للجهاز المضيف عبر http://10.0.2.2:4000، وiOS عبر http://localhost:4000،
 * والجهاز الحقيقي عبر عنوان IP للحاسوب على نفس الشبكة. في الإنتاج يجب أن يكون https.
 */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
export const WEB_URL = (process.env.EXPO_PUBLIC_WEB_URL ?? 'https://app.busna.example').replace(/\/$/, '');
export const LOCATION_TASK = 'busna-trip-location';
