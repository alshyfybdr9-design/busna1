// يمتد من app.json ويضيف مفتاح خرائط Google لأندرويد من متغير بيئة عند البناء (لا يُحفظ المفتاح في المستودع).
// في Expo Go لا حاجة لمفتاح. في نسخة أندرويد مبنية بدون مفتاح تظهر الخريطة فارغة.
module.exports = ({ config }) => {
  const key = process.env.GOOGLE_MAPS_ANDROID_API_KEY;
  return {
    ...config,
    plugins: [...(config.plugins ?? []), ...(key ? [['react-native-maps', { androidGoogleMapsApiKey: key }]] : [])],
  };
};
