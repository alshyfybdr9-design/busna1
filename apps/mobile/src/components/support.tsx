export const TICKET_STATUS: Record<string, [string, string, 'green' | 'gray' | 'red' | 'amber' | 'blue']> = {
  open: ['مفتوحة', 'Open', 'amber'],
  in_progress: ['قيد المعالجة', 'In progress', 'blue'],
  waiting_user: ['بانتظار ردك', 'Waiting for you', 'red'],
  resolved: ['تم الحل', 'Resolved', 'green'],
  closed: ['مغلقة', 'Closed', 'gray'],
};

/** التصنيفات: استخدام التطبيق ← دعم المنصة؛ الباقي ← إدارة النقل في الجهة */
export const CATEGORIES: Array<{ key: string; ar: string; en: string; platform?: boolean }> = [
  { key: 'trip', ar: 'الرحلات والباص', en: 'Trips & bus' },
  { key: 'absence', ar: 'الغياب', en: 'Absence' },
  { key: 'safety', ar: 'السلامة', en: 'Safety' },
  { key: 'payment', ar: 'الرسوم', en: 'Fees' },
  { key: 'other', ar: 'أخرى (النقل)', en: 'Other (transport)' },
  { key: 'app_usage', ar: 'مشكلة في التطبيق', en: 'App problem', platform: true },
];
