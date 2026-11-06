-- =====================================================================
-- Busna — Trip engine (state machine, attendance, tracking, notifications)
--
-- Every state change is a SECURITY DEFINER function that:
--   1. resolves the caller's role on the trip (driver / supervisor / admin)
--   2. locks the trip row (serialises concurrent taps from two devices)
--   3. validates the transition
--   4. writes the change + an immutable trip_events row
--   5. creates notifications from the REAL event
-- Errors use stable machine codes in MESSAGE and Arabic text in HINT.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------
create or replace function private.fail(p_code text, p_hint text, p_detail text default null)
returns void language plpgsql as $$
begin
  raise exception using errcode = 'P0001', message = p_code, hint = p_hint, detail = coalesce(p_detail, '');
end $$;

create or replace function private.require_uid()
returns uuid language plpgsql stable as $$
declare v uuid := auth.uid();
begin
  if v is null then perform private.fail('not_authenticated', 'يجب تسجيل الدخول'); end if;
  return v;
end $$;

create or replace function private.first_name(p text)
returns text language sql immutable as $$ select split_part(trim(p), ' ', 1) $$;

create or replace function private.period_label(p public.trip_period)
returns text language sql immutable as $$
  select case p when 'morning' then 'الصباحية' else 'المسائية' end
$$;

create or replace function private.school_today(p_school uuid)
returns date language sql stable security definer set search_path = '' as $$
  select (now() at time zone s.timezone)::date from public.schools s where s.id = p_school
$$;

-- Role of the caller on a trip, restricted to p_allowed. Raises when none.
-- Priority: driver > supervisor > admin.
create or replace function private.trip_role(p_trip public.trips, p_allowed text[])
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
begin
  if 'driver' = any(p_allowed) and exists (
      select 1 from public.staff s where s.id = p_trip.driver_id and s.user_id = v_uid and s.status = 'active') then
    return 'driver';
  end if;
  if 'supervisor' = any(p_allowed) and exists (
      select 1 from public.staff s where s.id = p_trip.supervisor_id and s.user_id = v_uid and s.status = 'active') then
    return 'supervisor';
  end if;
  if 'admin' = any(p_allowed) and exists (
      select 1 from public.school_members m
       where m.school_id = p_trip.school_id and m.user_id = v_uid and m.role in ('owner', 'admin')) then
    return 'admin';
  end if;
  perform private.fail('not_assigned', 'هذه الرحلة غير مخصصة لك أو لا تملك صلاحية تنفيذ هذا الإجراء');
  return null;
end $$;

create or replace function private.lock_trip(p_trip uuid)
returns public.trips language plpgsql security definer set search_path = '' as $$
declare v public.trips;
begin
  select * into v from public.trips where id = p_trip for update;
  if not found then perform private.fail('trip_not_found', 'الرحلة غير موجودة'); end if;
  return v;
end $$;

create or replace function private.log_event(p_trip public.trips, p_type text, p_role text,
  p_student uuid default null, p_lat double precision default null, p_lng double precision default null,
  p_data jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.trip_events (school_id, trip_id, type, actor_user_id, actor_role, student_id, lat, lng, data)
  values (p_trip.school_id, p_trip.id, p_type, auth.uid(), p_role, p_student, p_lat, p_lng, coalesce(p_data, '{}'::jsonb))
$$;

-- One notification per active guardian of the student (deduplicated per
-- guardian/trip/student/type, so an undo + redo never spams parents).
create or replace function private.notify_student(p_trip public.trips, p_student uuid, p_type text,
  p_title text, p_body text, p_data jsonb default '{}'::jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  insert into public.notifications (school_id, guardian_id, student_id, trip_id, type, title, body, data)
  select p_trip.school_id, g.id, p_student, p_trip.id, p_type, p_title, p_body,
         coalesce(p_data, '{}'::jsonb) || jsonb_build_object('period', p_trip.period)
    from public.student_guardians sg
    join public.guardians g on g.id = sg.guardian_id and g.status = 'active'
   where sg.student_id = p_student
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- One notification per guardian having at least one child in the given
-- attendance states on the trip (used for trip-wide events).
create or replace function private.notify_trip_guardians(p_trip public.trips, p_states public.attendance_status[],
  p_type text, p_title text, p_body text, p_data jsonb default '{}'::jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  insert into public.notifications (school_id, guardian_id, trip_id, type, title, body, data)
  select distinct p_trip.school_id, g.id, p_trip.id, p_type, p_title, p_body,
         coalesce(p_data, '{}'::jsonb) || jsonb_build_object('period', p_trip.period)
    from public.trip_students ts
    join public.student_guardians sg on sg.student_id = ts.student_id
    join public.guardians g on g.id = sg.guardian_id and g.status = 'active'
   where ts.trip_id = p_trip.id and ts.status = any(p_states);
  get diagnostics n = row_count;
  return n;
end $$;

-- Notify school dashboard users (owner/admin).
create or replace function private.notify_admins(p_school uuid, p_trip uuid, p_type text,
  p_title text, p_body text, p_data jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.notifications (school_id, recipient_user_id, trip_id, type, title, body, data)
  select p_school, m.user_id, p_trip, p_type, p_title, p_body, coalesce(p_data, '{}'::jsonb)
    from public.school_members m where m.school_id = p_school and m.role in ('owner', 'admin')
$$;

-- ---------------------------------------------------------------------
-- Trip generation from recurring routes
-- ---------------------------------------------------------------------
create or replace function public.generate_trips(p_school uuid, p_date date)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_tz text;
  v_route record;
  v_trip_id uuid;
  v_created int := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not exists (select 1 from public.school_members m
                      where m.school_id = p_school and m.user_id = auth.uid() and m.role in ('owner', 'admin')) then
    perform private.fail('forbidden', 'لا تملك صلاحية إنشاء الرحلات لهذه المدرسة');
  end if;

  select timezone into v_tz from public.schools where id = p_school;
  if v_tz is null then perform private.fail('school_not_found', 'المدرسة غير موجودة'); end if;

  for v_route in
    select r.* from public.routes r
     where r.school_id = p_school and r.active
       and extract(dow from p_date)::smallint = any(r.weekdays)
  loop
    insert into public.trips (school_id, route_id, name, trip_date, period, bus_id, driver_id, supervisor_id,
                              scheduled_start, start_label, start_lat, start_lng, end_label, end_lat, end_lng, path)
    values (p_school, v_route.id, v_route.name, p_date, v_route.period, v_route.bus_id, v_route.driver_id,
            v_route.supervisor_id, (p_date + v_route.departure_time) at time zone v_tz,
            v_route.start_label, v_route.start_lat, v_route.start_lng,
            v_route.end_label, v_route.end_lat, v_route.end_lng, v_route.path)
    on conflict (route_id, trip_date) do nothing
    returning id into v_trip_id;

    if v_trip_id is not null then
      v_created := v_created + 1;
      insert into public.trip_stops (school_id, trip_id, seq, name, lat, lng, planned_at)
      select p_school, v_trip_id, rs.seq, rs.name, rs.lat, rs.lng,
             ((p_date + v_route.departure_time) at time zone v_tz) + make_interval(mins => rs.offset_min)
        from public.route_stops rs where rs.route_id = v_route.id;
    else
      select id into v_trip_id from public.trips where route_id = v_route.id and trip_date = p_date;
    end if;

    -- Sync roster while the trip has not started (idempotent).
    if (select status from public.trips where id = v_trip_id) = 'scheduled' then
      insert into public.trip_students (school_id, trip_id, student_id, trip_stop_id)
      select p_school, v_trip_id, rst.student_id,
             (select ts.id from public.trip_stops ts
                join public.route_stops rs on rs.seq = ts.seq and rs.id = rst.stop_id
               where ts.trip_id = v_trip_id)
        from public.route_students rst
        join public.students s on s.id = rst.student_id and s.transport_status = 'active'
       where rst.route_id = v_route.id
      on conflict (trip_id, student_id) do nothing;
    end if;
    v_trip_id := null;
  end loop;

  return v_created;
end $$;

-- ---------------------------------------------------------------------
-- Start trip (driver)
-- ---------------------------------------------------------------------
create or replace function public.start_trip(p_trip uuid, p_lat double precision default null,
                                             p_lng double precision default null)
returns public.trips language plpgsql security definer set search_path = '' as $$
declare
  t public.trips := private.lock_trip(p_trip);
  v_role text := private.trip_role(t, array['driver']);
begin
  if t.status <> 'scheduled' then
    perform private.fail('invalid_state', 'لا يمكن بدء هذه الرحلة في حالتها الحالية', t.status::text);
  end if;
  if t.trip_date <> private.school_today(t.school_id) then
    perform private.fail('not_today', 'يمكن بدء الرحلة في يومها فقط');
  end if;
  if exists (select 1 from public.trips o where o.driver_id = t.driver_id and o.id <> t.id
              and o.status in ('started', 'in_progress')) then
    perform private.fail('driver_busy', 'لديك رحلة نشطة أخرى، يجب إنهاؤها أولًا');
  end if;
  if t.bus_id is not null and exists (select 1 from public.trips o where o.bus_id = t.bus_id and o.id <> t.id
              and o.status in ('started', 'in_progress')) then
    perform private.fail('bus_busy', 'الباص مستخدم في رحلة نشطة أخرى');
  end if;

  update public.trips set status = 'started', started_at = now(), started_by = auth.uid()
   where id = t.id returning * into t;

  if p_lat is not null and p_lng is not null then
    insert into public.bus_live_positions (trip_id, school_id, bus_id, lat, lng, recorded_at)
    values (t.id, t.school_id, t.bus_id, p_lat, p_lng, now())
    on conflict (trip_id) do update set lat = excluded.lat, lng = excluded.lng,
      recorded_at = excluded.recorded_at, received_at = now();
  end if;

  perform private.log_event(t, 'trip_started', v_role, null, p_lat, p_lng);

  insert into public.notifications (school_id, guardian_id, student_id, trip_id, type, title, body, data)
  select t.school_id, g.id, s.id, t.id, 'trip_started',
         'بدأت الرحلة ' || private.period_label(t.period),
         'باص ' || private.first_name(s.full_name) || ' بدأ الرحلة ' || private.period_label(t.period) || '.',
         jsonb_build_object('period', t.period)
    from public.trip_students ts
    join public.students s on s.id = ts.student_id
    join public.student_guardians sg on sg.student_id = s.id
    join public.guardians g on g.id = sg.guardian_id and g.status = 'active'
   where ts.trip_id = t.id and ts.status <> 'absent'
  on conflict do nothing;

  return t;
end $$;

-- ---------------------------------------------------------------------
-- Attendance (driver or supervisor)
-- ---------------------------------------------------------------------
-- p_at: device time of the tap (offline replay). Bounded to the last 12h and
-- never in the future; defaults to server time.
create or replace function public.record_attendance(p_trip_student uuid, p_status public.attendance_status,
  p_lat double precision default null, p_lng double precision default null, p_at timestamptz default null)
returns public.trip_students language plpgsql security definer set search_path = '' as $$
declare
  v_at timestamptz := case when p_at is null or p_at > now() or p_at < now() - interval '12 hours' then now() else p_at end;
  v_trip_id uuid;
  t public.trips;
  v_role text;
  ts public.trip_students;
  v_name text;
  v_place text;
  v_ok boolean;
begin
  select trip_id into v_trip_id from public.trip_students where id = p_trip_student;
  if v_trip_id is null then perform private.fail('not_found', 'الطالب غير موجود في هذه الرحلة'); end if;

  t := private.lock_trip(v_trip_id);
  v_role := private.trip_role(t, array['driver', 'supervisor']);

  select * into ts from public.trip_students where id = p_trip_student for update;
  select full_name into v_name from public.students where id = ts.student_id;

  if t.status in ('completed', 'cancelled') then
    perform private.fail('trip_closed', 'الرحلة منتهية أو ملغاة');
  end if;
  if t.status = 'scheduled' and p_status not in ('absent', 'pending') then
    perform private.fail('trip_not_started', 'يجب بدء الرحلة قبل تسجيل الصعود أو الإنزال');
  end if;
  if ts.status = p_status then
    return ts;  -- idempotent (double tap / offline replay)
  end if;

  v_ok := case ts.status
    when 'pending' then p_status in ('boarded', 'absent')
    when 'absent'  then p_status in ('pending', 'boarded')
    when 'boarded' then p_status in ('dropped', 'pending')
    when 'dropped' then p_status in ('boarded')
  end;
  if not v_ok then
    perform private.fail('invalid_transition', 'لا يمكن تغيير حالة الطالب بهذا الشكل',
                         ts.status::text || '->' || p_status::text);
  end if;

  if p_status = 'boarded' then
    update public.trip_students set status = 'boarded', boarded_at = v_at, boarded_lat = p_lat, boarded_lng = p_lng,
           boarded_by = auth.uid(), dropped_at = null, dropped_lat = null, dropped_lng = null, dropped_by = null,
           drop_place = null, absent_at = null, absent_by = null
     where id = ts.id returning * into ts;
    if t.status = 'started' then
      update public.trips set status = 'in_progress' where id = t.id returning * into t;
    end if;
    perform private.notify_student(t, ts.student_id, 'student_boarded', 'صعود إلى الباص',
      'تم تسجيل صعود ' || private.first_name(v_name) || ' إلى الباص.');

  elsif p_status = 'dropped' then
    v_place := case
      when t.period = 'afternoon' then 'home'
      when t.arrived_at is not null
        or coalesce(public.distance_m(p_lat, p_lng, t.end_lat, t.end_lng), 1e9) < 300 then 'school'
      else 'stop' end;
    update public.trip_students set status = 'dropped', dropped_at = v_at, dropped_lat = p_lat, dropped_lng = p_lng,
           dropped_by = auth.uid(), drop_place = v_place
     where id = ts.id returning * into ts;
    if v_place = 'school' then
      perform private.notify_student(t, ts.student_id, 'student_arrived_school', 'الوصول إلى المدرسة',
        'وصل ' || private.first_name(v_name) || ' إلى المدرسة بسلام.');
    elsif v_place = 'home' then
      perform private.notify_student(t, ts.student_id, 'student_dropped', 'الوصول إلى المنزل',
        'تم إنزال ' || private.first_name(v_name) || ' عند المنزل.');
    else
      perform private.notify_student(t, ts.student_id, 'student_dropped', 'نزول من الباص',
        'تم تسجيل نزول ' || private.first_name(v_name) || ' من الباص.');
    end if;

  elsif p_status = 'absent' then
    update public.trip_students set status = 'absent', absent_at = v_at, absent_by = auth.uid(),
           boarded_at = null, boarded_lat = null, boarded_lng = null, boarded_by = null
     where id = ts.id returning * into ts;
    perform private.notify_student(t, ts.student_id, 'student_absent', 'تسجيل غياب',
      'تم تسجيل غياب ' || private.first_name(v_name) || ' عن الرحلة ' || private.period_label(t.period) || '.');

  else -- back to pending (undo)
    update public.trip_students set status = 'pending', boarded_at = null, boarded_lat = null, boarded_lng = null,
           boarded_by = null, absent_at = null, absent_by = null
     where id = ts.id returning * into ts;
  end if;

  perform private.log_event(t, 'attendance_' || p_status::text, v_role, ts.student_id, p_lat, p_lng,
                            jsonb_build_object('student_name', v_name, 'drop_place', ts.drop_place, 'recorded_at', v_at));
  return ts;
end $$;

-- ---------------------------------------------------------------------
-- Arrival at school / end point (driver). Distinct from ending the trip.
-- Morning: every student still on board is checked in at school.
-- ---------------------------------------------------------------------
create or replace function public.arrive_trip(p_trip uuid, p_lat double precision default null,
                                              p_lng double precision default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  t public.trips := private.lock_trip(p_trip);
  v_role text := private.trip_role(t, array['driver']);
  v_kind text := case when t.period = 'morning' then 'school' else 'end_point' end;
  r record;
  v_count int := 0;
begin
  if t.status not in ('started', 'in_progress') then
    perform private.fail('trip_not_active', 'الرحلة ليست نشطة');
  end if;
  if t.arrived_at is not null then
    return jsonb_build_object('arrived_kind', t.arrived_kind, 'dropped', 0, 'already', true);
  end if;

  update public.trips set arrived_at = now(), arrived_kind = v_kind, status = 'in_progress'
   where id = t.id returning * into t;

  if v_kind = 'school' then
    for r in select ts.id, ts.student_id, s.full_name from public.trip_students ts
               join public.students s on s.id = ts.student_id
              where ts.trip_id = t.id and ts.status = 'boarded'
    loop
      update public.trip_students set status = 'dropped', dropped_at = now(), dropped_lat = p_lat,
             dropped_lng = p_lng, dropped_by = auth.uid(), drop_place = 'school'
       where id = r.id;
      perform private.notify_student(t, r.student_id, 'student_arrived_school', 'الوصول إلى المدرسة',
        'وصل ' || private.first_name(r.full_name) || ' إلى المدرسة بسلام.');
      perform private.log_event(t, 'attendance_dropped', v_role, r.student_id, p_lat, p_lng,
        jsonb_build_object('student_name', r.full_name, 'drop_place', 'school', 'auto', true));
      v_count := v_count + 1;
    end loop;
  end if;

  perform private.log_event(t, case when v_kind = 'school' then 'arrived_school' else 'arrived_end_point' end,
                            v_role, null, p_lat, p_lng, jsonb_build_object('dropped', v_count));
  return jsonb_build_object('arrived_kind', v_kind, 'dropped', v_count, 'already', false);
end $$;

-- ---------------------------------------------------------------------
-- End trip (driver). Refuses while any student is still on board.
-- Pending (never picked up) students must be confirmed absent explicitly.
-- ---------------------------------------------------------------------
create or replace function public.end_trip(p_trip uuid, p_lat double precision default null,
  p_lng double precision default null, p_mark_pending_absent boolean default false)
returns public.trips language plpgsql security definer set search_path = '' as $$
declare
  t public.trips := private.lock_trip(p_trip);
  v_role text := private.trip_role(t, array['driver']);
  v_names text;
  r record;
begin
  if t.status not in ('started', 'in_progress') then
    perform private.fail('trip_not_active', 'الرحلة ليست نشطة');
  end if;

  select string_agg(s.full_name, '، ' order by s.full_name) into v_names
    from public.trip_students ts join public.students s on s.id = ts.student_id
   where ts.trip_id = t.id and ts.status = 'boarded';
  if v_names is not null then
    perform private.fail('students_on_board', 'لا يمكن إنهاء الرحلة: يوجد طلاب داخل الباص لم يتم تسجيل نزولهم', v_names);
  end if;

  select string_agg(s.full_name, '، ' order by s.full_name) into v_names
    from public.trip_students ts join public.students s on s.id = ts.student_id
   where ts.trip_id = t.id and ts.status = 'pending';
  if v_names is not null and not p_mark_pending_absent then
    perform private.fail('students_pending', 'يوجد طلاب لم تُسجّل حالتهم. أكّد تسجيلهم غائبين لإنهاء الرحلة', v_names);
  end if;

  for r in select ts.id, ts.student_id, s.full_name from public.trip_students ts
             join public.students s on s.id = ts.student_id
            where ts.trip_id = t.id and ts.status = 'pending'
  loop
    update public.trip_students set status = 'absent', absent_at = now(), absent_by = auth.uid() where id = r.id;
    perform private.log_event(t, 'attendance_absent', v_role, r.student_id, p_lat, p_lng,
      jsonb_build_object('student_name', r.full_name, 'auto', true));
    perform private.notify_student(t, r.student_id, 'student_absent', 'تسجيل غياب',
      'تم تسجيل غياب ' || private.first_name(r.full_name) || ' عن الرحلة ' || private.period_label(t.period) || '.');
  end loop;

  update public.trips set status = 'completed', completed_at = now(), completed_by = auth.uid(),
         emergency_active = false
   where id = t.id returning * into t;

  -- Stop live tracking immediately.
  delete from public.bus_live_positions where trip_id = t.id;

  perform private.log_event(t, 'trip_completed', v_role, null, p_lat, p_lng);
  return t;
end $$;

-- Validated GPS points from a client batch (drops junk, future and stale points).
create or replace function private.parse_points(p_points jsonb, p_since timestamptz)
returns table (lat double precision, lng double precision, heading double precision, speed double precision,
               accuracy double precision, recorded_at timestamptz)
language sql stable as $$
  select p.lat, p.lng, p.heading, p.speed, p.accuracy, p.t
    from jsonb_to_recordset(p_points) as p(lat double precision, lng double precision, heading double precision,
                                           speed double precision, accuracy double precision, t timestamptz)
   where p.lat between -90 and 90 and p.lng between -180 and 180
     and not (p.lat = 0 and p.lng = 0)
     and p.t is not null
     and p.t <= now() + interval '2 minutes'
     and p.t >= p_since - interval '1 minute'
     and coalesce(p.accuracy, 0) < 500
$$;

-- ---------------------------------------------------------------------
-- Location publishing (driver device). Batched for offline replay.
-- p_points: [{"lat":..,"lng":..,"heading":..,"speed":..,"accuracy":..,"t":"ISO-8601"}, ...]
-- ---------------------------------------------------------------------
create or replace function public.push_locations(p_trip uuid, p_points jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  t public.trips;
  v_latest record;
  v_count int;
  v_radius double precision;
  r record;
begin
  -- No row lock here: locations are high-frequency; only read state.
  select * into t from public.trips where id = p_trip;
  if not found then perform private.fail('trip_not_found', 'الرحلة غير موجودة'); end if;
  perform private.trip_role(t, array['driver']);

  if t.status not in ('started', 'in_progress') then
    -- The client must stop sharing location when it receives this.
    perform private.fail('trip_not_active', 'مشاركة الموقع متاحة أثناء الرحلة النشطة فقط');
  end if;
  if jsonb_typeof(p_points) <> 'array' or jsonb_array_length(p_points) = 0 then
    return jsonb_build_object('accepted', 0, 'status', t.status);
  end if;
  if jsonb_array_length(p_points) > 500 then
    perform private.fail('too_many_points', 'دفعة المواقع كبيرة جدًا');
  end if;

  insert into public.bus_locations (school_id, trip_id, bus_id, lat, lng, heading, speed, accuracy, recorded_at)
  select t.school_id, t.id, t.bus_id, p.lat, p.lng, p.heading, p.speed, p.accuracy, p.recorded_at
    from private.parse_points(p_points, t.started_at) p;
  get diagnostics v_count = row_count;
  if v_count = 0 then
    return jsonb_build_object('accepted', 0, 'status', t.status);
  end if;

  select * into v_latest from private.parse_points(p_points, t.started_at) p order by p.recorded_at desc limit 1;

  insert into public.bus_live_positions (trip_id, school_id, bus_id, lat, lng, heading, speed, accuracy, recorded_at)
  values (t.id, t.school_id, t.bus_id, v_latest.lat, v_latest.lng, v_latest.heading, v_latest.speed,
          v_latest.accuracy, v_latest.recorded_at)
  on conflict (trip_id) do update set lat = excluded.lat, lng = excluded.lng, heading = excluded.heading,
      speed = excluded.speed, accuracy = excluded.accuracy, recorded_at = excluded.recorded_at, received_at = now()
   where public.bus_live_positions.recorded_at <= excluded.recorded_at;

  if t.status = 'started' then
    update public.trips set status = 'in_progress' where id = t.id;
    t.status := 'in_progress';
  end if;

  -- Stop progress.
  update public.trip_stops set arrived_at = v_latest.recorded_at
   where trip_id = t.id and arrived_at is null
     and public.distance_m(lat, lng, v_latest.lat, v_latest.lng) < 80;

  -- Approach notifications (once per student per trip).
  select coalesce((settings ->> 'approach_radius_m')::double precision, 700) into v_radius
    from public.schools where id = t.school_id;

  for r in
    select ts.id, ts.student_id, s.full_name
      from public.trip_students ts
      join public.students s on s.id = ts.student_id
      left join public.trip_stops st on st.id = ts.trip_stop_id
     where ts.trip_id = t.id and ts.approach_notified_at is null
       and ts.status = (case when t.period = 'morning' then 'pending' else 'boarded' end)::public.attendance_status
       and public.distance_m(v_latest.lat, v_latest.lng,
             coalesce(st.lat, case when t.period = 'morning' then s.pickup_lat else coalesce(s.home_lat, s.pickup_lat) end),
             coalesce(st.lng, case when t.period = 'morning' then s.pickup_lng else coalesce(s.home_lng, s.pickup_lng) end)) <= v_radius
  loop
    update public.trip_students set approach_notified_at = now() where id = r.id;
    if t.period = 'morning' then
      perform private.notify_student(t, r.student_id, 'bus_approaching', 'الباص يقترب',
        'باص ' || private.first_name(r.full_name) || ' يقترب من نقطة الصعود.');
    else
      perform private.notify_student(t, r.student_id, 'bus_approaching_home', 'الباص يقترب من المنزل',
        'الباص يقترب من المنزل، سيصل ' || private.first_name(r.full_name) || ' خلال دقائق.');
    end if;
  end loop;

  return jsonb_build_object('accepted', v_count, 'status', t.status);
end $$;

-- ---------------------------------------------------------------------
-- Delay / cancel / incidents / notes
-- ---------------------------------------------------------------------
create or replace function public.report_delay(p_trip uuid, p_minutes int, p_reason text)
returns public.trips language plpgsql security definer set search_path = '' as $$
declare
  t public.trips := private.lock_trip(p_trip);
  v_role text := private.trip_role(t, array['driver', 'supervisor', 'admin']);
begin
  if t.status in ('completed', 'cancelled') then perform private.fail('trip_closed', 'الرحلة منتهية أو ملغاة'); end if;
  if p_minutes is null or p_minutes < 1 or p_minutes > 240 then
    perform private.fail('invalid_minutes', 'مدة التأخير غير صحيحة');
  end if;
  if coalesce(trim(p_reason), '') = '' then perform private.fail('reason_required', 'يرجى ذكر سبب التأخير'); end if;

  update public.trips set delay_minutes = p_minutes, delay_reason = trim(p_reason) where id = t.id returning * into t;
  perform private.log_event(t, 'trip_delayed', v_role, null, null, null,
                            jsonb_build_object('minutes', p_minutes, 'reason', t.delay_reason));
  perform private.notify_trip_guardians(t, array['pending', 'boarded']::public.attendance_status[], 'trip_delayed',
    'تأخر الرحلة', 'الرحلة ' || private.period_label(t.period) || ' متأخرة حوالي ' || p_minutes || ' دقيقة. السبب: ' || t.delay_reason,
    jsonb_build_object('minutes', p_minutes, 'reason', t.delay_reason));
  return t;
end $$;

create or replace function public.cancel_trip(p_trip uuid, p_reason text)
returns public.trips language plpgsql security definer set search_path = '' as $$
declare
  t public.trips := private.lock_trip(p_trip);
  v_role text := private.trip_role(t, array['admin']);
begin
  if t.status in ('completed', 'cancelled') then perform private.fail('trip_closed', 'الرحلة منتهية أو ملغاة'); end if;
  if exists (select 1 from public.trip_students where trip_id = t.id and status = 'boarded') then
    perform private.fail('students_on_board', 'لا يمكن إلغاء رحلة وعلى متنها طلاب');
  end if;
  if coalesce(trim(p_reason), '') = '' then perform private.fail('reason_required', 'يرجى ذكر سبب الإلغاء'); end if;

  update public.trips set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
         cancel_reason = trim(p_reason)
   where id = t.id returning * into t;
  delete from public.bus_live_positions where trip_id = t.id;
  perform private.log_event(t, 'trip_cancelled', v_role, null, null, null, jsonb_build_object('reason', t.cancel_reason));
  perform private.notify_trip_guardians(t, array['pending', 'dropped', 'absent']::public.attendance_status[], 'trip_cancelled',
    'إلغاء الرحلة', 'تم إلغاء الرحلة ' || private.period_label(t.period) || ' اليوم. السبب: ' || t.cancel_reason,
    jsonb_build_object('reason', t.cancel_reason));
  return t;
end $$;

create or replace function public.report_incident(p_trip uuid, p_category text, p_severity public.incident_severity,
  p_description text, p_lat double precision default null, p_lng double precision default null)
returns public.incidents language plpgsql security definer set search_path = '' as $$
declare
  t public.trips := private.lock_trip(p_trip);
  v_role text := private.trip_role(t, array['driver', 'supervisor', 'admin']);
  i public.incidents;
begin
  if coalesce(trim(p_description), '') = '' then perform private.fail('description_required', 'يرجى وصف المشكلة'); end if;

  insert into public.incidents (school_id, trip_id, bus_id, reported_by, reporter_role, category, severity, description, lat, lng)
  values (t.school_id, t.id, t.bus_id, auth.uid(), v_role, p_category, p_severity, trim(p_description), p_lat, p_lng)
  returning * into i;

  perform private.log_event(t, 'incident_reported', v_role, null, p_lat, p_lng,
    jsonb_build_object('incident_id', i.id, 'category', p_category, 'severity', p_severity));

  if p_severity in ('high', 'critical') then
    perform private.notify_admins(t.school_id, t.id, 'incident', 'بلاغ ' ||
      case when p_severity = 'critical' then 'طارئ' else 'عاجل' end || ' — ' || t.name, trim(p_description),
      jsonb_build_object('incident_id', i.id));
  end if;

  if p_severity = 'critical' and t.status in ('started', 'in_progress') then
    update public.trips set emergency_active = true where id = t.id;
    perform private.notify_trip_guardians(t, array['boarded']::public.attendance_status[], 'trip_issue',
      'تنبيه بخصوص الرحلة', 'حدثت مشكلة أثناء الرحلة ' || private.period_label(t.period) ||
      '، والمدرسة تتابع الوضع الآن وسنوافيك بالمستجدات.', jsonb_build_object('incident_id', i.id));
  end if;
  return i;
end $$;

create or replace function public.clear_trip_emergency(p_trip uuid, p_note text default null)
returns public.trips language plpgsql security definer set search_path = '' as $$
declare
  t public.trips := private.lock_trip(p_trip);
  v_role text := private.trip_role(t, array['admin']);
begin
  update public.trips set emergency_active = false where id = t.id returning * into t;
  perform private.log_event(t, 'emergency_cleared', v_role, null, null, null, jsonb_build_object('note', p_note));
  return t;
end $$;

create or replace function public.add_trip_note(p_trip uuid, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  t public.trips;
  v_role text;
begin
  select * into t from public.trips where id = p_trip;
  if not found then perform private.fail('trip_not_found', 'الرحلة غير موجودة'); end if;
  v_role := private.trip_role(t, array['driver', 'supervisor', 'admin']);
  if coalesce(trim(p_note), '') = '' then perform private.fail('note_required', 'الملاحظة فارغة'); end if;
  perform private.log_event(t, 'note', v_role, null, null, null, jsonb_build_object('note', left(trim(p_note), 2000)));
end $$;

-- Reassign a not-yet-finished trip for the day (admin).
create or replace function public.update_trip_assignment(p_trip uuid, p_bus uuid, p_driver uuid, p_supervisor uuid)
returns public.trips language plpgsql security definer set search_path = '' as $$
declare
  t public.trips := private.lock_trip(p_trip);
  v_role text := private.trip_role(t, array['admin']);
begin
  if t.status in ('completed', 'cancelled') then perform private.fail('trip_closed', 'الرحلة منتهية أو ملغاة'); end if;
  if t.status <> 'scheduled' and p_driver is distinct from t.driver_id then
    perform private.fail('invalid_state', 'لا يمكن تغيير السائق بعد بدء الرحلة');
  end if;
  update public.trips set bus_id = p_bus, driver_id = p_driver, supervisor_id = p_supervisor
   where id = t.id returning * into t;  -- composite FKs reject cross-school ids
  perform private.log_event(t, 'assignment_changed', v_role, null, null, null,
    jsonb_build_object('bus_id', p_bus, 'driver_id', p_driver, 'supervisor_id', p_supervisor));
  return t;
end $$;

-- Supervisor/admin: guardian contacts for the trip roster (drivers excluded
-- on purpose — they should not be calling parents while driving).
create or replace function public.get_trip_contacts(p_trip uuid)
returns table (student_id uuid, student_name text, guardian_name text, relation text, phone text, phone_alt text)
language plpgsql stable security definer set search_path = '' as $$
declare t public.trips;
begin
  select * into t from public.trips where id = p_trip;
  if not found then perform private.fail('trip_not_found', 'الرحلة غير موجودة'); end if;
  perform private.trip_role(t, array['supervisor', 'admin']);
  return query
    select s.id, s.full_name, g.full_name, sg.relation, g.phone, g.phone_alt
      from public.trip_students ts
      join public.students s on s.id = ts.student_id
      join public.student_guardians sg on sg.student_id = s.id
      join public.guardians g on g.id = sg.guardian_id and g.status = 'active'
     where ts.trip_id = t.id
     order by s.full_name, sg.is_primary desc;
end $$;

-- Transfer a student to another bus and that bus's routes (admin).
create or replace function public.transfer_student(p_student uuid, p_bus uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.students;
  v_routes int;
begin
  select * into s from public.students where id = p_student for update;
  if not found then perform private.fail('not_found', 'الطالب غير موجود'); end if;
  if not exists (select 1 from public.school_members m where m.school_id = s.school_id
                  and m.user_id = auth.uid() and m.role in ('owner', 'admin')) then
    perform private.fail('forbidden', 'لا تملك صلاحية تعديل بيانات هذا الطالب');
  end if;
  if p_bus is not null and not exists (select 1 from public.buses where id = p_bus and school_id = s.school_id) then
    perform private.fail('bus_not_found', 'الباص غير موجود');
  end if;

  update public.students set bus_id = p_bus where id = s.id;
  delete from public.route_students rs using public.routes r
   where rs.route_id = r.id and rs.student_id = s.id and r.bus_id is distinct from p_bus;
  insert into public.route_students (school_id, route_id, student_id)
  select s.school_id, r.id, s.id from public.routes r
   where r.school_id = s.school_id and r.bus_id = p_bus and r.active
  on conflict do nothing;
  get diagnostics v_routes = row_count;

  -- Keep today's not-yet-started trips in sync.
  delete from public.trip_students ts using public.trips t
   where ts.trip_id = t.id and ts.student_id = s.id and t.status = 'scheduled'
     and t.bus_id is distinct from p_bus;
  insert into public.trip_students (school_id, trip_id, student_id)
  select s.school_id, t.id, s.id from public.trips t
   where t.school_id = s.school_id and t.bus_id = p_bus and t.status = 'scheduled'
     and t.trip_date >= private.school_today(s.school_id)
     and t.route_id in (select route_id from public.route_students where student_id = s.id)
  on conflict do nothing;

  return jsonb_build_object('student_id', s.id, 'bus_id', p_bus, 'routes_added', v_routes);
end $$;

-- Grants
revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.generate_trips(uuid, date),
  public.start_trip(uuid, double precision, double precision),
  public.record_attendance(uuid, public.attendance_status, double precision, double precision, timestamptz),
  public.arrive_trip(uuid, double precision, double precision),
  public.end_trip(uuid, double precision, double precision, boolean),
  public.push_locations(uuid, jsonb),
  public.report_delay(uuid, int, text),
  public.cancel_trip(uuid, text),
  public.report_incident(uuid, text, public.incident_severity, text, double precision, double precision),
  public.clear_trip_emergency(uuid, text),
  public.add_trip_note(uuid, text),
  public.update_trip_assignment(uuid, uuid, uuid, uuid),
  public.get_trip_contacts(uuid),
  public.transfer_student(uuid, uuid),
  public.normalize_phone(text),
  public.distance_m(double precision, double precision, double precision, double precision)
to authenticated, service_role;
grant execute on all functions in schema private to authenticated, service_role;
