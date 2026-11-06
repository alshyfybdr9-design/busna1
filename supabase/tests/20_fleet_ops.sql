-- =====================================================================
-- Busna — fleet operations tests (runs after 10_security_and_trip_flow.sql
-- in the same database, so it starts from that file's end state:
--   • النرجس — صباحي (bus 1) completed today with 5 breadcrumbs
--   • الملقا — صباحي (bus 2) active, driver2, one student boarded, emergency
-- =====================================================================
\set ON_ERROR_STOP on
\set QUIET on

\set owner_a  '''10000000-0000-4000-8000-000000000001'''
\set viewer_a '''10000000-0000-4000-8000-000000000007'''
\set driver1  '''10000000-0000-4000-8000-000000000002'''
\set driver2  '''10000000-0000-4000-8000-000000000003'''
\set parent1  '''10000000-0000-4000-8000-000000000005'''
\set owner_b  '''20000000-0000-4000-8000-000000000001'''

create function tests.bus(p_fleet jsonb, p_code text) returns jsonb language sql immutable as $$
  select e from jsonb_array_elements(p_fleet) e where e ->> 'code' = p_code
$$;
grant execute on function tests.bus(jsonb, text) to authenticated;

-- ---------------------------------------------------------------------
\echo '▶ tracking settings are clamped server-side'
do $$ declare c jsonb; begin
  c := private.tracking_config('{}');
  assert (c ->> 'gps_interval_s')::int = 10 and (c ->> 'gps_stale_after_s')::int = 60
     and (c ->> 'gps_offline_after_s')::int = 300 and (c ->> 'gps_retention_days')::int = 90, c::text;
  c := private.tracking_config('{"gps_interval_s": 1, "gps_retention_days": 999999, "gps_stale_after_s": "abc"}');
  assert (c ->> 'gps_interval_s')::int = 5, 'interval floor';
  assert (c ->> 'gps_retention_days')::int = 730, 'retention ceiling';
  assert (c ->> 'gps_stale_after_s')::int = 60, 'junk falls back to default';
  assert private.gps_state(null, c) = 'none';
  assert private.gps_state(now() - interval '10 seconds', c) = 'live';
  assert private.gps_state(now() - interval '2 minutes', c) = 'stale';
  assert private.gps_state(now() - interval '10 minutes', c) = 'offline';
end $$;

select tests.login(:driver2); set role authenticated;
do $$ begin
  assert (public.tracking_config('a0000000-0000-4000-8000-000000000001') ->> 'gps_interval_s')::int = 10;
end $$;
select tests.expect_error($q$select public.tracking_config('b0000000-0000-4000-8000-000000000001')$q$, 'forbidden');
reset role;

-- ---------------------------------------------------------------------
\echo '▶ vehicle documents & compliance view'
select tests.login(:owner_a); set role authenticated;
do $$ declare today date := (now() at time zone 'Asia/Riyadh')::date; begin
  update public.buses set registration_expiry = today - 1, insurance_expiry = today + 10, inspection_expiry = today + 200
   where id = 'a2000000-0000-4000-8000-000000000001';
  assert (select state from public.fleet_compliance where entity_id = 'a2000000-0000-4000-8000-000000000001' and kind = 'registration') = 'expired';
  assert (select days_left from public.fleet_compliance where entity_id = 'a2000000-0000-4000-8000-000000000001' and kind = 'insurance') = 10;
  assert (select state from public.fleet_compliance where entity_id = 'a2000000-0000-4000-8000-000000000001' and kind = 'insurance') = 'expiring';
  assert (select state from public.fleet_compliance where entity_id = 'a2000000-0000-4000-8000-000000000001' and kind = 'inspection') = 'valid';
  assert (select count(*) from public.fleet_compliance where kind = 'driver_license') = 3, 'three active drivers with licences';
  -- the warning window follows the school setting
  update public.schools set settings = settings || '{"document_warning_days": 5}' where id = 'a0000000-0000-4000-8000-000000000001';
  assert (select state from public.fleet_compliance where entity_id = 'a2000000-0000-4000-8000-000000000001' and kind = 'insurance') = 'valid';
  update public.schools set settings = settings - 'document_warning_days' where id = 'a0000000-0000-4000-8000-000000000001';
  -- the change is audited
  assert exists (select 1 from public.audit_log where entity = 'buses' and changes ? 'registration_expiry');
end $$;
reset role;

select tests.login(:owner_b); set role authenticated;
do $$ begin
  assert not exists (select 1 from public.fleet_compliance where school_id = 'a0000000-0000-4000-8000-000000000001'),
    'school B must not see school A documents';
end $$;
reset role;

select tests.login(:driver1); set role authenticated;
do $$ begin
  assert not exists (select 1 from public.fleet_compliance where entity_type = 'staff' and entity_id <> 'a1000000-0000-4000-8000-000000000001'),
    'a driver sees only their own licence';
end $$;
reset role;

select tests.login(:parent1); set role authenticated;
do $$ begin assert (select count(*) from public.fleet_compliance) = 0, 'parents see no fleet documents'; end $$;
reset role;

-- ---------------------------------------------------------------------
\echo '▶ fleet_live: authorization'
select tests.login(:parent1); set role authenticated;
select tests.expect_error($q$select public.fleet_live('a0000000-0000-4000-8000-000000000001')$q$, 'forbidden');
reset role;
select tests.login(:driver2); set role authenticated;
select tests.expect_error($q$select public.fleet_live('a0000000-0000-4000-8000-000000000001')$q$, 'forbidden');
reset role;
select tests.login(:owner_b); set role authenticated;
select tests.expect_error($q$select public.fleet_live('a0000000-0000-4000-8000-000000000001')$q$, 'forbidden');
do $$ begin
  assert jsonb_array_length(public.fleet_live('b0000000-0000-4000-8000-000000000001')) = 1, 'school B has one bus';
end $$;
reset role;

\echo '▶ fleet_live: active trip without GPS, then live / stale / offline'
select tests.login(:viewer_a); set role authenticated;
do $$ declare f jsonb; b jsonb; begin
  f := public.fleet_live('a0000000-0000-4000-8000-000000000001');
  assert jsonb_array_length(f) = 3, f::text;
  assert tests.bus(f, 'باص 1') -> 'trip' = 'null'::jsonb, 'bus 1 trip completed: idle';
  assert (tests.bus(f, 'باص 3') ->> 'status') = 'maintenance';
  b := tests.bus(f, 'باص 2') -> 'trip';
  assert b ->> 'gps_state' = 'none', b::text;
  assert (b ->> 'on_board')::int = 1 and (b ->> 'stops_total')::int = 2 and (b ->> 'stops_done')::int = 0, b::text;
  assert (b ->> 'emergency_active')::boolean;
  assert b -> 'next_stop' ->> 'name' = 'حديقة الملقا', b::text;
  assert b -> 'next_stop' -> 'eta_minutes' = 'null'::jsonb, 'no ETA without a live position';
end $$;
reset role;

select tests.login(:driver2); set role authenticated;
select public.push_locations(tests.trip('a5000000-0000-4000-8000-000000000003'),
  jsonb_build_array(tests.pt(24.8100, 46.6100, 2))) is not null as pushed;
reset role;

select tests.login(:owner_a); set role authenticated;
do $$ declare b jsonb; begin
  b := tests.bus(public.fleet_live('a0000000-0000-4000-8000-000000000001'), 'باص 2') -> 'trip';
  assert b ->> 'gps_state' = 'live', b::text;
  assert (b ->> 'gps_age_s')::int between 0 and 30, b::text;
  assert (b -> 'next_stop' ->> 'distance_m')::int > 1000, b::text;
  assert (b -> 'next_stop' ->> 'eta_minutes')::int >= 1, 'live position yields an ETA: ' || b::text;
  assert b -> 'next_stop' ? 'behind_schedule_min';
end $$;
reset role;

-- age the position (as the table owner) to simulate a device going quiet
update public.bus_live_positions set recorded_at = now() - interval '2 minutes'
 where trip_id = tests.trip('a5000000-0000-4000-8000-000000000003');
select tests.login(:owner_a); set role authenticated;
do $$ declare b jsonb; begin
  b := tests.bus(public.fleet_live('a0000000-0000-4000-8000-000000000001'), 'باص 2') -> 'trip';
  assert b ->> 'gps_state' = 'stale', b::text;
  assert b -> 'next_stop' -> 'eta_minutes' = 'null'::jsonb, 'no ETA from a stale position';
end $$;
reset role;
update public.bus_live_positions set recorded_at = now() - interval '20 minutes'
 where trip_id = tests.trip('a5000000-0000-4000-8000-000000000003');
select tests.login(:owner_a); set role authenticated;
do $$ begin
  assert tests.bus(public.fleet_live('a0000000-0000-4000-8000-000000000001'), 'باص 2') -> 'trip' ->> 'gps_state' = 'offline';
end $$;
reset role;

-- ---------------------------------------------------------------------
\echo '▶ GPS retention compacts only closed trips past the window'
do $$ declare v_trip uuid := tests.trip('a5000000-0000-4000-8000-000000000001');
              v_active uuid := tests.trip('a5000000-0000-4000-8000-000000000003');
              n int; s public.trip_track_summaries; begin
  assert (select count(*) from public.bus_locations where trip_id = v_trip) = 5;
  assert private.compact_bus_locations() = 0, 'today''s trips are inside the window';

  update public.trips set trip_date = trip_date - 120 where id = v_trip;
  update public.trips set trip_date = trip_date - 120 where id = v_active;  -- active: must be kept
  n := private.compact_bus_locations();
  assert n = 5, 'deleted ' || n;
  select * into s from public.trip_track_summaries where trip_id = v_trip;
  assert s.points = 5 and s.distance_m > 100 and s.first_at < s.last_at, row_to_json(s)::text;
  assert not exists (select 1 from public.trip_track_summaries where trip_id = v_active);
  assert (select count(*) from public.bus_locations where trip_id = v_active) > 0, 'active trip breadcrumbs kept';
  assert private.compact_bus_locations() = 0, 'idempotent';

  -- per-school retention setting
  update public.schools set settings = settings || '{"gps_retention_days": 365}' where id = 'a0000000-0000-4000-8000-000000000001';
  assert (private.tracking_config((select settings from public.schools where id = 'a0000000-0000-4000-8000-000000000001'))
          ->> 'gps_retention_days')::int = 365;
  update public.schools set settings = settings - 'gps_retention_days' where id = 'a0000000-0000-4000-8000-000000000001';
  update public.trips set trip_date = trip_date + 120 where id = v_active;
end $$;

select tests.login(:owner_a); set role authenticated;
do $$ begin assert (select count(*) from public.trip_track_summaries) = 1; end $$;
select tests.expect_error('select private.compact_bus_locations()', '42501');
select tests.expect_error($q$insert into public.trip_track_summaries (trip_id, school_id, points, distance_m)
  values (gen_random_uuid(), 'a0000000-0000-4000-8000-000000000001', 1, 1)$q$, '42501');
reset role;
select tests.login(:owner_b); set role authenticated;
do $$ begin assert (select count(*) from public.trip_track_summaries) = 0; end $$;
reset role;
select tests.login(:parent1); set role authenticated;
do $$ begin assert (select count(*) from public.trip_track_summaries) = 0; end $$;
reset role;

\echo '✔ fleet operations tests passed'
