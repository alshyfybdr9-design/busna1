export const messages: Record<string, { ar: string; en: string }> = {
  validation_failed: { ar: 'البيانات المدخلة غير صحيحة', en: 'Invalid input' },
  unauthorized: { ar: 'يلزم تسجيل الدخول', en: 'Authentication required' },
  invalid_credentials: { ar: 'بيانات الدخول غير صحيحة', en: 'Invalid credentials' },
  account_locked: { ar: 'تم إيقاف الدخول مؤقتًا بسبب محاولات متكررة. حاول لاحقًا', en: 'Too many attempts. Try again later' },
  forbidden: { ar: 'لا تملك صلاحية لهذا الإجراء', en: 'You do not have permission for this action' },
  context_required: { ar: 'اختر الجهة والدور أولًا', en: 'Select an organization and role first' },
  not_found: { ar: 'العنصر غير موجود', en: 'Not found' },
  conflict: { ar: 'يتعارض هذا الطلب مع بيانات موجودة', en: 'Conflicts with existing data' },
  invite_invalid: { ar: 'رابط الدعوة غير صالح أو منتهي', en: 'Invite link is invalid or expired' },
  invite_email_mismatch: { ar: 'يجب استخدام نفس البريد أو الجوال المرسل له الدعوة', en: 'Use the email/phone the invite was sent to' },
  account_exists: { ar: 'يوجد حساب بهذه البيانات. سجّل الدخول لقبول الدعوة', en: 'An account exists. Sign in to accept the invite' },
  tenant_not_found: { ar: 'رمز الجهة غير صحيح', en: 'Organization code not found' },
  tenant_suspended: { ar: 'حساب الجهة موقوف. تواصل مع إدارة الجهة', en: 'Organization is suspended' },
  route_incomplete: { ar: 'المسار يحتاج باصًا وسائقًا وطلابًا قبل إنشاء الرحلة', en: 'Route needs a bus, a driver and riders first' },
  invalid_driver: { ar: 'المستخدم المحدد ليس سائقًا في هذه الجهة', en: 'Selected user is not a driver here' },
  trip_exists: { ar: 'توجد رحلة لهذا المسار في نفس التاريخ', en: 'A trip already exists for this route and date' },
  trip_not_active: { ar: 'الرحلة ليست جارية', en: 'Trip is not in progress' },
  trip_not_startable: { ar: 'لا يمكن بدء هذه الرحلة الآن', en: 'This trip cannot be started now' },
  trip_not_cancellable: { ar: 'لا يمكن إلغاء هذه الرحلة', en: 'This trip cannot be cancelled' },
  trip_terminal_state: { ar: 'الرحلة منتهية أو ملغاة', en: 'Trip is completed or cancelled' },
  invalid_trip_transition: { ar: 'تغيير حالة الرحلة غير مسموح', en: 'Invalid trip status change' },
  driver_cannot_modify_trip_plan: { ar: 'لا يمكن للسائق تعديل خطة الرحلة', en: 'Drivers cannot modify trip plan' },
  unresolved_riders: { ar: 'يوجد طلاب حالتهم غير محسومة', en: 'Some students are unresolved' },
  inspection_incomplete: { ar: 'أكمل جميع خطوات فحص الباص', en: 'Complete all inspection steps' },
  inspection_not_pending: { ar: 'لا يوجد فحص مطلوب لهذه الرحلة', en: 'No inspection pending for this trip' },
  rear_qr_mismatch: { ar: 'رمز مؤخرة الباص غير مطابق', en: 'Rear-of-bus code does not match' },
  qr_not_on_trip: { ar: 'هذه البطاقة لا تخص طالبًا في هذه الرحلة', en: 'This card is not for a student on this trip' },
  absence_not_editable: { ar: 'لا يمكن تعديل طلب الغياب', en: 'Absence request cannot be changed' },
  absence_date_past: { ar: 'لا يمكن طلب غياب لتاريخ مضى', en: 'Cannot request absence for a past date' },
  rate_limited: { ar: 'طلبات كثيرة. حاول بعد قليل', en: 'Too many requests' },
  weak_password: { ar: 'كلمة المرور يجب ألا تقل عن 8 أحرف وتحتوي حروفًا وأرقامًا', en: 'Password must be 8+ chars with letters and digits' },
  internal_error: { ar: 'حدث خطأ غير متوقع. حاول مرة أخرى', en: 'Unexpected error. Please try again' },
};

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    public details?: unknown,
  ) {
    super(code);
  }
}

export const notFound = () => new AppError(404, 'not_found');
export const forbidden = () => new AppError(403, 'forbidden');
export const badRequest = (code = 'validation_failed', details?: unknown) => new AppError(400, code, details);
export const conflict = (code = 'conflict', details?: unknown) => new AppError(409, code, details);

export function messageFor(code: string, lang: 'ar' | 'en') {
  return messages[code]?.[lang] ?? messages.internal_error[lang];
}
