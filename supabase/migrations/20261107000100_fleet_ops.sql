-- =====================================================================
-- Busna — Fleet operations (Phase 1 gap closure)
--
--   1. Vehicle document expiry (registration / insurance / periodic
--      inspection) + a compliance read model incl. driver licences.
--   2. Bounded tracking settings (GPS interval, freshness thresholds,
--      retention) read from schools.settings with server-side clamping,
--      because settings is admin-editable free-form JSON.
--   3. fleet_live(): one call returns every bus with its active trip,
--      three-state GPS freshness (live / stale / offline), stop progress,
--      next stop ETA and schedule deviation — computed in the database so
--      the dashboard does not fan out N queries per bus.
--   4. GPS retention: breadcrumbs of closed trips older than the school's
--      retention window are summarised then deleted (PDPL data
--      minimisation + bounded table growth).
--
-- Purely additive: no existing column, function or policy is changed.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Vehicle documents
-- ---------------------------------------------------------------------
alter table public.buses
  add column registration_expiry date,   -- استمارة المركبة
  add column insurance_expiry    date,   -- التأمين
  add column inspection_expiry   date;   -- الفحص الدوري

-- ---------------------------------------------------------------------
-- 2. Bounded settings
-- ---------------------------------------------------------------------
-- Integer setting from a settings document, clamped to [p_min, p_max].
-- Non-numeric / absurd values fall back to the default.
create or replace function private.setting_int(p_settings jsonb, p_key text, p_default int, p_min int, p_max int)
returns int language sql immutable as $$
  select least(greatest(
    coalesce(case when (p_settings ->> p_key) ~ '^[0-9]{1,6}$' then (p_settings ->> p_key)::int end, p_default),
    p_min), p_max)
$$;

-- Effective tracking configuration for a school. Drivers' devices and the
-- dashboard read the same numbers.
create or replace function private.tracking_config(p_settings jsonb)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'gps_interval_s',        private.setting_int(p_settings, 'gps_interval_s', 10, 5, 120),
    'gps_heartbeat_s',       private.setting_int(p_settings, 'gps_heartbeat_s', 30, 15, 300),
    'gps_stale_after_s',     private.setting_int(p_settings, 'gps_stale_after_s', 60, 20, 900),
    'gps_offline_after_s',   private.setting_int(p_settings, 'gps_offline_after_s', 300, 60, 3600),
    'gps_retention_days',    private.setting_int(p_settings, 'gps_retention_days', 90, 7, 730),
    'document_warning_days', private.setting_int(p_settings, 'document_warning_days', 30, 1, 180)
  )
$$;

-- Freshness of a position: none | live | stale | offline.
create or replace function private.gps_state(p_recorded_at timestamptz, p_cfg jsonb)
returns text language sql stable as $$
  select case
    when p_recorded_at is null then 'none'
    when now() - p_recorded_at <= make_interval(secs => (p_cfg ->> 'gps_stale_after_s')::int) then 'live'
    when now() - p_recorded_at <= make_interval(secs => greatest((p_cfg ->> 'gps_offline_after_s')::int,
                                                                 (p_cfg ->> 'gps_stale_after_s')::int)) then 'stale'
    else 'offline'
  end
$$;

-- Tracking config for any school the caller is affiliated with (staff need
-- it on the driver device; parents do not, but it holds nothing sensitive).
create or replace function public.tracking_config(p_school uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  if p_school not in (select private.affiliated_school_ids()) and not private.is_platform_admin() then
    perform private.fail('forbidden', 'غير مصرح');
  end if;
  select private.tracking_config(settings) into v from public.schools where id = p_school;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- 1b. Compliance read model (security_invoker => caller's RLS applies:
--     members see their school, a driver sees only buses they operate
--     and their own licence).
-- ---------------------------------------------------------------------
create view public.fleet_compliance with (security_invoker = true) as
with docs as (
  select b.school_id, 'bus'::text as entity_type, b.id as entity_id, b.code as label, d.kind, d.expires_on
    from public.buses b
   cross join lateral (values ('registration', b.registration_expiry),
                              ('insurance', b.insurance_expiry),
                              ('inspection', b.inspection_expiry)) as d(kind, expires_on)
   where d.expires_on is not null
  union all
  select st.school_id, 'staff', st.id, st.full_name, 'driver_license', st.license_expiry
    from public.staff st
   where st.role = 'driver' and st.status = 'active' and st.license_expiry is not null
)
select d.school_id, d.entity_type, d.entity_id, d.label, d.kind, d.expires_on,
       (d.expires_on - (now() at time zone s.timezone)::date) as days_left,
       case when d.expires_on < (now() at time zone s.timezone)::date then 'expired'
            when d.expires_on - (now() at time zone s.timezone)::date
                 <= (private.tracking_config(s.settings) ->> 'document_warning_days')::int then 'expiring'
            else 'valid' end as state
  from docs d
  join public.schools s on s.id = d.school_id;
grant select on public.fleet_compliance to authenticated;

-- ---------------------------------------------------------------------
-- 3. Live fleet read model
-- ---------------------------------------------------------------------
-- Recent average speed (m/s) of a trip, floored at ~20 km/h for city traffic.
create or replace function private.recent_speed(p_trip uuid)
returns double precision language sql stable security definer set search_path = '' as $$
  select greatest(coalesce((select avg(speed) from (
           select speed from public.bus_locations
            where trip_id = p_trip and speed is not null
            order by recorded_at desc limit 20) x), 0), 5.5)
$$;

create or replace function public.fleet_live(p_school uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_cfg jsonb;
  v_late int;
begin
  if not exists (select 1 from public.school_members where school_id = p_school and user_id = auth.uid())
     and not private.is_platform_admin() then
    perform private.fail('forbidden', 'لا تملك صلاحية الاطلاع على بيانات هذه المدرسة');
  end if;
  select private.tracking_config(settings), coalesce((settings ->> 'late_threshold_min')::int, 10)
    into v_cfg, v_late from public.schools where id = p_school;

  return coalesce((
    select jsonb_agg(x.row order by x.code)
      from (
        select b.code, jsonb_build_object(
          'bus_id', b.id, 'code', b.code, 'plate_number', b.plate_number, 'status', b.status,
          'capacity', b.capacity, 'gps_source', b.gps_source,
          'trip', case when t.id is null then null else jsonb_build_object(
            'trip_id', t.id, 'name', t.name, 'period', t.period, 'status', t.status,
            'started_at', t.started_at, 'arrived_at', t.arrived_at,
            'driver_name', d.full_name, 'supervisor_name', sv.full_name,
            'delay_minutes', t.delay_minutes, 'emergency_active', t.emergency_active,
            'expected', a.expected, 'on_board', a.on_board, 'dropped', a.dropped, 'absent', a.absent,
            'stops_total', sp.total, 'stops_done', sp.done,
            'gps_state', private.gps_state(p.recorded_at, v_cfg),
            'gps_age_s', case when p.recorded_at is null then null
                              else greatest(floor(extract(epoch from now() - p.recorded_at)), 0)::int end,
            'position', case when p.trip_id is null then null else jsonb_build_object(
              'lat', p.lat, 'lng', p.lng, 'heading', p.heading, 'speed', p.speed, 'recorded_at', p.recorded_at) end,
            'next_stop', case when ns.id is null then null else jsonb_build_object(
              'name', ns.name, 'seq', ns.seq, 'planned_at', ns.planned_at,
              'distance_m', round(ns.dist::numeric),
              -- ETA only from a live position; it is an estimate, never a promise.
              'eta_minutes', ns.eta,
              -- Positive = projected behind the planned time at the next stop.
              'behind_schedule_min', case when ns.eta is null or ns.planned_at is null then null
                else floor(extract(epoch from (now() + make_interval(mins => ns.eta)) - ns.planned_at) / 60)::int end) end,
            'late_threshold_min', v_late
          ) end
        ) as row
          from public.buses b
          -- active trip of this bus (no date filter: a trip left open past
          -- midnight must still be visible)
          left join lateral (
            select * from public.trips tt
             where tt.bus_id = b.id and tt.status in ('started', 'in_progress')
             order by tt.started_at desc nulls last limit 1) t on true
          left join public.bus_live_positions p on p.trip_id = t.id
          left join public.staff d  on d.id  = t.driver_id
          left join public.staff sv on sv.id = t.supervisor_id
          left join lateral (
            select count(*) filter (where status <> 'absent')::int as expected,
                   count(*) filter (where status = 'boarded')::int as on_board,
                   count(*) filter (where status = 'dropped')::int as dropped,
                   count(*) filter (where status = 'absent')::int as absent
              from public.trip_students where trip_id = t.id) a on t.id is not null
          left join lateral (
            select count(*)::int as total, count(arrived_at)::int as done
              from public.trip_stops where trip_id = t.id) sp on t.id is not null
          left join lateral (
            select st.id, st.name, st.seq, st.planned_at, z.dist,
                   case when z.dist is null or private.gps_state(p.recorded_at, v_cfg) <> 'live' then null
                        else ceil(z.dist * 1.3 / private.recent_speed(t.id) / 60.0)::int end as eta
              from public.trip_stops st
             cross join lateral (select public.distance_m(p.lat, p.lng, st.lat, st.lng) as dist) z
             where st.trip_id = t.id and st.arrived_at is null
             order by st.seq limit 1) ns on t.id is not null
         where b.school_id = p_school
      ) x
  ), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- 4. GPS retention
-- ---------------------------------------------------------------------
create table public.trip_track_summaries (
  trip_id      uuid primary key,
  school_id    uuid not null,
  points       int not null,
  distance_m   double precision not null,
  first_at     timestamptz,
  last_at      timestamptz,
  compacted_at timestamptz not null default now(),
  foreign key (trip_id, school_id) references public.trips (id, school_id) on delete cascade
);
create index trip_track_summaries_school_idx on public.trip_track_summaries (school_id);
alter table public.trip_track_summaries enable row level security;
revoke insert, update, delete on public.trip_track_summaries from authenticated;
revoke all on public.trip_track_summaries from anon;
create policy trip_track_summaries_select on public.trip_track_summaries for select to authenticated
  using (school_id in (select private.member_school_ids()));

-- Summarises and deletes breadcrumbs of CLOSED trips older than each
-- school's gps_retention_days. Processes at most p_max_trips per call so a
-- backlog never becomes one huge transaction; idempotent.
create or replace function private.compact_bus_locations(p_max_trips int default 500)
returns int language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_deleted int := 0;
  n int;
begin
  for r in
    select t.id, t.school_id
      from public.trips t
      join public.schools s on s.id = t.school_id
     where t.status in ('completed', 'cancelled')
       and t.trip_date < (now() at time zone s.timezone)::date
                         - (private.tracking_config(s.settings) ->> 'gps_retention_days')::int
       and exists (select 1 from public.bus_locations bl where bl.trip_id = t.id)
     order by t.trip_date
     limit greatest(p_max_trips, 1)
  loop
    insert into public.trip_track_summaries (trip_id, school_id, points, distance_m, first_at, last_at)
    select r.id, r.school_id, count(*)::int, coalesce(sum(seg), 0), min(recorded_at), max(recorded_at)
      from (select recorded_at,
                   public.distance_m(lag(lat) over w, lag(lng) over w, lat, lng) as seg
              from public.bus_locations where trip_id = r.id
            window w as (order by recorded_at)) x
    on conflict (trip_id) do update set
      points = public.trip_track_summaries.points + excluded.points,
      distance_m = public.trip_track_summaries.distance_m + excluded.distance_m,
      first_at = least(public.trip_track_summaries.first_at, excluded.first_at),
      last_at = greatest(public.trip_track_summaries.last_at, excluded.last_at),
      compacted_at = now();
    delete from public.bus_locations where trip_id = r.id;
    get diagnostics n = row_count;
    v_deleted := v_deleted + n;
  end loop;
  return v_deleted;
end $$;
revoke execute on function private.compact_bus_locations(int) from public, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('busna-compact-gps', '17 23 * * *', 'select private.compact_bus_locations(2000)');
  else
    raise notice 'pg_cron not installed: schedule private.compact_bus_locations() externally';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke execute on function public.fleet_live(uuid), public.tracking_config(uuid) from public, anon;
grant execute on function public.fleet_live(uuid), public.tracking_config(uuid) to authenticated, service_role;
grant execute on function private.setting_int(jsonb, text, int, int, int), private.tracking_config(jsonb),
  private.gps_state(timestamptz, jsonb), private.recent_speed(uuid) to authenticated, service_role;
