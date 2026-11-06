// Maps Supabase/PostgREST errors to user-facing Arabic messages.
// RPCs raise stable codes in `message` and Arabic text in `hint`.

export interface AppError {
  code: string;
  message: string; // Arabic, user-facing
  detail?: string;
}

const FALLBACK: Record<string, string> = {
  "42501": "لا تملك صلاحية تنفيذ هذا الإجراء",
  "23505": "هذا السجل موجود مسبقًا",
  "23503": "البيانات المرتبطة غير صحيحة أو تخص مدرسة أخرى",
  "23514": "بعض القيم المدخلة غير صحيحة",
  PGRST301: "انتهت الجلسة، يرجى تسجيل الدخول مجددًا",
  network: "تعذّر الاتصال بالخادم. تحقق من الإنترنت وحاول مرة أخرى",
};

interface PgLikeError {
  code?: string;
  message?: string;
  hint?: string | null;
  details?: string | null;
}

export function toAppError(err: unknown): AppError {
  if (!err) return { code: "unknown", message: "حدث خطأ غير متوقع" };
  if (err instanceof TypeError && /fetch/i.test(err.message)) {
    return { code: "network", message: FALLBACK.network };
  }
  const e = err as PgLikeError;
  if (e.code === "P0001" && e.message) {
    return { code: e.message, message: e.hint || "تعذّر تنفيذ الإجراء", detail: e.details || undefined };
  }
  if (e.code && FALLBACK[e.code]) return { code: e.code, message: FALLBACK[e.code], detail: e.message };
  return { code: e.code || "unknown", message: e.hint || "حدث خطأ غير متوقع، حاول مرة أخرى", detail: e.message };
}

export function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const msg = (err as { message?: string })?.message ?? "";
  return /Failed to fetch|NetworkError|network|ECONN|timeout/i.test(msg);
}
