// Pure GPS rules shared by the driver tracker and the dashboards.
// No imports on purpose: unit-tested directly with `node --test`.
// Bounds and defaults mirror private.tracking_config() in
// supabase/migrations/20261107000100_fleet_ops.sql — keep them in sync.

export interface TrackingConfig {
  gps_interval_s: number;      // publish cadence while moving
  gps_heartbeat_s: number;     // publish cadence while stationary (proves the device is alive)
  gps_stale_after_s: number;   // older than this => "stale"
  gps_offline_after_s: number; // older than this => "offline"
}

export const DEFAULT_TRACKING: TrackingConfig = {
  gps_interval_s: 10,
  gps_heartbeat_s: 30,
  gps_stale_after_s: 60,
  gps_offline_after_s: 300,
};

const BOUNDS: Record<keyof TrackingConfig, [number, number]> = {
  gps_interval_s: [5, 120],
  gps_heartbeat_s: [15, 300],
  gps_stale_after_s: [20, 900],
  gps_offline_after_s: [60, 3600],
};

/** Clamps an untrusted settings object (schools.settings or tracking_config()) to safe values. */
export function trackingConfigFrom(raw: unknown): TrackingConfig {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_TRACKING };
  for (const key of Object.keys(BOUNDS) as (keyof TrackingConfig)[]) {
    const v = src[key];
    const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,6}$/.test(v) ? Number(v) : NaN;
    if (Number.isInteger(n)) out[key] = Math.min(Math.max(n, BOUNDS[key][0]), BOUNDS[key][1]);
  }
  return out;
}

export interface Fix {
  lat: number;
  lng: number;
  speed: number | null;    // m/s as reported by the device
  accuracy: number | null; // metres
  t: number;               // epoch ms of the fix
}

/** Fixes worse than this are never published (urban canyon / indoor noise). */
export const MAX_ACCURACY_M = 150;
/** Above this speed (m/s, ~5 km/h) the bus counts as moving. */
export const MOVING_SPEED_MS = 1.5;
/** Displacement that counts as movement when the device reports no speed. */
export const MIN_MOVE_M = 15;

export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export type PublishDecision = "publish" | "skip" | "reject";

/**
 * Adaptive cadence: every `gps_interval_s` while moving, every
 * `gps_heartbeat_s` while stationary, always the first fix, never an
 * imprecise or out-of-order one.
 */
export function publishDecision(last: Fix | null, next: Fix, cfg: TrackingConfig): PublishDecision {
  if (!Number.isFinite(next.lat) || !Number.isFinite(next.lng)) return "reject";
  if (next.accuracy != null && next.accuracy > MAX_ACCURACY_M) return "reject";
  if (!last) return "publish";
  const dt = next.t - last.t;
  if (dt <= 0) return "skip";
  const moved = distanceM(last, next);
  const moving = (next.speed != null && next.speed >= MOVING_SPEED_MS) || moved >= MIN_MOVE_M;
  const due = (moving ? cfg.gps_interval_s : cfg.gps_heartbeat_s) * 1000;
  return dt >= due ? "publish" : "skip";
}

export type GpsState = "none" | "live" | "stale" | "offline";

/** Same thresholds as private.gps_state() on the server. */
export function gpsState(recordedAt: string | number | null | undefined, cfg: TrackingConfig, now = Date.now()): GpsState {
  if (recordedAt == null) return "none";
  const t = typeof recordedAt === "number" ? recordedAt : Date.parse(recordedAt);
  if (!Number.isFinite(t)) return "none";
  const age = (now - t) / 1000;
  if (age <= cfg.gps_stale_after_s) return "live";
  if (age <= Math.max(cfg.gps_offline_after_s, cfg.gps_stale_after_s)) return "stale";
  return "offline";
}
