-- =====================================================================
-- المرافق (المرافقة) على الباص
-- دور جديد في تطبيق الجوال: يسجّل الصعود والنزول والتسليم الآمن وفحص خلو الباص
-- والبلاغات، بينما يبقى للسائق بدء الرحلة وإنهاؤها ومشاركة الموقع.
-- «طاقم الرحلة» = سائقها + مرافقها.
-- =====================================================================

-- ---------------- الدور ----------------
alter table memberships drop constraint memberships_role_check;
alter table memberships add constraint memberships_role_check
  check (role in ('tenant_admin', 'supervisor', 'driver', 'attendant', 'parent'));
alter table invites drop constraint invites_role_check;
alter table invites add constraint invites_role_check
  check (role in ('tenant_admin', 'supervisor', 'driver', 'attendant', 'parent'));

-- ---------------- التعيين ----------------
alter table routes add column attendant_user_id uuid references users(id) on delete set null;
alter table trips add column attendant_user_id uuid references users(id) on delete set null;
create index on trips (attendant_user_id, service_date);

-- ---------------- دوال الطاقم ----------------
create or replace function app.is_crew() returns boolean language sql stable as $$
  select app.cur_role() in ('driver', 'attendant')
$$;
grant execute on function app.is_crew() to busna_app, busna_auth, busna_worker;

-- كل دالة تطابق العمود المناسب لدور السياق الحالي فقط (سائق ← driver_user_id، مرافق ← attendant_user_id)
create or replace function app.driver_owns_trip(p_trip uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from trips t
                 where t.id = p_trip and t.tenant_id = app.cur_tenant()
                   and ((app.cur_role() = 'driver' and t.driver_user_id = app.cur_user())
                     or (app.cur_role() = 'attendant' and t.attendant_user_id = app.cur_user())))
$$;

create or replace function app.driver_has_student(p_student uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from trip_riders tr join trips t on t.id = tr.trip_id
                 where tr.student_id = p_student and t.tenant_id = app.cur_tenant()
                   and ((app.cur_role() = 'driver' and t.driver_user_id = app.cur_user())
                     or (app.cur_role() = 'attendant' and t.attendant_user_id = app.cur_user()))
                   and t.service_date between current_date - 1 and current_date + 7)
$$;

create or replace function app.driver_has_route(p_route uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from routes r where r.id = p_route and r.tenant_id = app.cur_tenant()
                   and ((app.cur_role() = 'driver' and r.driver_user_id = app.cur_user())
                     or (app.cur_role() = 'attendant' and r.attendant_user_id = app.cur_user())))
      or exists (select 1 from trips t where t.route_id = p_route and t.tenant_id = app.cur_tenant()
                   and ((app.cur_role() = 'driver' and t.driver_user_id = app.cur_user())
                     or (app.cur_role() = 'attendant' and t.attendant_user_id = app.cur_user())))
$$;

-- ---------------- السياسات: الطاقم بدل السائق فقط ----------------
drop policy students_select on students;
create policy students_select on students for select to busna_app
  using (tenant_id = app.cur_tenant() and (
    app.is_staff()
    or (app.cur_role() = 'parent' and app.is_guardian_of(id))
    or (app.is_crew() and app.driver_has_student(id))));

drop policy buses_select on buses;
create policy buses_select on buses for select to busna_app
  using (tenant_id = app.cur_tenant() and app.cur_role() in ('tenant_admin', 'supervisor', 'driver', 'attendant', 'parent', 'platform_readonly'));

drop policy routes_select on routes;
create policy routes_select on routes for select to busna_app
  using (tenant_id = app.cur_tenant() and (
    app.is_staff()
    or (app.is_crew() and app.driver_has_route(id))
    or (app.cur_role() = 'parent' and app.parent_has_route(id))));

drop policy stops_select on route_stops;
create policy stops_select on route_stops for select to busna_app
  using (tenant_id = app.cur_tenant() and (
    app.is_staff()
    or (app.is_crew() and app.driver_has_route(route_id))
    or (app.cur_role() = 'parent' and (kind = 'school' or app.parent_has_stop(id)))));

drop policy rr_select on route_riders;
create policy rr_select on route_riders for select to busna_app
  using (tenant_id = app.cur_tenant() and (
    app.is_staff()
    or (app.is_crew() and app.driver_has_route(route_id))
    or (app.cur_role() = 'parent' and app.is_guardian_of(student_id))));

drop policy schedules_select on schedules;
create policy schedules_select on schedules for select to busna_app
  using (tenant_id = app.cur_tenant() and (app.is_staff() or (app.is_crew() and app.driver_has_route(route_id))));

drop policy trips_select on trips;
create policy trips_select on trips for select to busna_app
  using (tenant_id = app.cur_tenant() and (
    app.is_staff()
    or (app.is_crew() and app.driver_owns_trip(id))
    or (app.cur_role() = 'parent' and app.parent_can_see_trip(id))));

-- المرافق يحتاج صلاحية تحديث لقفل صف الرحلة وتسجيل نتيجة الفحص فقط؛
-- المحفّز trips_guard يمنعه من أي تغيير آخر.
drop policy trips_update on trips;
create policy trips_update on trips for update to busna_app
  using (tenant_id = app.cur_tenant() and (app.is_staff() or (app.is_crew() and app.driver_owns_trip(id))))
  with check (tenant_id = app.cur_tenant() and (app.is_staff() or (app.is_crew() and app.driver_owns_trip(id))));

drop policy tr_select on trip_riders;
create policy tr_select on trip_riders for select to busna_app
  using (tenant_id = app.cur_tenant() and (
    app.is_staff()
    or (app.is_crew() and app.driver_owns_trip(trip_id))
    or (app.cur_role() = 'parent' and app.is_guardian_of(student_id))));

drop policy tr_update on trip_riders;
create policy tr_update on trip_riders for update to busna_app
  using (tenant_id = app.cur_tenant() and (app.is_staff()
    or (app.is_crew() and app.driver_owns_trip(trip_id) and app.trip_in_progress(trip_id))))
  with check (tenant_id = app.cur_tenant() and (app.is_staff()
    or (app.is_crew() and app.driver_owns_trip(trip_id) and app.trip_in_progress(trip_id))));

drop policy be_select on boarding_events;
create policy be_select on boarding_events for select to busna_app
  using (tenant_id = app.cur_tenant() and (
    app.is_staff()
    or (app.is_crew() and app.driver_owns_trip(trip_id))
    or (app.cur_role() = 'parent' and app.is_guardian_of(student_id))));

drop policy be_insert on boarding_events;
create policy be_insert on boarding_events for insert to busna_app
  with check (tenant_id = app.cur_tenant() and recorded_by = app.cur_user() and (
    (app.is_staff())
    or (app.is_crew() and type <> 'correction'
        and app.driver_owns_trip(trip_id) and app.trip_in_progress(trip_id))));

-- الموقع: يراه الطاقم، ويرسله السائق فقط
drop policy loc_select on bus_locations;
create policy loc_select on bus_locations for select to busna_app
  using (tenant_id = app.cur_tenant() and (
    app.is_staff()
    or (app.is_crew() and app.driver_owns_trip(trip_id))
    or (app.cur_role() = 'parent' and app.parent_can_see_trip(trip_id) and app.trip_in_progress(trip_id))));

-- فحص خلو الباص: يجريه أحد أفراد الطاقم (عمود driver_user_id = من أجرى الفحص)
drop policy insp_select on trip_inspections;
create policy insp_select on trip_inspections for select to busna_app
  using (tenant_id = app.cur_tenant() and (app.is_staff() or (app.is_crew() and app.driver_owns_trip(trip_id))));
drop policy insp_insert on trip_inspections;
create policy insp_insert on trip_inspections for insert to busna_app
  with check (tenant_id = app.cur_tenant() and app.is_crew()
    and driver_user_id = app.cur_user() and app.driver_owns_trip(trip_id));

drop policy alerts_select on safety_alerts;
create policy alerts_select on safety_alerts for select to busna_app
  using (tenant_id = app.cur_tenant() and (app.is_staff()
    or (app.is_crew() and created_by = app.cur_user())));
drop policy alerts_insert on safety_alerts;
create policy alerts_insert on safety_alerts for insert to busna_app
  with check (tenant_id = app.cur_tenant() and (app.is_staff()
    or (app.is_crew() and created_by = app.cur_user()
        and (trip_id is null or app.driver_owns_trip(trip_id)))));

-- المشرف يدعو أولياء الأمور والسائقين والمرافقين
drop policy invites_insert on invites;
create policy invites_insert on invites for insert to busna_app
  with check (
    (tenant_id = app.cur_tenant() and app.cur_role() = 'tenant_admin')
    or (tenant_id = app.cur_tenant() and app.cur_role() = 'supervisor' and role in ('parent', 'driver', 'attendant'))
    or (app.cur_role() = 'platform_admin' and role = 'tenant_admin'));

drop policy tickets_insert on support_tickets;
create policy tickets_insert on support_tickets for insert to busna_app
  with check (tenant_id = app.cur_tenant() and requester_user_id = app.cur_user() and status = 'open'
              and app.cur_role() in ('tenant_admin', 'supervisor', 'driver', 'attendant', 'parent'));

-- ---------------- حماية الرحلة: ما يستطيع كل فرد في الطاقم تعديله ----------------
create or replace function app.trips_guard() returns trigger language plpgsql as $$
begin
  if old.status in ('completed', 'cancelled') and new.status <> old.status then
    raise exception 'trip_terminal_state' using errcode = 'P0001';
  end if;
  if old.status = 'in_progress' and new.status = 'scheduled' then
    raise exception 'invalid_trip_transition' using errcode = 'P0001';
  end if;
  if app.cur_role() = 'driver' then
    if new.route_id is distinct from old.route_id or new.driver_user_id is distinct from old.driver_user_id
       or new.attendant_user_id is distinct from old.attendant_user_id
       or new.bus_id is distinct from old.bus_id or new.service_date is distinct from old.service_date
       or new.direction is distinct from old.direction or new.tenant_id is distinct from old.tenant_id
       or new.planned_start is distinct from old.planned_start or new.schedule_id is distinct from old.schedule_id then
      raise exception 'driver_cannot_modify_trip_plan' using errcode = 'P0001';
    end if;
    if new.status <> old.status and not (
        (old.status = 'scheduled' and new.status = 'in_progress') or
        (old.status = 'in_progress' and new.status = 'completed')) then
      raise exception 'invalid_trip_transition' using errcode = 'P0001';
    end if;
  elsif app.cur_role() = 'attendant' then
    -- المرافق لا يبدأ الرحلة ولا ينهيها ولا يغيّر خطتها؛ يسجّل نتيجة فحص خلو الباص فقط
    if (to_jsonb(new) - 'inspection_status' - 'updated_at') <> (to_jsonb(old) - 'inspection_status' - 'updated_at') then
      raise exception 'attendant_cannot_modify_trip' using errcode = 'P0001';
    end if;
    if new.inspection_status is distinct from old.inspection_status
       and not (old.inspection_status = 'pending' and new.inspection_status in ('completed', 'issue_reported')) then
      raise exception 'attendant_cannot_modify_trip' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

-- قائمة المستلمين: لطاقم الرحلة أو للإدارة
create or replace function app.trip_receivers(p_trip uuid)
returns table (student_id uuid, kind text, ref_id uuid, full_name text, relationship text)
language sql stable security definer set search_path = public, pg_temp as $$
  with allowed as (
    select t.id from trips t
    where t.id = p_trip and t.tenant_id = app.cur_tenant()
      and (app.is_staff()
           or (app.cur_role() = 'driver' and t.driver_user_id = app.cur_user())
           or (app.cur_role() = 'attendant' and t.attendant_user_id = app.cur_user()))
  )
  select tr.student_id, 'guardian'::text, u.id, u.full_name, gs.relationship
  from allowed a join trip_riders tr on tr.trip_id = a.id
  join students s on s.id = tr.student_id and s.requires_handover
  join guardian_students gs on gs.student_id = tr.student_id and gs.tenant_id = app.cur_tenant()
  join users u on u.id = gs.guardian_user_id
  join memberships m on m.user_id = u.id and m.tenant_id = gs.tenant_id and m.role = 'parent' and m.status = 'active'
  union all
  select tr.student_id, 'authorized'::text, p.id, p.full_name, p.relationship
  from allowed a join trip_riders tr on tr.trip_id = a.id
  join students s on s.id = tr.student_id and s.requires_handover
  join authorized_pickups p on p.student_id = tr.student_id and p.status = 'active' and p.tenant_id = app.cur_tenant()
$$;

-- أسماء طاقم الرحلة وهواتفهم (للتنسيق بين السائق والمرافق) — لطاقم الرحلة أو الإدارة فقط
create or replace function app.trip_crew(p_trip uuid)
returns table (driver_name text, driver_phone text, attendant_name text, attendant_phone text)
language sql stable security definer set search_path = public, pg_temp as $$
  select d.full_name, d.phone, a.full_name, a.phone
  from trips t left join users d on d.id = t.driver_user_id left join users a on a.id = t.attendant_user_id
  where t.id = p_trip and t.tenant_id = app.cur_tenant()
    and (app.is_staff()
         or (app.cur_role() = 'driver' and t.driver_user_id = app.cur_user())
         or (app.cur_role() = 'attendant' and t.attendant_user_id = app.cur_user()))
$$;
revoke all on function app.trip_crew(uuid) from public;
grant execute on function app.trip_crew(uuid) to busna_app;
