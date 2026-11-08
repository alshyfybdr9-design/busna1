import { config } from '../config.js';

/**
 * مزود حساب وقت الوصول التقديري — قابل للاستبدال (OSRM ذاتي الاستضافة، Google Routes، Mapbox، ...).
 * القاعدة: لا يُعرض وقت وصول إلا عند وجود مصدر حساب فعلي، ويوسم دائمًا بأنه تقديري.
 */
export interface EtaResult {
  available: boolean;
  reason?: 'no_provider' | 'stale_location' | 'provider_error';
  seconds?: number;
  estimated?: true;
  provider?: string;
}

export interface EtaProvider {
  name: string;
  estimate(input: {
    from: { lat: number; lng: number };
    to: { lat: number; lng: number };
    locationAgeSec: number;
  }): Promise<EtaResult>;
}

class NoEtaProvider implements EtaProvider {
  name = 'none';
  async estimate(): Promise<EtaResult> {
    return { available: false, reason: 'no_provider' };
  }
}

let provider: EtaProvider | null = null;
export function etaProvider(): EtaProvider {
  if (!provider) {
    switch (config().ROUTING_PROVIDER) {
      case 'none':
      default:
        provider = new NoEtaProvider();
    }
  }
  return provider;
}
