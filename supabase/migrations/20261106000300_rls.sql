-- =====================================================================
-- Busna — Row Level Security
--
-- Roles (per school):
--   owner / admin  : full management of their school's data
--   viewer         : read-only dashboard access
--   driver         : own trips, attendance, location publishing
--   supervisor     : own trips, attendance, notes, contact guardians
--   parent         : own children only; bus location ONLY while a child
--                    is on board during an active trip
--
-- All trip state changes (start, attendance, arrival, end, locations,
-- incidents) go through SECURITY DEFINER RPCs (see 0400). Clients have
-- no direct write access to those tables.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Role-scoped helper sets
-- ---------------------------------------------------------------------
create or replace function private.owner_school_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select school_id from public.school_members where user_id = (select auth.uid()) and role = 'owner'
$$;

create or replace function private.staff_trip_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select t.id from public.trips t
   where t.driver_id in (select id from public.staff where user_id = (select auth.uid()) and status = 'active')
      or t.supervisor_id in (select id from public.staff where user_id = (select auth.uid()) and status = 'active')
$$;

create or replace function private.staff_route_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select r.id from public.routes r
   where r.driver_id in (select id from public.staff where user_id = (select auth.uid()) and status = 'active')
      or r.supervisor_id in (select id from public.staff where user_id = (select auth.uid()) and status = 'active')
$$;

create or replace function private.staff_bus_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select b.id from public.buses b
   where b.default_driver_id in (select id from public.staff where user_id = (select auth.uid()) and status = 'active')
      or b.default_supervisor_id in (select id from public.staff where user_id = (select auth.uid()) and status = 'active')
  union
  select bus_id from public.trips where bus_id is not null and id in (select private.staff_trip_ids())
  union
  select bus_id from public.routes where bus_id is not null and id in (select private.staff_route_ids())
$$;

create or replace function private.staff_student_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select student_id from public.route_students where route_id in (select private.staff_route_ids())
  union
  select student_id from public.trip_students where trip_id in (select private.staff_trip_ids())
$$;

create or replace function private.my_student_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select sg.student_id from public.student_guardians sg
   where sg.guardian_id in (select private.my_guardian_ids())
$$;

create or replace function private.parent_trip_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select ts.trip_id from public.trip_students ts
   where ts.student_id in (select private.my_student_ids())
$$;

-- Earliest boarding time of one of the caller's trackable children on an
-- ACTIVE trip, or NULL when the caller may not see the bus location.
create or replace function private.parent_track_since(p_trip uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select min(ts.boarded_at)
    from public.trip_students ts
    join public.trips t on t.id = ts.trip_id
    join public.student_guardians sg on sg.student_id = ts.student_id and sg.can_track
    join public.guardians g on g.id = sg.guardian_id
   where ts.trip_id = p_trip
     and ts.status = 'boarded'
     and t.status in ('started', 'in_progress')
     and g.user_id = (select auth.uid())
     and g.status = 'active'
$$;

create or replace function private.parent_can_track(p_trip uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.parent_track_since(p_trip) is not null
$$;

grant execute on all functions in schema private to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Baseline privileges: anon gets nothing; authenticated is narrowed by RLS
-- ---------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

do $$
declare t text;
begin
  foreach t in array array[
    'schools','platform_admins','profiles','school_members','staff','guardians',
    'buses','students','student_guardians','routes','route_stops','route_students',
    'trips','trip_stops','trip_students','trip_events','bus_live_positions','bus_locations',
    'notifications','incidents','parent_requests','audit_log','ai_action_proposals']
  loop
    -- Not FORCE: SECURITY DEFINER helpers run as the table owner and must
    -- bypass RLS to evaluate membership without recursion.
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- Tables written exclusively through RPCs / triggers.
revoke insert, update, delete on public.trips, public.trip_stops, public.trip_students,
  public.trip_events, public.bus_live_positions, public.bus_locations, public.audit_log,
  public.platform_admins, public.incidents
  from authenticated;
revoke insert, delete on public.notifications from authenticated;
revoke update on public.notifications from authenticated;
grant update (read_at) on public.notifications to authenticated;

-- Admins may brand their school, but not change slug/status (platform only).
revoke insert, update, delete on public.schools from authenticated;
grant update (name, name_en, logo_url, primary_color, accent_color, city, address, lat, lng, settings, timezone)
  on public.schools to authenticated;

-- ---------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------

-- schools
create policy schools_select on public.schools for select to authenticated
  using (id in (select private.affiliated_school_ids()) or (select private.is_platform_admin()));
create policy schools_update on public.schools for update to authenticated
  using (id in (select private.admin_school_ids()))
  with check (id in (select private.admin_school_ids()));

-- platform_admins
create policy platform_admins_self on public.platform_admins for select to authenticated
  using (user_id = (select auth.uid()));

-- profiles
create policy profiles_self_select on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy profiles_self_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy profiles_self_insert on public.profiles for insert to authenticated
  with check (id = (select auth.uid()));

-- school_members
create policy members_select on public.school_members for select to authenticated
  using (school_id in (select private.member_school_ids()) or user_id = (select auth.uid()));
create policy members_owner_write on public.school_members for all to authenticated
  using (school_id in (select private.owner_school_ids()))
  with check (school_id in (select private.owner_school_ids()));

-- staff
create policy staff_select on public.staff for select to authenticated
  using (school_id in (select private.member_school_ids()) or user_id = (select auth.uid()));
create policy staff_admin_write on public.staff for all to authenticated
  using (school_id in (select private.admin_school_ids()))
  with check (school_id in (select private.admin_school_ids()));

-- guardians
create policy guardians_select on public.guardians for select to authenticated
  using (school_id in (select private.member_school_ids()) or user_id = (select auth.uid()));
create policy guardians_admin_write on public.guardians for all to authenticated
  using (school_id in (select private.admin_school_ids()))
  with check (school_id in (select private.admin_school_ids()));

-- buses
create policy buses_select on public.buses for select to authenticated
  using (school_id in (select private.member_school_ids()) or id in (select private.staff_bus_ids()));
create policy buses_admin_write on public.buses for all to authenticated
  using (school_id in (select private.admin_school_ids()))
  with check (school_id in (select private.admin_school_ids()));

-- students
create policy students_select on public.students for select to authenticated
  using (school_id in (select private.member_school_ids())
         or id in (select private.my_student_ids())
         or id in (select private.staff_student_ids()));
create policy students_admin_write on public.students for all to authenticated
  using (school_id in (select private.admin_school_ids()))
  with check (school_id in (select private.admin_school_ids()));

-- student_guardians
create policy student_guardians_select on public.student_guardians for select to authenticated
  using (school_id in (select private.member_school_ids()) or guardian_id in (select private.my_guardian_ids()));
create policy student_guardians_admin_write on public.student_guardians for all to authenticated
  using (school_id in (select private.admin_school_ids()))
  with check (school_id in (select private.admin_school_ids()));

-- routes / stops / route students
create policy routes_select on public.routes for select to authenticated
  using (school_id in (select private.member_school_ids()) or id in (select private.staff_route_ids()));
create policy routes_admin_write on public.routes for all to authenticated
  using (school_id in (select private.admin_school_ids()))
  with check (school_id in (select private.admin_school_ids()));

create policy route_stops_select on public.route_stops for select to authenticated
  using (school_id in (select private.member_school_ids()) or route_id in (select private.staff_route_ids()));
create policy route_stops_admin_write on public.route_stops for all to authenticated
  using (school_id in (select private.admin_school_ids()))
  with check (school_id in (select private.admin_school_ids()));

create policy route_students_select on public.route_students for select to authenticated
  using (school_id in (select private.member_school_ids()) or route_id in (select private.staff_route_ids()));
create policy route_students_admin_write on public.route_students for all to authenticated
  using (school_id in (select private.admin_school_ids()))
  with check (school_id in (select private.admin_school_ids()));

-- trips (read-only for clients)
create policy trips_select on public.trips for select to authenticated
  using (school_id in (select private.member_school_ids())
         or id in (select private.staff_trip_ids())
         or id in (select private.parent_trip_ids()));

-- trip stops: parents excluded on purpose (other children's pickup points)
create policy trip_stops_select on public.trip_stops for select to authenticated
  using (school_id in (select private.member_school_ids()) or trip_id in (select private.staff_trip_ids()));

-- trip students: parents only see their own children's rows
create policy trip_students_select on public.trip_students for select to authenticated
  using (school_id in (select private.member_school_ids())
         or trip_id in (select private.staff_trip_ids())
         or student_id in (select private.my_student_ids()));

create policy trip_events_select on public.trip_events for select to authenticated
  using (school_id in (select private.member_school_ids()) or trip_id in (select private.staff_trip_ids()));

-- Live position: staff of the trip, school dashboard, and eligible parents.
create policy live_positions_select on public.bus_live_positions for select to authenticated
  using (school_id in (select private.member_school_ids())
         or trip_id in (select private.staff_trip_ids())
         or private.parent_can_track(trip_id));

-- Breadcrumbs: parents only from the moment their own child boarded.
create policy bus_locations_select on public.bus_locations for select to authenticated
  using (school_id in (select private.member_school_ids())
         or trip_id in (select private.staff_trip_ids())
         or recorded_at >= private.parent_track_since(trip_id));

-- notifications
create policy notifications_select on public.notifications for select to authenticated
  using (recipient_user_id = (select auth.uid())
         or guardian_id in (select private.my_guardian_ids())
         or school_id in (select private.member_school_ids()));
create policy notifications_mark_read on public.notifications for update to authenticated
  using (recipient_user_id = (select auth.uid()) or guardian_id in (select private.my_guardian_ids()))
  with check (recipient_user_id = (select auth.uid()) or guardian_id in (select private.my_guardian_ids()));

-- incidents
create policy incidents_select on public.incidents for select to authenticated
  using (school_id in (select private.member_school_ids())
         or reported_by = (select auth.uid())
         or trip_id in (select private.staff_trip_ids()));
grant update (status, resolution, resolved_by, resolved_at) on public.incidents to authenticated;
create policy incidents_admin_update on public.incidents for update to authenticated
  using (school_id in (select private.admin_school_ids()))
  with check (school_id in (select private.admin_school_ids()));

-- parent requests
create policy parent_requests_select on public.parent_requests for select to authenticated
  using (school_id in (select private.member_school_ids()) or guardian_id in (select private.my_guardian_ids()));
create policy parent_requests_insert on public.parent_requests for insert to authenticated
  with check (guardian_id in (select private.my_guardian_ids())
              and (student_id is null or student_id in (select private.my_student_ids()))
              and status = 'open' and handled_by is null and response is null);
create policy parent_requests_admin_update on public.parent_requests for update to authenticated
  using (school_id in (select private.admin_school_ids()))
  with check (school_id in (select private.admin_school_ids()));

-- audit log (admins read)
create policy audit_log_select on public.audit_log for select to authenticated
  using (school_id in (select private.admin_school_ids()));

-- AI proposals: created by admins, decided via RPC
create policy ai_proposals_select on public.ai_action_proposals for select to authenticated
  using (school_id in (select private.member_school_ids()));
revoke update, delete on public.ai_action_proposals from authenticated;
create policy ai_proposals_insert on public.ai_action_proposals for insert to authenticated
  with check (school_id in (select private.admin_school_ids())
              and created_by = (select auth.uid()) and status = 'pending');
