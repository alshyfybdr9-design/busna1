-- =====================================================================
-- Busna — Phase 1 security hardening
--   1. Account linking by VERIFIED PHONE only (email path removed)
--   2. Per-user rate limits for costly endpoints (AI assistants)
--   3. Indexes for foreign keys used by RLS helpers and hot paths
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. claim_my_records: email linking removed.
-- Supabase sets email_confirmed_at at sign-up when "Confirm email" is
-- disabled, so an email match is not proof of ownership: anyone could
-- register with a parent's address and inherit their children's records
-- and live bus location. Phone numbers are only linked after an OTP was
-- verified on that number.
-- ---------------------------------------------------------------------
create or replace function public.claim_my_records()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_phone text;
  v_staff int := 0;
  v_guardians int := 0;
begin
  select case when u.phone_confirmed_at is not null then public.normalize_phone(u.phone) end
    into v_phone
    from auth.users u where u.id = v_uid;

  if v_phone is not null then
    update public.staff set user_id = v_uid where phone = v_phone and user_id is null;
    get diagnostics v_staff = row_count;
    update public.guardians set user_id = v_uid where phone = v_phone and user_id is null;
    get diagnostics v_guardians = row_count;
  end if;

  insert into public.profiles (id, phone) values (v_uid, v_phone) on conflict (id) do nothing;
  return jsonb_build_object('staff_linked', v_staff, 'guardians_linked', v_guardians);
end $$;

-- ---------------------------------------------------------------------
-- 2. Rate limits. Buckets and their limits are defined HERE (server side),
-- so a client calling the RPC directly can only use up its own quota.
-- Fixed windows; one row per user, bucket and window.
-- ---------------------------------------------------------------------
create table private.rate_limit_buckets (
  bucket     text primary key,
  max_hits   int not null check (max_hits > 0),
  window_s   int not null check (window_s > 0)
);
insert into private.rate_limit_buckets (bucket, max_hits, window_s) values
  ('assistant_parent', 30, 3600),   -- 30 questions / hour / parent
  ('assistant_school', 60, 3600);   -- 60 questions / hour / dashboard user

create table private.rate_limits (
  user_id      uuid not null,
  bucket       text not null references private.rate_limit_buckets (bucket) on delete cascade,
  window_start timestamptz not null,
  hits         int not null default 0,
  primary key (user_id, bucket, window_start)
);

-- Counts one hit for the caller. Returns {allowed, remaining, retry_after_s}.
create or replace function public.consume_rate_limit(p_bucket text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  b private.rate_limit_buckets;
  v_start timestamptz;
  v_hits int;
begin
  select * into b from private.rate_limit_buckets where bucket = p_bucket;
  if not found then perform private.fail('unknown_bucket', 'نوع الحد غير معروف'); end if;

  v_start := to_timestamp(floor(extract(epoch from now()) / b.window_s) * b.window_s);
  insert into private.rate_limits (user_id, bucket, window_start, hits) values (v_uid, b.bucket, v_start, 1)
  on conflict (user_id, bucket, window_start) do update set hits = private.rate_limits.hits + 1
  returning hits into v_hits;
  -- keep at most the current window per user and bucket
  delete from private.rate_limits where user_id = v_uid and bucket = b.bucket and window_start < v_start;

  return jsonb_build_object(
    'allowed', v_hits <= b.max_hits,
    'remaining', greatest(b.max_hits - v_hits, 0),
    'retry_after_s', case when v_hits <= b.max_hits then 0
                          else ceil(extract(epoch from (v_start + make_interval(secs => b.window_s) - now())))::int end);
end $$;

revoke all on private.rate_limit_buckets, private.rate_limits from public, authenticated;
revoke execute on function public.consume_rate_limit(text) from public, anon;
grant execute on function public.consume_rate_limit(text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. Indexes for foreign keys / RLS predicates that had none.
-- private.staff_route_ids() and staff_bus_ids() run on every staff query
-- and filter routes/buses by driver/supervisor across all tenants.
-- ---------------------------------------------------------------------
create index trips_bus_idx                 on public.trips (bus_id) where bus_id is not null;
create index routes_driver_idx             on public.routes (driver_id) where driver_id is not null;
create index routes_supervisor_idx         on public.routes (supervisor_id) where supervisor_id is not null;
create index routes_bus_idx                on public.routes (bus_id) where bus_id is not null;
create index buses_default_driver_idx      on public.buses (default_driver_id) where default_driver_id is not null;
create index buses_default_supervisor_idx  on public.buses (default_supervisor_id) where default_supervisor_id is not null;
create index bus_locations_school_idx      on public.bus_locations (school_id, recorded_at);
create index route_students_stop_idx       on public.route_students (stop_id) where stop_id is not null;
create index trip_students_stop_idx        on public.trip_students (trip_stop_id) where trip_stop_id is not null;
create index incidents_trip_idx            on public.incidents (trip_id) where trip_id is not null;
create index incidents_bus_idx             on public.incidents (bus_id) where bus_id is not null;
create index parent_requests_guardian_idx  on public.parent_requests (guardian_id, created_at desc);
create index parent_requests_student_idx   on public.parent_requests (student_id) where student_id is not null;
create index notifications_trip_idx        on public.notifications (trip_id) where trip_id is not null;
create index notifications_student_idx     on public.notifications (student_id) where student_id is not null;
create index ai_action_proposals_school_idx on public.ai_action_proposals (school_id, created_at desc);
