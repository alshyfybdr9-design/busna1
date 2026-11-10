import { config } from '../config.js';

/**
 * مزود حساب وقت الوصول التقديري — قابل للاستبدال (OSRM ذاتي الاستضافة، Google Routes، Mapbox، ...).
 * القاعدة: لا يُعرض وقت وصول إلا عند وجود مصدر حساب فعلي، ويوسم دائمًا بأنه تقديري،
 * ولا يُحسب من موقع قديم.
 */
export interface EtaResult {
  available: boolean;
  reason?: 'no_provider' | 'stale_location' | 'provider_error';
  seconds?: number;
  distanceM?: number;
  estimated?: true;
  provider?: string;
}

export interface EtaInput {
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
  locationAgeSec: number;
  staleAfterSec?: number;
  /** متوسط سرعة الباص الأخيرة (م/ث) إن توفرت */
  recentSpeedMps?: number | null;
}

export interface EtaProvider {
  name: string;
  estimate(input: EtaInput): Promise<EtaResult>;
}

/** المسافة على سطح الأرض بالأمتار */
export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

class NoEtaProvider implements EtaProvider {
  name = 'none';
  async estimate(): Promise<EtaResult> {
    return { available: false, reason: 'no_provider' };
  }
}

/**
 * تقدير تقريبي بلا خدمة خارجية: المسافة المباشرة × معامل الطرق ÷ سرعة الباص الأخيرة
 * (محصورة بين 15 و50 كم/س). مناسب كبداية؛ OSRM أدق لأنه يتبع الطرق الفعلية.
 */
class EstimateProvider implements EtaProvider {
  name = 'estimate';
  async estimate(i: EtaInput): Promise<EtaResult> {
    if (i.staleAfterSec != null && i.locationAgeSec > i.staleAfterSec) return { available: false, reason: 'stale_location' };
    const straight = haversineM(i.from, i.to);
    const road = straight * 1.35;
    const speed = Math.min(13.9, Math.max(4.2, i.recentSpeedMps && i.recentSpeedMps > 0.5 ? i.recentSpeedMps : 7));
    // دقيقة إضافية لكل 1.5 كم تقريبًا للتوقفات والإشارات
    const seconds = Math.round(road / speed + (road / 1500) * 60);
    return { available: true, seconds, distanceM: Math.round(straight), estimated: true, provider: this.name };
  }
}

class OsrmProvider implements EtaProvider {
  name = 'osrm';
  private fallback = new EstimateProvider();
  constructor(private baseUrl: string) {}
  async estimate(i: EtaInput): Promise<EtaResult> {
    if (i.staleAfterSec != null && i.locationAgeSec > i.staleAfterSec) return { available: false, reason: 'stale_location' };
    try {
      const url = `${this.baseUrl.replace(/\/$/, '')}/route/v1/driving/${i.from.lng},${i.from.lat};${i.to.lng},${i.to.lat}?overview=false`;
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      const j: any = await r.json();
      const route = j?.routes?.[0];
      if (!r.ok || !route) throw new Error('osrm_no_route');
      return { available: true, seconds: Math.round(route.duration), distanceM: Math.round(haversineM(i.from, i.to)), estimated: true, provider: this.name };
    } catch {
      // عند تعذر الخدمة: نرجع للتقدير الداخلي بدل إخفاء المعلومة
      return this.fallback.estimate(i);
    }
  }
}

let provider: EtaProvider | null = null;
export function etaProvider(): EtaProvider {
  if (!provider) {
    const c = config();
    switch (c.ROUTING_PROVIDER) {
      case 'estimate':
        provider = new EstimateProvider();
        break;
      case 'osrm':
        provider = c.OSRM_URL ? new OsrmProvider(c.OSRM_URL) : new EstimateProvider();
        break;
      case 'none':
      default:
        provider = new NoEtaProvider();
    }
  }
  return provider;
}

/** للاختبارات فقط */
export function setEtaProvider(p: EtaProvider | null) {
  provider = p;
}
