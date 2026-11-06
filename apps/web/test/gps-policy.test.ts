// Run: pnpm --filter @busna/web test   (Node ≥ 22.18 strips TypeScript natively)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TRACKING, gpsState, publishDecision, trackingConfigFrom, type Fix,
} from "../src/lib/gps-policy.ts";

const cfg = DEFAULT_TRACKING;
const at = (s: number, lat = 24.8, lng = 46.6, speed: number | null = null, accuracy: number | null = 10): Fix =>
  ({ lat, lng, speed, accuracy, t: s * 1000 });
// ~111 m per 0.001° latitude
const north = (m: number) => 24.8 + m / 111_000;

test("config: defaults, clamping and junk", () => {
  assert.deepEqual(trackingConfigFrom(null), DEFAULT_TRACKING);
  assert.deepEqual(trackingConfigFrom({ approach_radius_m: 700 }), DEFAULT_TRACKING);
  const c = trackingConfigFrom({ gps_interval_s: 1, gps_heartbeat_s: 99999, gps_stale_after_s: "45", gps_offline_after_s: "abc" });
  assert.equal(c.gps_interval_s, 5);
  assert.equal(c.gps_heartbeat_s, 300);
  assert.equal(c.gps_stale_after_s, 45);
  assert.equal(c.gps_offline_after_s, 300);
  assert.equal(trackingConfigFrom({ gps_interval_s: 7.5 }).gps_interval_s, 10, "non-integers ignored");
});

test("publish: first fix always, imprecise fixes never", () => {
  assert.equal(publishDecision(null, at(0), cfg), "publish");
  assert.equal(publishDecision(null, at(0, 24.8, 46.6, null, 400), cfg), "reject");
  assert.equal(publishDecision(null, at(0, NaN), cfg), "reject");
});

test("publish: every interval while moving", () => {
  const last = at(0);
  assert.equal(publishDecision(last, at(5, north(80), 46.6, 12), cfg), "skip", "moving but too soon");
  assert.equal(publishDecision(last, at(10, north(120), 46.6, 12), cfg), "publish");
  // moving inferred from displacement when the device reports no speed
  assert.equal(publishDecision(last, at(10, north(50), 46.6, null), cfg), "publish");
});

test("publish: heartbeat while stationary", () => {
  const last = at(0);
  assert.equal(publishDecision(last, at(10, north(3), 46.6, 0), cfg), "skip", "parked: interval is not enough");
  assert.equal(publishDecision(last, at(29, north(3), 46.6, 0), cfg), "skip");
  assert.equal(publishDecision(last, at(30, north(3), 46.6, 0), cfg), "publish");
});

test("publish: out-of-order fixes are skipped", () => {
  assert.equal(publishDecision(at(100), at(90, north(500), 46.6, 15), cfg), "skip");
});

test("freshness matches server thresholds", () => {
  const now = 1_000_000_000;
  assert.equal(gpsState(null, cfg, now), "none");
  assert.equal(gpsState("not a date", cfg, now), "none");
  assert.equal(gpsState(now - 10_000, cfg, now), "live");
  assert.equal(gpsState(now - 60_000, cfg, now), "live");
  assert.equal(gpsState(now - 61_000, cfg, now), "stale");
  assert.equal(gpsState(new Date(now - 300_000).toISOString(), cfg, now), "stale");
  assert.equal(gpsState(now - 301_000, cfg, now), "offline");
});
