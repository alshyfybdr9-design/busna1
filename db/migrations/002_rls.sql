-- =====================================================================
-- سياسات Row Level Security والصلاحيات
-- القاعدة: لا يرى busna_app إلا صفوف الجهة الحالية (app.tenant_id)،
-- ثم تُقيَّد أكثر بحسب الدور: ولي الأمر يرى أبناءه فقط، والسائق رحلاته فقط.
-- =====================================================================

do $$
declare t text;
begin
  foreach t in array array['tenants','users','memberships','invites','refresh_tokens','students',
    'guardian_students','buses','routes','route_stops','route_riders','schedules','trips','trip_riders',
    'boarding_events','absences','bus_locations','trip_inspections','safety_alerts','outbox_events',
    'notifications','push_tokens','audit_logs']
  loop
    -- بدون FORCE: مالك الجداول (الترحيلات ودوال SECURITY DEFINER) يتجاوز RLS،
    -- أما busna_app/busna_auth/busna_worker فيخضعون لها دائمًا.
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- ---------------- الصلاحيات على مستوى الجداول ----------------
grant usage on schema public to busna_app, busna_auth, busna_worker;

-- busna_app: لا يقرأ password_hash ولا يعدّل حقول الأمان في users.
grant select (id, email, phone, full_name, locale, is_platform_admin, status, created_at) on users to busna_app;
grant update (full_name, locale) on users to busna_app;
grant select, insert, update on tenants to busna_app;
grant select, insert, update on memberships to busna_app;
grant select, insert, update on invites to busna_app;
grant select, insert, update, delete on students, guardian_students, buses, routes, route_stops,
  route_riders, schedules to busna_app;
grant select, insert, update, delete on trips, trip_riders to busna_app;
grant select, insert on boarding_events, bus_locations to busna_app;
grant select, insert, update on absences, trip_inspections, safety_alerts to busna_app;
grant insert on outbox_events to busna_app;
grant usage on sequence outbox_events_id_seq, bus_locations_id_seq, audit_logs_id_seq to busna_app;
grant select, update (read_at) on notifications to busna_app;
grant select, insert, update, delete on push_tokens to busna_app;
grant select, insert on audit_logs to busna_app;

-- busna_auth: وحدة المصادقة فقط
grant select, insert, update on users, refresh_tokens, invites, memberships to busna_auth;
grant select on tenants, students to busna_auth;
grant select, insert on guardian_students to busna_auth;
grant insert on audit_logs to busna_auth;
grant usage on sequence audit_logs_id_seq to busna_auth;

-- busna_worker: المهام الخلفية
grant select, insert, update on outbox_events to busna_worker;
grant usage on sequence outbox_events_id_seq to busna_worker;
grant select on absences to busna_worker;
grant select, insert, update on notifications, safety_alerts to busna_worker;
grant select, update on push_tokens to busna_worker;
grant delete on push_tokens to busna_worker;
grant select on tenants, users, memberships, guardian_students, students, trips, trip_riders,
  trip_inspections to busna_worker;
grant select, delete on bus_locations to busna_worker;
grant delete on notifications to busna_worker;
grant insert on audit_logs to busna_worker;
grant usage on sequence audit_logs_id_seq to busna_worker;

-- ---------------- سياسات الأدوار الخدمية ----------------
do $$
declare t text;
begin
  foreach t in array array['users','refresh_tokens','invites','memberships','tenants','students','guardian_students','audit_logs']
  loop
    execute format('create policy auth_service on %I for all to busna_auth using (true) with check (true)', t);
  end loop;
  foreach t in array array['outbox_events','notifications','safety_alerts','push_tokens','tenants','users','memberships',
    'guardian_students','students','trips','trip_riders','trip_inspections','bus_locations','audit_logs','absences']
  loop
    execute format('create policy worker_service on %I for all to busna_worker using (true) with check (true)', t);
  end loop;
end $$;

-- ---------------- tenants ----------------
create policy tenant_select on tenants for select to busna_app
  using (id = app.cur_tenant() or app.cur_role() = 'platform_admin');
create policy tenant_insert on tenants for insert to busna_app
  with check (app.cur_role() = 'platform_admin');
create policy tenant_update on tenants for update to busna_app
  using ((id = app.cur_tenant() and app.cur_role() = 'tenant_admin') or app.cur_role() = 'platform_admin')
  with check ((id = app.cur_tenant() and app.cur_role() = 'tenant_admin') or app.cur_role() = 'platform_admin');

-- ---------------- users ----------------
create policy users_select on users for select to busna_app
  using (id = app.cur_user() or (app.is_staff() and app.user_in_cur_tenant(id)));
create policy users_update_self on users for update to busna_app
  using (id = app.cur_user()) with check (id = app.cur_user());

-- ---------------- memberships ----------------
create policy memberships_select on memberships for select to busna_app
  using (user_id = app.cur_user() or (tenant_id = app.cur_tenant() and app.is_staff()));
create policy memberships_write on memberships for insert to busna_app
  with check (tenant_id = app.cur_tenant() and app.cur_role() = 'tenant_admin');
create policy memberships_update on memberships for update to busna_app
  using (tenant_id = app.cur_tenant() and app.cur_role() = 'tenant_admin')
  with check (tenant_id = app.cur_tenant() and app.cur_role() = 'tenant_admin');

-- ---------------- invites ----------------
-- مدير الجهة يدعو أي دور؛ المشرف يدعو أولياء الأمور والسائقين؛ مدير المنصة يدعو مدير الجهة الأول.
create policy invites_select on invites for select to busna_app
  using ((tenant_id = app.cur_tenant() and app.is_staff()) or app.cur_role() = 'platform_admin');
create policy invites_insert on invites for insert to busna_app
  with check (
    (tenant_id = app.cur_tenant() and app.cur_role() = 'tenant_admin')
    or (tenant_id = app.cur_tenant() and app.cur_role() = 'supervisor' and role in ('parent', 'driver'))
    or (app.cur_role() = 'platform_admin' and role = 'tenant_admin'));
create policy invites_update on invites for update to busna_app
  using ((tenant_id = app.cur_tenant() and app.is_staff()) or app.cur_role() = 'platform_admin');

-- ---------------- students ----------------
create policy students_select on students for select to busna_app
  using (tenant_id = app.cur_tenant() and (
    app.is_staff()
    or (app.cur_role() = 'parent' and app.is_guardian_of(id))
    or (app.cur_role() = 'driver' and app.driver_has_student(id))));
create policy students_write on students for all to busna_app
  using (tenant_id = app.cur_tenant() and app.is_staff())
  with check (tenant_id = app.cur_tenant() and app.is_staff());

-- ---------------- guardian_students ----------------
create policy gs_select on guardian_students for select to busna_app
  using (tenant_id = app.cur_tenant() and (app.is_staff() or guardian_user_id = app.cur_user()));
create policy gs_write on guardian_students for all to busna_app
  using (tenant_id = app.cur_tenant() and app.is_staff())
  with check (tenant_id = app.cur_tenant() and app.is_staff());

-- ---------------- buses ----------------
create policy buses_select on buses for select to busna_app
  using (tenant_id = app.cur_tenant() and app.cur_role() in ('tenant_admin', 'supervisor', 'driver', 'parent'));
create policy buses_write on buses for all to busna_app
  using (tenant_id = app.cur_tenant() and app.is_staff())
  with check (tenant_id = app.cur_tenant() and app.is_staff());

-- ---------------- routes / stops / riders / schedules ----------------
create policy routes_select on routes for select to busna_app
  using (tenant_id = app.cur_tenant() and (
    app.is_staff()
    or (app.cur_role() = 'driver' and app.driver_has_route(id))
    or (app.cur_role() = 'parent' and app.parent_has_route(id))));
create policy routes_write on routes for all to busna_app
  using (tenant_id = app.cur_tenant() and app.is_staff())
  with check (tenant_id = app.cur_tenant() and app.is_staff());

-- ولي الأمر يرى نقطة توقف أبنائه فقط (لا منازل الطلاب الآخرين)
create policy stops_select on route_stops for select to busna_app
  using (tenant_id = app.cur_tenant() and (
    app.is_staff()
    or (app.cur_role() = 'driver' and app.driver_has_route(route_id))
    or (app.cur_role() = 'parent' and (kind = 'school' or app.parent_has_stop(id)))));
create policy stops_write on route_stops for all to busna_app
  using (tenant_id = app.cur_tenant() and app.is_staff())
  with check (tenant_id = app.cur_tenant() and app.is_staff());

create policy rr_select on route_riders for select to busna_app
  using (tenant_id = app.cur_tenant() and (
    app.is_staff()
    or (app.cur_role() = 'driver' and app.driver_has_route(route_id))
    or (app.cur_role() = 'parent' and app.is_guardian_of(student_id))));
create policy rr_write on route_riders for all to busna_app
  using (tenant_id = app.cur_tenant() and app.is_staff())
  with check (tenant_id = app.cur_tenant() and app.is_staff());

create policy schedules_select on schedules for select to busna_app
  using (tenant_id = app.cur_tenant() and (app.is_staff() or
    (app.cur_role() = 'driver' and app.driver_has_route(route_id))));
create policy schedules_write on schedules for all to busna_app
  using (tenant_id = app.cur_tenant() and app.is_staff())
  with check (tenant_id = app.cur_tenant() and app.is_staff());

-- ---------------- trips ----------------
create policy trips_select on trips for select to busna_app
  using (tenant_id = app.cur_tenant() and (
    app.is_staff()
    or (app.cur_role() = 'driver' and driver_user_id = app.cur_user())
    or (app.cur_role() = 'parent' and app.parent_can_see_trip(id))));
create policy trips_insert on trips for insert to busna_app
  with check (tenant_id = app.cur_tenant() and app.is_staff());
create policy trips_update on trips for update to busna_app
  using (tenant_id = app.cur_tenant() and (app.is_staff()
    or (app.cur_role() = 'driver' and driver_user_id = app.cur_user())))
  with check (tenant_id = app.cur_tenant() and (app.is_staff()
    or (app.cur_role() = 'driver' and driver_user_id = app.cur_user())));
create policy trips_delete on trips for delete to busna_app
  using (tenant_id = app.cur_tenant() and app.cur_role() = 'tenant_admin' and status = 'scheduled');

-- ---------------- trip_riders ----------------
create policy tr_select on trip_riders for select to busna_app
  using (tenant_id = app.cur_tenant() and (
    app.is_staff()
    or (app.cur_role() = 'driver' and app.driver_owns_trip(trip_id))
    or (app.cur_role() = 'parent' and app.is_guardian_of(student_id))));
create policy tr_insert on trip_riders for insert to busna_app
  with check (tenant_id = app.cur_tenant() and app.is_staff());
create policy tr_update on trip_riders for update to busna_app
  using (tenant_id = app.cur_tenant() and (app.is_staff()
    or (app.cur_role() = 'driver' and app.driver_owns_trip(trip_id) and app.trip_in_progress(trip_id))))
  with check (tenant_id = app.cur_tenant() and (app.is_staff()
    or (app.cur_role() = 'driver' and app.driver_owns_trip(trip_id) and app.trip_in_progress(trip_id))));
create policy tr_delete on trip_riders for delete to busna_app
  using (tenant_id = app.cur_tenant() and app.is_staff());

-- ---------------- boarding_events (إضافة فقط) ----------------
create policy be_select on boarding_events for select to busna_app
  using (tenant_id = app.cur_tenant() and (
    app.is_staff()
    or (app.cur_role() = 'driver' and app.driver_owns_trip(trip_id))
    or (app.cur_role() = 'parent' and app.is_guardian_of(student_id))));
create policy be_insert on boarding_events for insert to busna_app
  with check (tenant_id = app.cur_tenant() and recorded_by = app.cur_user() and (
    (app.is_staff())
    or (app.cur_role() = 'driver' and type <> 'correction'
        and app.driver_owns_trip(trip_id) and app.trip_in_progress(trip_id))));

-- ---------------- absences ----------------
create policy abs_select on absences for select to busna_app
  using (tenant_id = app.cur_tenant() and (
    app.is_staff() or (app.cur_role() = 'parent' and app.is_guardian_of(student_id))));
create policy abs_insert on absences for insert to busna_app
  with check (tenant_id = app.cur_tenant() and (
    app.is_staff()
    or (app.cur_role() = 'parent' and app.is_guardian_of(student_id)
        and requested_by = app.cur_user() and status = 'pending')));
create policy abs_update on absences for update to busna_app
  using (tenant_id = app.cur_tenant() and (app.is_staff()
    or (app.cur_role() = 'parent' and requested_by = app.cur_user() and status = 'pending')))
  with check (tenant_id = app.cur_tenant() and (app.is_staff()
    or (app.cur_role() = 'parent' and requested_by = app.cur_user() and status = 'cancelled')));

-- ---------------- bus_locations ----------------
-- الكتابة: سائق الرحلة فقط وأثناء كونها جارية. القراءة لولي الأمر: أثناء الرحلة الجارية فقط.
create policy loc_select on bus_locations for select to busna_app
  using (tenant_id = app.cur_tenant() and (
    app.is_staff()
    or (app.cur_role() = 'driver' and app.driver_owns_trip(trip_id))
    or (app.cur_role() = 'parent' and app.parent_can_see_trip(trip_id) and app.trip_in_progress(trip_id))));
create policy loc_insert on bus_locations for insert to busna_app
  with check (tenant_id = app.cur_tenant() and app.cur_role() = 'driver'
    and app.driver_owns_trip(trip_id) and app.trip_in_progress(trip_id));

-- ---------------- trip_inspections ----------------
create policy insp_select on trip_inspections for select to busna_app
  using (tenant_id = app.cur_tenant() and (app.is_staff()
    or (app.cur_role() = 'driver' and driver_user_id = app.cur_user())));
create policy insp_insert on trip_inspections for insert to busna_app
  with check (tenant_id = app.cur_tenant() and app.cur_role() = 'driver'
    and driver_user_id = app.cur_user() and app.driver_owns_trip(trip_id));
create policy insp_update on trip_inspections for update to busna_app
  using (tenant_id = app.cur_tenant() and app.is_staff())
  with check (tenant_id = app.cur_tenant() and app.is_staff());

-- ---------------- safety_alerts ----------------
create policy alerts_select on safety_alerts for select to busna_app
  using (tenant_id = app.cur_tenant() and (app.is_staff()
    or (app.cur_role() = 'driver' and created_by = app.cur_user())));
create policy alerts_insert on safety_alerts for insert to busna_app
  with check (tenant_id = app.cur_tenant() and (app.is_staff()
    or (app.cur_role() = 'driver' and created_by = app.cur_user()
        and (trip_id is null or app.driver_owns_trip(trip_id)))));
create policy alerts_update on safety_alerts for update to busna_app
  using (tenant_id = app.cur_tenant() and app.is_staff())
  with check (tenant_id = app.cur_tenant() and app.is_staff());

-- ---------------- outbox / notifications / push ----------------
create policy outbox_insert on outbox_events for insert to busna_app
  with check (tenant_id = app.cur_tenant());
create policy notif_select on notifications for select to busna_app
  using (user_id = app.cur_user() and (tenant_id is null or tenant_id = app.cur_tenant()));
create policy notif_update on notifications for update to busna_app
  using (user_id = app.cur_user()) with check (user_id = app.cur_user());
create policy push_own on push_tokens for all to busna_app
  using (user_id = app.cur_user()) with check (user_id = app.cur_user());

-- ---------------- audit_logs ----------------
create policy audit_insert on audit_logs for insert to busna_app
  with check ((tenant_id = app.cur_tenant() or (tenant_id is null and app.cur_role() = 'platform_admin')
               or app.cur_role() = 'platform_admin')
              and actor_user_id = app.cur_user());
create policy audit_select on audit_logs for select to busna_app
  using ((tenant_id = app.cur_tenant() and app.cur_role() = 'tenant_admin') or app.cur_role() = 'platform_admin');

-- ---------------- حماية إضافية: ما يستطيع السائق تعديله في الرحلة ----------------
create or replace function app.trips_guard() returns trigger language plpgsql as $$
begin
  -- الحالات النهائية لا تعود (إلا عبر ترحيل بيانات من المالك)
  if old.status in ('completed', 'cancelled') and new.status <> old.status then
    raise exception 'trip_terminal_state' using errcode = 'P0001';
  end if;
  if old.status = 'in_progress' and new.status = 'scheduled' then
    raise exception 'invalid_trip_transition' using errcode = 'P0001';
  end if;
  if app.cur_role() = 'driver' then
    if new.route_id is distinct from old.route_id or new.driver_user_id is distinct from old.driver_user_id
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
  end if;
  return new;
end $$;
create trigger trips_guard before update on trips for each row execute function app.trips_guard();
grant execute on function app.trips_guard() to busna_app;
