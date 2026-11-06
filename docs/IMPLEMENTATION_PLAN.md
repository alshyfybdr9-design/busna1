# BUSNA — School Transportation: Audit & Implementation Plan

_Audit date: 2026-11-06 · branch audited: `claude/school-transport-foundation` @ `13e2c62`_

## 1. Audit summary

### What exists
| Area | State | Where |
|---|---|---|
| Stack | Next.js 15 (App Router) + Supabase (Auth, Postgres, RLS, Realtime) + MapLibre, pnpm monorepo | `apps/web`, `supabase/` |
| Tenancy | **Tenant = school.** Every row carries `school_id`; composite FKs `(id, school_id)` make cross-tenant references impossible at the DB level; RLS on every table; helpers in a non-exposed `private` schema | `0100`, `0200`, `0300` |
| Roles | platform admin · school owner/admin/viewer · driver · supervisor · guardian | `0100`, `0300` |
| Trip engine | `scheduled → started → in_progress → completed / cancelled`; delay and emergency are orthogonal flags; every change is a `SECURITY DEFINER` RPC that locks the trip, validates, writes an immutable `trip_events` row and creates notifications in the same transaction | `0400` |
| Safety | `end_trip` refuses while any student is `boarded`; pending students need explicit confirmation; drivers cannot read guardian phone numbers | `0400` |
| GPS | Batched `push_locations` with offline queue; rejected outside active trips; `bus_live_positions` (1 row per active trip) + `bus_locations` breadcrumbs | `0400`, `lib/tracking.ts` |
| Parent privacy | Parents see the bus **only while their own child is on board** an active trip; no stop list (other children's addresses); breadcrumbs only since boarding | `0300`, `0500` |
| Admin UI | Dashboard (KPIs, live map, alerts), trips/routes editor, students (+Excel import), fleet, staff, parents & requests, reports (8 kinds, CSV/print), settings, AI assistant with approval-gated actions | `apps/web/src/app/admin` |
| Driver/supervisor UI | Trip console: start/arrive/end, one-tap attendance with offline outbox, delay, incident, notes, contacts (supervisor only) | `apps/web/src/app/staff` |
| Parent UI | Children overview, live tracking when eligible, notifications, requests, assistant | `apps/web/src/app/parent` |
| Tests | 23 SQL test blocks covering isolation, roles, trip flow, import, reports, approvals | `supabase/tests` |

**Baseline verified before any change:** all DB tests pass on PostgreSQL 16; `tsc --noEmit` clean; `next build` succeeds.

### Important finding: no university module
The task brief asks not to break "existing university transportation features". **This repository contains none**, and `alshyfybdr9-design/busna1` is the only repository this account exposes. If a university product exists elsewhere, it must be attached before any shared-tenancy work (§4, D1) so the two can share auth and organizations without collision.

### Gap analysis against the brief

Legend: ✅ done · 🟡 partial · ❌ missing

| Brief item | Phase | State | Notes |
|---|---|---|---|
| Tenant isolation, RLS, audit log | 1 | ✅ | Strong. Audit trigger on 12 management tables |
| Organizations incl. transport companies, school↔operator contracts | 1/2 | ❌ | Needs decision D1 |
| Tenant onboarding | 1 | 🟡 | `create_school` RPC only; no platform-admin UI |
| Subscription status / SaaS billing | 3 | ❌ | |
| School dashboard KPIs & alerts | 1 | ✅ | |
| Live fleet map: live/**stale/offline**, progress, ETA | 1 | ✅ **(this increment)** | Was live-vs-stale with a hard-coded 3 min |
| Student management, import, guardians, route assignment | 1 | ✅ | |
| Authorized pickup contacts | 1 | ❌ | |
| Bus documents (registration/insurance/inspection expiry) | 1 | ✅ **(this increment)** | |
| Bus substitution | 1 | 🟡 | `update_trip_assignment` works; no mid-trip "interrupted → substitute bus" flow |
| Routes, ordered stops, map editing, capacity checks | 1 | ✅ | |
| Trip lifecycle Scheduled→Ready→Active→Completed + Interrupted | 1 | 🟡 | Needs decision D2 |
| GPS: configurable 10 s, adaptive, heartbeat, batching, offline | 1 | ✅ **(this increment)** | Was fixed 25 m / 20 s |
| GPS retention & aggregation | 1 | ✅ **(this increment)** | Per-school window, summaries kept |
| Attendance events timestamped & attributed | 1 | ✅ | |
| In-app notifications from real events, dedupe | 1 | ✅ | |
| Notification templates (ar/en), preferences per type, delivery worker (push/SMS/WhatsApp/email), retries, **critical escalation** | 1 | ❌ | Biggest Phase 1 gap |
| Realtime efficiency (no per-GPS fan-out to every user) | 1 | 🟡 | Uses `postgres_changes`; RLS evaluated per subscriber per change |
| English locale | 1 | ❌ | Arabic-only UI |
| Supervisor app | 2 | 🟡 | Shared trip console; no QR, wrong-bus warning, correction audit UI |
| End-of-trip **physical inspection** record | 2 | ❌ | Recommend pulling into Phase 1 (D4) |
| Parent absence requests feeding manifests | 2 | 🟡 | Free-text `absence_notice` request only |
| Incidents | 2 | ✅ | SOS / medical categories partly covered |
| Reports | 2 | ✅ | 8 report kinds; PDF via print |
| Route optimisation, insights, fees | 3 | ❌ | |

### Security & privacy findings (to fix in step 1.6)
1. **Drivers can read the full student row** (home address, home coordinates, notes) for students on their routes. PDPL data minimisation: expose a column-limited manifest RPC and drop the staff branch from `students_select`.
2. `parent_requests`: admins hold table-wide `UPDATE`, so they can rewrite a parent's message or guardian id. Restrict to `respond_parent_request`.
3. `incidents`: `resolved_by` is client-writable, so a resolution can be attributed to someone else. Move to an RPC that stamps `auth.uid()`.
4. `school_members`: an owner can remove or demote the last owner (tenant lock-out).
5. Realtime `postgres_changes` on `bus_live_positions` runs RLS (incl. `parent_can_track`) per subscriber per GPS write. Fine at pilot scale, not for thousands of buses. See step 1.5.
6. Default map style is the public OpenFreeMap instance. Production should use a contracted provider or self-hosted tiles (the URL is already an env var).
7. `apps/web/tsconfig.tsbuildinfo` is committed (build noise).

None of these leak data across tenants. All are within one school.

## 2. This increment — Fleet operations (Phase 1, step 1.1) ✅

**Migration** `supabase/migrations/20261107000100_fleet_ops.sql`. It is purely additive: new nullable columns, a view, new functions and one new table. No existing function, policy or column changes.

| Feature | Server | Client |
|---|---|---|
| Vehicle documents | `buses.registration_expiry / insurance_expiry / inspection_expiry`; view `fleet_compliance` (security_invoker, so the caller's RLS applies) incl. driver licences; state `valid / expiring / expired` by school's `document_warning_days` | Bus form date fields; expiry lines on bus cards; dashboard alerts (expired = critical) |
| Bounded settings | `private.tracking_config(settings)` clamps every value (`settings` is admin-editable JSON) | `lib/gps-policy.ts::trackingConfigFrom` mirrors the bounds; new "التتبع والامتثال" settings section with validation |
| GPS cadence | `public.tracking_config(school)` for staff devices | Tracker: every **10 s** moving, **30 s** heartbeat parked, active re-fix if the OS goes silent, imprecise/out-of-order fixes dropped |
| 3-state freshness | `private.gps_state()` `none / live / stale / offline` (60 s / 300 s default) | Same rule in `gpsState()`; dashboard map + alerts + fleet cards |
| Live fleet read model | `public.fleet_live(school)`: one call per refresh; per bus: active trip, driver/supervisor, expected/on-board/dropped/absent, stop progress, next stop, distance, ETA (only from a **live** fix), `behind_schedule_min` | Fleet page uses it (30 s refresh while visible) |
| Retention | `trip_track_summaries` + `private.compact_bus_locations()` summarises then deletes breadcrumbs of **closed** trips older than the school's `gps_retention_days` (default 90, 7–730); batch-limited, idempotent, scheduled with pg_cron when installed | — |

**Tests**
- `supabase/tests/20_fleet_ops.sql`: clamping, compliance states and cross-tenant invisibility; driver sees only own licence; parents see nothing; `fleet_live` authorization (parent, driver, other school → `forbidden`); none→live→stale→offline transitions; no ETA without a live fix; retention only touches closed trips past the window, keeps active trips, is idempotent, and is not callable by clients.
- `apps/web/test/gps-policy.test.ts`: 6 unit tests for cadence and freshness.
- `supabase/tests/run.sh` now runs every numbered test file and fails the run if any file fails (verified with a deliberately failing file).

**Not verified here:** rendering against a real Supabase project (no project credentials in this environment). The `fleet_live` JSON was checked field-by-field against the TypeScript types on a local database.

## 3. Remaining plan

Each step is one migration + tests + UI, merged separately, with the full DB suite green.

### Phase 1 — Core (remaining)
| Step | Scope | Migration risk |
|---|---|---|
| **1.2 Trip lifecycle** | Add `ready` (pre-trip check: vehicle, driver, supervisor present) and `interrupted` (breakdown; students stay on manifest; `resume_trip` optionally with substitute bus). Redefine the functions that test `status in ('started','in_progress')` through one `private.is_active(status)` helper | **Medium**: enum addition + ~8 function redefinitions. Full regression suite must stay green. UI keeps `started/in_progress` labelled "نشطة" |
| **1.3 Notification engine** | `notification_templates` (key × locale × channel), `notification_preferences` (per guardian × type × channel; critical types not opt-out-able), `notification_deliveries` (channel, provider id, attempts, next_attempt_at, status). Supabase Edge Function worker: claims due rows with `for update skip locked`, provider adapters (Web Push VAPID, SMS, WhatsApp Cloud API, email), exponential retry, dedupe key. **Escalation:** `critical` incidents/emergencies require admin acknowledgement; unacknowledged after N min → SMS to all admins → next escalation tier | Low (new tables). Needs provider accounts (D5) |
| **1.4 Students** | `student_pickup_contacts` (admin-managed, guardian-readable, supervisor-readable for afternoon drop-off); separate afternoon drop-off point; archive flow | Low |
| **1.5 Realtime at scale** | Publish positions with Realtime **Broadcast** to private per-trip / per-school topics (authorization via `realtime.messages` RLS evaluated once at join, not per message); throttle to the school's interval; keep `postgres_changes` for low-volume tables | Low–medium |
| **1.6 Security hardening** | Fix findings 1–4 in §1; add rate limits on `push_locations` (per trip per minute) and on parent RPCs | Low; each finding gets a regression test |
| **1.7 Live map** | Dashboard map driven by `fleet_live`: filter by GPS state / delay / emergency, search by bus or driver, progress in popup | None |
| **1.8 English locale** | Message catalogue (`ar`, `en`) with `dir` switch; numbers/dates via `Intl` | None (UI only) |
| **1.9 E2E** | Playwright against a Supabase branch project: login per role, start trip, GPS push, parent visibility window, realtime | Needs a Supabase project |

### Phase 2 — Safety & operations
1. **End-of-trip reconciliation & physical inspection.** `safety_inspections(trip_id, inspected_by, method, seats_checked, notes, at)`. `end_trip` requires an inspection row from the supervisor (or driver when no supervisor). Unresolved passengers escalate through 1.3. UI copy states it **records a declaration**; it does not prove the inspection happened. _Recommended to pull into Phase 1 (D4)._
2. Supervisor app: QR boarding, wrong-bus warning, missing-student warning, attendance correction with reason + audit.
3. `student_absences` (date, period, status, cancel before cut-off) wired into `generate_trips` and live manifests.
4. Incident workflow: SOS one-tap, medical/accident categories, acknowledgement SLA.
5. Transport companies (depends on D1): operator tenant, fleet & staff owned by operator, `school_operator_contracts` granting route/trip-scoped access; schools keep student ownership; operators see only manifest columns needed to operate.
6. Reports: server-generated PDF, scheduled email.

### Phase 3 — Advanced
Route stop-order suggestions (local heuristic, capacity-aware; AI optional and never in the GPS path), recurring-delay and utilisation insights, SaaS billing (`organization_subscriptions`, provider webhooks), parent transport fees (`transportation_invoices`, provider merchant account per school/operator; **BUSNA's own account never holds school funds**), integrations (SIS import, Noor where permitted).

## 4. Decisions needed

| # | Decision | Recommendation |
|---|---|---|
| D1 | Multi-organization model for transport companies | **Keep `schools` as the student-data-owning tenant; add a separate `operators` tenant plus `school_operator_contracts`.** The alternative (rename everything to `organization_id`) rewrites every RLS policy and composite FK for no security gain |
| D2 | Trip states | Add `ready` and `interrupted`; keep `started`/`in_progress` internally and show both as "Active" |
| D3 | Expired vehicle documents | Warn only (current). Option: block `start_trip` when insurance/registration is expired, behind a school setting |
| D4 | Physical inspection timing | Pull into Phase 1. A child left on a bus is the highest-severity real-world failure |
| D5 | Notification providers | Web Push (VAPID, no vendor) first; SMS: Unifonic or Taqnyat (Saudi sender IDs); WhatsApp Cloud API needs approved templates |
| D6 | University product | Where does it live? Needed before shared auth/tenancy work |

## 5. Running the checks

```bash
# Database (needs a local PostgreSQL ≥ 15; Supabase is stubbed)
PGHOST=/tmp PGPORT=5432 PGUSER=postgres supabase/tests/run.sh

# Web unit tests, types, build
pnpm test:web
pnpm typecheck
pnpm build
```

### New configuration
| Setting (`schools.settings`) | Default | Bounds |
|---|---|---|
| `gps_interval_s` | 10 | 5–120 |
| `gps_heartbeat_s` | 30 | 15–300 |
| `gps_stale_after_s` | 60 | 20–900 |
| `gps_offline_after_s` | 300 | 60–3600 |
| `gps_retention_days` | 90 | 7–730 |
| `document_warning_days` | 30 | 1–180 |

If `pg_cron` is not enabled, schedule `select private.compact_bus_locations(2000);` daily from an external scheduler running as the database owner.
