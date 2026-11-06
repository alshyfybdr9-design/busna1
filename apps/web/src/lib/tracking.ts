"use client";
// Driver-device GPS publisher.
// - Shares location ONLY while a trip is active: the server rejects points for
//   inactive trips with `trip_not_active`, and the tracker stops itself.
// - Cadence (see gps-policy.ts): every gps_interval_s (default 10s) while
//   moving, every gps_heartbeat_s (default 30s) while parked. If the OS stops
//   delivering fixes, a heartbeat asks for a fresh one so the dashboard can
//   tell "parked" (live) from "device silent" (stale/offline).
// - Background: a PWA tracks only while the page is open (Wake Lock keeps the
//   screen on). Reliable lock-screen tracking needs a native wrapper.
// - Offline: points are queued in localStorage and flushed in batches when the
//   connection returns (server keeps the original GPS timestamps).
import { supabaseBrowser } from "./supabase/client";
import { isNetworkError, toAppError } from "./errors";
import { DEFAULT_TRACKING, publishDecision, type Fix, type TrackingConfig } from "./gps-policy";

export interface TrackerState {
  tripId: string | null;
  active: boolean;
  permission: "unknown" | "granted" | "denied" | "unavailable";
  queued: number;
  lastFixAt: number | null;
  lastSentAt: number | null;
  online: boolean;
  accuracy: number | null;
  error: string | null;
}

interface Point { lat: number; lng: number; heading: number | null; speed: number | null; accuracy: number | null; t: string }

const MAX_QUEUE = 2_000;
const MAX_BATCH = 200;
const ACTIVE_KEY = "busna:tracking:trip";
const qKey = (trip: string) => `busna:locq:${trip}`;

const toFix = (p: Point): Fix => ({ lat: p.lat, lng: p.lng, speed: p.speed, accuracy: p.accuracy, t: Date.parse(p.t) });

function readQueue(trip: string): Point[] {
  try { return JSON.parse(localStorage.getItem(qKey(trip)) || "[]"); } catch { return []; }
}
function writeQueue(trip: string, q: Point[]) {
  try { localStorage.setItem(qKey(trip), JSON.stringify(q.slice(-MAX_QUEUE))); } catch { /* storage full/blocked */ }
}

class LocationTracker {
  private state: TrackerState = {
    tripId: null, active: false, permission: "unknown", queued: 0, lastFixAt: null, lastSentAt: null,
    online: typeof navigator === "undefined" ? true : navigator.onLine, accuracy: null, error: null,
  };
  private listeners = new Set<(s: TrackerState) => void>();
  private watchId: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastQueued: Point | null = null;
  private flushing = false;
  private wakeLock: { release: () => Promise<void> } | null = null;
  private cfg: TrackingConfig = DEFAULT_TRACKING;

  subscribe(fn: (s: TrackerState) => void) {
    this.listeners.add(fn);
    fn(this.state);
    return () => { this.listeners.delete(fn); };
  }
  private set(patch: Partial<TrackerState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l(this.state));
  }
  get current() { return this.state; }

  /** Last good fix, for attaching a location to attendance/start/end actions. */
  lastPosition(): { lat: number; lng: number } | null {
    return this.lastQueued ? { lat: this.lastQueued.lat, lng: this.lastQueued.lng } : null;
  }

  /** cfg: from tracking_config(school) — interval/heartbeat set by the school, clamped server-side. */
  start(tripId: string, cfg: TrackingConfig = DEFAULT_TRACKING) {
    if (typeof window === "undefined") return;
    if (this.state.active && this.state.tripId === tripId && JSON.stringify(this.cfg) === JSON.stringify(cfg)) return;
    this.cfg = cfg;
    this.stop(false);
    if (!("geolocation" in navigator)) { this.set({ permission: "unavailable", error: "الجهاز لا يدعم تحديد الموقع" }); return; }

    localStorage.setItem(ACTIVE_KEY, tripId);
    this.set({ tripId, active: true, error: null, queued: readQueue(tripId).length });

    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this.onFix(pos),
      (err) => {
        if (err.code === err.PERMISSION_DENIED) this.set({ permission: "denied", error: "يجب السماح بالوصول إلى الموقع لمشاركة موقع الباص" });
        else this.set({ error: "إشارة GPS ضعيفة، جارٍ المحاولة…" });
      },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 30_000 },
    );
    this.timer = setInterval(() => this.tick(), cfg.gps_interval_s * 1000);
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    document.addEventListener("visibilitychange", this.onVisibility);
    void this.acquireWakeLock();
  }

  /** Stop sharing. `clear` drops any unsent points (used when the trip ended). */
  stop(clear = true) {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    if (this.timer) clearInterval(this.timer);
    this.watchId = null; this.timer = null; this.lastQueued = null;
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.onOnline);
      window.removeEventListener("offline", this.onOffline);
      document.removeEventListener("visibilitychange", this.onVisibility);
      if (clear && this.state.tripId) { localStorage.removeItem(qKey(this.state.tripId)); localStorage.removeItem(ACTIVE_KEY); }
    }
    void this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    this.set({ active: false, ...(clear ? { tripId: null, queued: 0 } : {}) });
  }

  /** Trip id that was being tracked before a reload, if any. */
  resumable(): string | null {
    try { return localStorage.getItem(ACTIVE_KEY); } catch { return null; }
  }

  private tick() {
    // Heartbeat: some devices stop calling watchPosition while parked.
    const silentFor = Date.now() - (this.state.lastFixAt ?? 0);
    if (this.state.permission === "granted" && silentFor >= this.cfg.gps_heartbeat_s * 1000) {
      navigator.geolocation.getCurrentPosition((p) => this.onFix(p), () => {},
        { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 });
    }
    void this.flush();
  }

  private onOnline = () => { this.set({ online: true }); void this.flush(); };
  private onOffline = () => this.set({ online: false });
  private onVisibility = () => { if (document.visibilityState === "visible") { void this.acquireWakeLock(); void this.flush(); } };

  private async acquireWakeLock() {
    try {
      const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } };
      if (nav.wakeLock && !this.wakeLock) this.wakeLock = await nav.wakeLock.request("screen");
    } catch { /* not supported / denied: tracking still works while visible */ }
  }

  private onFix(pos: GeolocationPosition) {
    const p: Point = {
      lat: pos.coords.latitude, lng: pos.coords.longitude,
      heading: Number.isFinite(pos.coords.heading) ? pos.coords.heading : null,
      speed: Number.isFinite(pos.coords.speed) ? pos.coords.speed : null,
      accuracy: pos.coords.accuracy ?? null,
      t: new Date(pos.timestamp).toISOString(),
    };
    this.set({ permission: "granted", lastFixAt: Date.now(), accuracy: p.accuracy, error: null });
    const last = this.lastQueued;
    if (!this.state.tripId || publishDecision(last ? toFix(last) : null, toFix(p), this.cfg) !== "publish") return;
    this.lastQueued = p;
    const q = readQueue(this.state.tripId);
    q.push(p);
    writeQueue(this.state.tripId, q);
    this.set({ queued: q.length });
    if (!last) void this.flush(); // publish the first fix immediately
  }

  async flush() {
    const trip = this.state.tripId;
    if (!trip || this.flushing || !navigator.onLine) return;
    const q = readQueue(trip);
    if (q.length === 0) return;
    this.flushing = true;
    try {
      const batch = q.slice(0, MAX_BATCH);
      const { error } = await supabaseBrowser().rpc("push_locations", { p_trip: trip, p_points: batch });
      if (error) throw error;
      const rest = readQueue(trip).slice(batch.length);
      writeQueue(trip, rest);
      this.set({ queued: rest.length, lastSentAt: Date.now(), online: true });
    } catch (err) {
      if (isNetworkError(err)) { this.set({ online: false }); return; }
      const e = toAppError(err);
      if (e.code === "trip_not_active" || e.code === "not_assigned" || e.code === "trip_not_found") {
        this.stop(true); // never keep sharing outside an active trip
      } else {
        this.set({ error: e.message });
      }
    } finally {
      this.flushing = false;
    }
  }
}

export const tracker = new LocationTracker();

/** One-shot best-effort position (for start/arrive/end/attendance). */
export function currentPosition(timeoutMs = 4000): Promise<{ lat: number; lng: number } | null> {
  const cached = tracker.lastPosition();
  if (cached) return Promise.resolve(cached);
  if (typeof navigator === "undefined" || !("geolocation" in navigator)) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 15_000 },
    );
  });
}
