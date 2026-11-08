/** عميل الـ API: رمز الوصول في الذاكرة فقط، ورمز التحديث في التخزين المحلي مع تدويره */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(message);
  }
}

export type Ctx = { kind: 'membership'; mid: string } | { kind: 'platform' } | { kind: 'none' };

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: { id: string; fullName: string; email: string | null; phone: string | null; locale: 'ar' | 'en' };
  context: Ctx;
  contexts: {
    memberships: Array<{ membershipId: string; role: string; tenantId: string; tenantName: string; tenantNameEn: string | null; tenantCode: string; logoUrl: string | null }>;
    platformAdmin: boolean;
  };
}

const RT_KEY = 'busna.rt';
const CTX_KEY = 'busna.ctx';
const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

let accessToken: string | null = null;
let refreshing: Promise<Session | null> | null = null;
let onSession: ((s: Session | null) => void) | null = null;

export function setSessionListener(fn: (s: Session | null) => void) {
  onSession = fn;
}

function store(s: Session | null) {
  accessToken = s?.accessToken ?? null;
  try {
    if (s) {
      localStorage.setItem(RT_KEY, s.refreshToken);
      localStorage.setItem(CTX_KEY, JSON.stringify(s.context));
    } else {
      localStorage.removeItem(RT_KEY);
      localStorage.removeItem(CTX_KEY);
    }
  } catch {
    /* التخزين غير متاح */
  }
  onSession?.(s);
}

export function lang(): 'ar' | 'en' {
  return document.documentElement.lang === 'en' ? 'en' : 'ar';
}

async function raw<T>(method: string, path: string, body?: unknown, token?: string | null): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/v1${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'accept-language': lang(),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', lang() === 'ar' ? 'تعذر الاتصال بالخادم. تحقق من الاتصال بالإنترنت.' : 'Cannot reach the server.');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, json?.error?.code ?? 'error', json?.error?.message ?? 'Error', json?.error?.details);
  }
  return json as T;
}

export async function refreshSession(want?: { membershipId?: string; platform?: boolean }): Promise<Session | null> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    let rt: string | null = null;
    let ctx: Ctx = { kind: 'none' };
    try {
      rt = localStorage.getItem(RT_KEY);
      ctx = JSON.parse(localStorage.getItem(CTX_KEY) ?? '{"kind":"none"}');
    } catch {
      /* ignore */
    }
    if (!rt) return null;
    const target = want ?? (ctx.kind === 'membership' ? { membershipId: ctx.mid } : ctx.kind === 'platform' ? { platform: true } : {});
    try {
      const s = await raw<Session>('POST', '/auth/refresh', { refreshToken: rt, ...target });
      store(s);
      return s;
    } catch (e) {
      if (e instanceof ApiError && e.status !== 0) store(null);
      throw e;
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  try {
    return await raw<T>(method, path, body, accessToken);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && !path.startsWith('/auth/')) {
      const s = await refreshSession().catch(() => null);
      if (s) return raw<T>(method, path, body, s.accessToken);
    }
    throw e;
  }
}

export async function login(identifier: string, password: string): Promise<Session> {
  const s = await raw<Session>('POST', '/auth/login', { identifier, password });
  store(s);
  return s;
}

export async function acceptInvite(token: string, body: Record<string, unknown>): Promise<Session> {
  const s = await raw<Session>('POST', `/auth/invites/${token}/accept`, body);
  store(s);
  return s;
}

export async function selectContext(want: { membershipId?: string; platform?: boolean }) {
  return refreshSession(want);
}

export async function logout() {
  try {
    const rt = localStorage.getItem(RT_KEY);
    if (rt) await raw('POST', '/auth/logout', { refreshToken: rt });
  } catch {
    /* ignore */
  }
  store(null);
}

export const publicApi = {
  resolveTenant: (code: string) => raw<{ tenant: { code: string; name: string; nameEn: string | null; logoUrl: string | null; kind: string } }>('POST', '/auth/tenant/resolve', { code }),
  invitePreview: (token: string) => raw<{ invite: { role: string; expiresAt: string; requiresEmail: boolean; requiresPhone: boolean; tenant: { code: string; name: string; nameEn: string | null; logoUrl: string | null } } }>('GET', `/auth/invites/${token}`),
};
