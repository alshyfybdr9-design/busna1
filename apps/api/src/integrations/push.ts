import { config } from '../config.js';

export interface PushMessage {
  to: string;
  /** نص آمن لشاشة القفل فقط — بدون اسم الطفل أو تفاصيل حساسة */
  title: string;
  body: string;
  data: Record<string, string>;
}

export interface PushResult {
  token: string;
  ok: boolean;
  /** الرمز لم يعد صالحًا ويجب حذفه */
  invalidToken?: boolean;
  error?: string;
}

export interface PushProvider {
  name: string;
  configured: boolean;
  send(messages: PushMessage[]): Promise<PushResult[]>;
}

class NoPushProvider implements PushProvider {
  name = 'none';
  configured = false;
  async send(messages: PushMessage[]) {
    return messages.map((m) => ({ token: m.to, ok: false, error: 'push_not_configured' }));
  }
}

/** Expo Push Service — يتطلب تطبيقًا مبنيًا عبر EAS مع إعداد FCM (أندرويد) وAPNs (iOS) */
class ExpoPushProvider implements PushProvider {
  name = 'expo';
  configured = true;
  async send(messages: PushMessage[]): Promise<PushResult[]> {
    const out: PushResult[] = [];
    for (let i = 0; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100);
      try {
        const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
        const token = config().EXPO_ACCESS_TOKEN;
        if (token) headers.authorization = `Bearer ${token}`;
        const res = await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers,
          body: JSON.stringify(chunk.map((m) => ({ to: m.to, title: m.title, body: m.body, data: m.data, sound: 'default', priority: 'high' }))),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`expo_http_${res.status}`);
        const json = (await res.json()) as { data?: Array<{ status: string; message?: string; details?: { error?: string } }> };
        chunk.forEach((m, idx) => {
          const t = json.data?.[idx];
          out.push({
            token: m.to,
            ok: t?.status === 'ok',
            invalidToken: t?.details?.error === 'DeviceNotRegistered',
            error: t?.status === 'ok' ? undefined : t?.details?.error ?? t?.message ?? 'unknown',
          });
        });
      } catch (e) {
        chunk.forEach((m) => out.push({ token: m.to, ok: false, error: (e as Error).message }));
      }
    }
    return out;
  }
}

let provider: PushProvider | null = null;
export function pushProvider(): PushProvider {
  if (!provider) provider = config().PUSH_PROVIDER === 'expo' ? new ExpoPushProvider() : new NoPushProvider();
  return provider;
}

/** للاختبارات */
export function setPushProvider(p: PushProvider | null) {
  provider = p;
}
