import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

const ar = {
  appName: 'باصنا',
  tagline: 'إدارة النقل المدرسي بأمان ووضوح',
  login: 'تسجيل الدخول',
  logout: 'تسجيل الخروج',
  identifier: 'البريد الإلكتروني أو رقم الجوال',
  password: 'كلمة المرور',
  tenantCode: 'رمز الجهة',
  continue: 'متابعة',
  enterTenantCode: 'أدخل رمز المدرسة أو شركة النقل',
  tenantCodeHint: 'الرمز يحدد الجهة فقط. ستحتاج لتسجيل الدخول للوصول لأي بيانات.',
  chooseContext: 'اختر الجهة والدور',
  platformAdmin: 'إدارة المنصة',
  loading: 'جارٍ التحميل…',
  retry: 'إعادة المحاولة',
  save: 'حفظ',
  cancel: 'إلغاء',
  add: 'إضافة',
  edit: 'تعديل',
  close: 'إغلاق',
  confirm: 'تأكيد',
  search: 'بحث',
  empty: 'لا توجد بيانات بعد',
  offline: 'لا يوجد اتصال بالإنترنت — البيانات المعروضة قد لا تكون محدثة',
  dashboard: 'لوحة التشغيل',
  students: 'الطلاب',
  buses: 'الباصات',
  routes: 'المسارات',
  trips: 'الرحلات',
  alerts: 'التنبيهات',
  absences: 'الغياب',
  team: 'الفريق والدعوات',
  settings: 'الإعدادات',
  audit: 'سجل التدقيق',
  tenants: 'الجهات',
  health: 'حالة النظام',
  role_tenant_admin: 'مدير الجهة',
  role_supervisor: 'مشرف النقل',
  role_driver: 'سائق',
  role_parent: 'ولي أمر',
  role_platform_admin: 'مدير المنصة',
  dir_to_school: 'ذهاب',
  dir_from_school: 'عودة',
  dir_both: 'ذهاب وعودة',
  trip_scheduled: 'مجدولة',
  trip_in_progress: 'جارية',
  trip_completed: 'مكتملة',
  trip_cancelled: 'ملغاة',
  rider_expected: 'بانتظار الصعود',
  rider_boarded: 'صعد',
  rider_alighted: 'نزل',
  rider_absent: 'غائب',
  rider_no_show: 'لم يحضر',
  insp_not_required: '—',
  insp_pending: 'فحص الباص مطلوب',
  insp_completed: 'تم فحص الباص',
  insp_issue_reported: 'بلاغ من الفحص',
  live: 'مباشر',
  lastUpdate: 'آخر تحديث منذ',
  noLocation: 'لا يوجد موقع بعد',
  activeTrips: 'الرحلات الجارية',
  delayedTrips: 'رحلات متأخرة في البدء',
  operationalAlerts: 'تنبيهات التشغيل',
  attendanceToday: 'حضور اليوم',
  busMap: 'خريطة الباصات',
  pendingAbsences: 'طلبات غياب معلقة',
  pendingInspections: 'رحلات بانتظار فحص الباص',
  supportTickets: 'تذاكر الدعم',
  comingPhase: 'متاح في مرحلة لاحقة',
} as const;

type Dict = Record<keyof typeof ar, string>;

const en: Dict = {
  appName: 'Busna',
  tagline: 'Safe, clear school transport management',
  login: 'Sign in',
  logout: 'Sign out',
  identifier: 'Email or phone',
  password: 'Password',
  tenantCode: 'Organization code',
  continue: 'Continue',
  enterTenantCode: 'Enter your school or transport company code',
  tenantCodeHint: 'The code only identifies the organization. You must sign in to access any data.',
  chooseContext: 'Choose organization and role',
  platformAdmin: 'Platform administration',
  loading: 'Loading…',
  retry: 'Retry',
  save: 'Save',
  cancel: 'Cancel',
  add: 'Add',
  edit: 'Edit',
  close: 'Close',
  confirm: 'Confirm',
  search: 'Search',
  empty: 'Nothing here yet',
  offline: 'You are offline — data may be out of date',
  dashboard: 'Operations',
  students: 'Students',
  buses: 'Buses',
  routes: 'Routes',
  trips: 'Trips',
  alerts: 'Alerts',
  absences: 'Absences',
  team: 'Team & invites',
  settings: 'Settings',
  audit: 'Audit log',
  tenants: 'Organizations',
  health: 'System health',
  role_tenant_admin: 'Organization admin',
  role_supervisor: 'Transport supervisor',
  role_driver: 'Driver',
  role_parent: 'Parent',
  role_platform_admin: 'Platform admin',
  dir_to_school: 'To school',
  dir_from_school: 'From school',
  dir_both: 'Both ways',
  trip_scheduled: 'Scheduled',
  trip_in_progress: 'In progress',
  trip_completed: 'Completed',
  trip_cancelled: 'Cancelled',
  rider_expected: 'Awaiting pickup',
  rider_boarded: 'Boarded',
  rider_alighted: 'Dropped off',
  rider_absent: 'Absent',
  rider_no_show: 'No-show',
  insp_not_required: '—',
  insp_pending: 'Bus check required',
  insp_completed: 'Bus checked',
  insp_issue_reported: 'Check reported issue',
  live: 'Live',
  lastUpdate: 'Last update',
  noLocation: 'No location yet',
  activeTrips: 'Active trips',
  delayedTrips: 'Late to start',
  operationalAlerts: 'Operational alerts',
  attendanceToday: "Today's attendance",
  busMap: 'Bus map',
  pendingAbsences: 'Pending absence requests',
  pendingInspections: 'Trips awaiting bus check',
  supportTickets: 'Support tickets',
  comingPhase: 'Available in a later phase',
};

const I18n = createContext<{ t: (k: keyof Dict) => string; lang: 'ar' | 'en'; setLang: (l: 'ar' | 'en') => void }>({
  t: (k) => ar[k],
  lang: 'ar',
  setLang: () => {},
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<'ar' | 'en'>(() => {
    try {
      return (localStorage.getItem('busna.lang') as 'ar' | 'en') ?? 'ar';
    } catch {
      return 'ar';
    }
  });
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    try {
      localStorage.setItem('busna.lang', lang);
    } catch {
      /* ignore */
    }
  }, [lang]);
  const dict = lang === 'ar' ? ar : en;
  return <I18n.Provider value={{ t: (k) => dict[k], lang, setLang }}>{children}</I18n.Provider>;
}

export const useI18n = () => useContext(I18n);

/** "منذ ٣ د" — يُستخدم لعرض قِدم بيانات الموقع بوضوح */
export function formatAge(sec: number | null | undefined, lang: 'ar' | 'en') {
  if (sec == null) return '';
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto', style: 'short' });
  if (sec < 60) return rtf.format(-sec, 'second');
  if (sec < 3600) return rtf.format(-Math.floor(sec / 60), 'minute');
  if (sec < 86400) return rtf.format(-Math.floor(sec / 3600), 'hour');
  return rtf.format(-Math.floor(sec / 86400), 'day');
}

export function fmtTime(ts: string | null | undefined, lang: 'ar' | 'en') {
  if (!ts) return '—';
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-SA-u-nu-latn' : 'en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
}

export function fmtDateTime(ts: string | null | undefined, lang: 'ar' | 'en') {
  if (!ts) return '—';
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-SA-u-nu-latn-ca-gregory' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ts));
}
