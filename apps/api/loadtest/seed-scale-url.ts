/** رابط قاعدة اختبار الضغط: نفس بيانات الاتصال مع قاعدة busna_load المنفصلة */
export function loadUrl(u: string | undefined) {
  if (!u) throw new Error('DATABASE_* URLs are required (.env)');
  const url = new URL(u);
  url.pathname = '/busna_load';
  return url.toString();
}
