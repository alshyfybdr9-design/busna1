/**
 * الجلسة: رمز التحديث ورمز الوصول في SecureStore (مع إتاحة بعد أول فتح للقفل حتى يعمل
 * إرسال الموقع في الخلفية والشاشة مقفلة). يمكن استخدام هذا الملف من مهمة الخلفية (بدون React).
 */
import * as SecureStore from 'expo-secure-store';
import { API_URL } from './config';

const OPTS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };
const K = { rt: 'busna_rt', at: 'busna_at', atExp: 'busna_at_exp', mid: 'busna_mid', user: 'busna_user' };

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(message);
  }
}

export interface Membership {
  membershipId: string;
  role: 'tenant_admin' | 'supervisor' | 'driver' | 'parent';
  tenantId: string;
  tenantName: string;
  tenantNameEn: string | null;
  tenantCode: string;
  logoUrl: string | null;
}

export interface SessionPayload {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  user: { id: string; fullName: string };
  context: { kind: 'membership'; mid: string } | { kind: 'platform' } | { kind: 'none' };
  contexts: { memberships: Membership[]; platformAdmin: boolean };
}

let memAccess: { token: string; exp: number } | null = null;
let refreshing: Promise<SessionPayload | null> | null = null;
let listener: ((s: SessionPayload | null) => void) | null = null;
export let lang: 'ar' | 'en' = 'ar';
export const setApiLang = (l: 'ar' | 'en') => (lang = l);

export function onSessionChange(fn: (s: SessionPayload | null) => void) {
  listener = fn;
}

async function persist(s: SessionPayload | null) {
  if (s) {
    const exp = Date.now() + (s.accessTokenExpiresIn - 30) * 1000;
    memAccess = { token: s.accessToken, exp };
    await SecureStore.setItemAsync(K.rt, s.refreshToken, OPTS);
    await SecureStore.setItemAsync(K.at, s.accessToken, OPTS);
    await SecureStore.setItemAsync(K.atExp, String(exp), OPTS);
    if (s.context.kind === 'membership') await SecureStore.setItemAsync(K.mid, s.context.mid, OPTS);
    else await SecureStore.deleteItemAsync(K.mid, OPTS);
  } else {
    memAccess = null;
    for (const k of Object.values(K)) await SecureStore.deleteItemAsync(k, OPTS);
  }
  listener?.(s);
}

async function raw<T>(method: string, path: string, body?: unknown, token?: string | null, timeoutMs = 15000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'accept-language': lang, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // في وضع التطوير نعرض العنوان وسبب الفشل لتسهيل التشخيص؛ في الإنتاج رسالة بسيطة فقط
    const detail = __DEV__ ? `\n${API_URL}\n${(e as Error)?.message ?? ''}` : '';
    throw new ApiError(0, 'network', (lang === 'ar' ? 'لا يوجد اتصال بالخادم. تحقق من الإنترنت.' : 'No connection to the server.') + detail);
  }
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? 'error', json?.error?.message ?? 'Error', json?.error?.details);
  return json as T;
}

export async function refresh(want?: { membershipId?: string }): Promise<SessionPayload | null> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const rt = await SecureStore.getItemAsync(K.rt, OPTS);
    if (!rt) return null;
    const mid = want?.membershipId ?? (await SecureStore.getItemAsync(K.mid, OPTS)) ?? undefined;
    try {
      const s = await raw<SessionPayload>('POST', '/auth/refresh', { refreshToken: rt, ...(mid ? { membershipId: mid } : {}) });
      await persist(s);
      return s;
    } catch (e) {
      // خطأ شبكة: نُبقي الجلسة؛ رفض الخادم: نُنهيها
      if (e instanceof ApiError && e.status !== 0) await persist(null);
      throw e;
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function accessToken(): Promise<string | null> {
  if (memAccess && memAccess.exp > Date.now()) return memAccess.token;
  const [at, exp] = await Promise.all([SecureStore.getItemAsync(K.at, OPTS), SecureStore.getItemAsync(K.atExp, OPTS)]);
  if (at && exp && Number(exp) > Date.now()) {
    memAccess = { token: at, exp: Number(exp) };
    return at;
  }
  const s = await refresh();
  return s?.accessToken ?? null;
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await accessToken();
  try {
    return await raw<T>(method, path, body, token);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      const s = await refresh().catch(() => null);
      if (s) return raw<T>(method, path, body, s.accessToken);
    }
    throw e;
  }
}

export async function login(identifier: string, password: string) {
  const s = await raw<SessionPayload>('POST', '/auth/login', { identifier, password });
  await persist(s);
  return s;
}

export async function acceptInvite(token: string, body: Record<string, unknown>) {
  const s = await raw<SessionPayload>('POST', `/auth/invites/${token}/accept`, body);
  await persist(s);
  return s;
}

export async function selectMembership(membershipId: string) {
  return refresh({ membershipId });
}

export async function logout() {
  const rt = await SecureStore.getItemAsync(K.rt, OPTS);
  if (rt) await raw('POST', '/auth/logout', { refreshToken: rt }).catch(() => {});
  await persist(null);
}

export const publicApi = {
  resolveTenant: (code: string) => raw<{ tenant: { code: string; name: string; nameEn: string | null; logoUrl: string | null } }>('POST', '/auth/tenant/resolve', { code }),
  invitePreview: (token: string) => raw<{ invite: { role: string; requiresEmail: boolean; requiresPhone: boolean; tenant: { name: string; nameEn: string | null; logoUrl: string | null } } }>('GET', `/auth/invites/${token}`),
};

export function currentMembership(s: SessionPayload | null) {
  if (!s || s.context.kind !== 'membership') return null;
  const mid = s.context.mid;
  return s.contexts.memberships.find((m) => m.membershipId === mid) ?? null;
}
