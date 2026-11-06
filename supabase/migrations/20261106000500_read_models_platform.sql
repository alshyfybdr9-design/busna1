-- =====================================================================
-- Busna — Read models, onboarding, audit, AI approvals, realtime
-- =====================================================================

-- ---------------------------------------------------------------------
-- Bus load (capacity warnings). security_invoker => RLS of caller applies.
-- ---------------------------------------------------------------------
create view public.bus_load with (security_invoker = true) as
select b.id as bus_id, b.school_id, b.code, b.plate_number, b.capacity, b.status,
       count(s.id) filter (where s.transport_status = 'active')::int as assigned_students,
       (count(s.id) filter (where s.transport_status = 'active') > b.capacity) as over_capacity
  from public.buses b
  left join public.students s on s.bus_id = b.id
 group by b.id;
grant select on public.bus_load to authenticated;

-- ---------------------------------------------------------------------
-- Account linking: a user who signed in with a VERIFIED phone/email
-- claims the staff/guardian records the school created for them.
-- ---------------------------------------------------------------------
create or replace function public.claim_my_records()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_phone text;
  v_email text;
  v_staff int := 0;
  v_guardians int := 0;
  v_n int;
begin
  select case when u.phone_confirmed_at is not null then public.normalize_phone(u.phone) end,
         case when u.email_confirmed_at is not null then lower(u.email) end
    into v_phone, v_email
    from auth.users u where u.id = v_uid;

  if v_phone is not null then
    update public.staff set user_id = v_uid where phone = v_phone and user_id is null;
    get diagnostics v_staff = row_count;
    update public.guardians set user_id = v_uid where phone = v_phone and user_id is null;
    get diagnostics v_guardians = row_count;
  end if;
  if v_email is not null then
    update public.guardians set user_id = v_uid where lower(email) = v_email and user_id is null;
    get diagnostics v_n = row_count;
    v_guardians := v_guardians + v_n;
  end if;

  insert into public.profiles (id, phone) values (v_uid, v_phone) on conflict (id) do nothing;
  return jsonb_build_object('staff_linked', v_staff, 'guardians_linked', v_guardians);
end $$;

-- What the signed-in user can access (drives app routing).
create or replace function public.my_access()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'user_id', auth.uid(),
    'platform_admin', exists (select 1 from public.platform_admins where user_id = auth.uid()),
    'schools', coalesce((select jsonb_agg(jsonb_build_object(
        'school_id', s.id, 'slug', s.slug, 'name', s.name, 'logo_url', s.logo_url,
        'primary_color', s.primary_color, 'role', m.role) order by s.name)
      from public.school_members m join public.schools s on s.id = m.school_id
     where m.user_id = auth.uid() and s.status = 'active'), '[]'::jsonb),
    'staff', coalesce((select jsonb_agg(jsonb_build_object(
        'staff_id', st.id, 'school_id', st.school_id, 'school_name', s.name, 'role', st.role, 'full_name', st.full_name))
      from public.staff st join public.schools s on s.id = st.school_id
     where st.user_id = auth.uid() and st.status = 'active' and s.status = 'active'), '[]'::jsonb),
    'guardian', exists (select 1 from public.guardians g where g.user_id = auth.uid() and g.status = 'active')
  )
$$;

-- ---------------------------------------------------------------------
-- Tenant onboarding (Busna platform operators)
-- ---------------------------------------------------------------------
create or replace function public.create_school(p_slug text, p_name text, p_owner_email text,
  p_city text default null, p_lat double precision default null, p_lng double precision default null,
  p_primary_color text default '#0E9F6E')
returns public.schools language plpgsql security definer set search_path = '' as $$
declare
  s public.schools;
  v_owner uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not private.is_platform_admin() then
    perform private.fail('forbidden', 'إنشاء المدارس متاح لمشغلي منصة باصنا فقط');
  end if;
  select id into v_owner from auth.users where lower(email) = lower(trim(p_owner_email));
  if v_owner is null then
    perform private.fail('owner_not_found', 'لا يوجد حساب بهذا البريد. يجب أن يسجّل مالك المدرسة أولًا');
  end if;
  insert into public.schools (slug, name, city, lat, lng, primary_color)
  values (lower(trim(p_slug)), trim(p_name), p_city, p_lat, p_lng, p_primary_color)
  returning * into s;
  insert into public.school_members (school_id, user_id, role) values (s.id, v_owner, 'owner');
  insert into public.audit_log (school_id, actor, action, entity, entity_id)
  values (s.id, auth.uid(), 'create', 'schools', s.id::text);
  return s;
end $$;

-- ---------------------------------------------------------------------
-- Parent read models — strictly scoped to the caller's own children.
-- ---------------------------------------------------------------------
create or replace function private.assert_my_student(p_student uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.student_guardians sg
                   join public.guardians g on g.id = sg.guardian_id
                  where sg.student_id = p_student and g.user_id = auth.uid() and g.status = 'active') then
    perform private.fail('forbidden', 'لا يمكنك الاطلاع على بيانات هذا الطالب');
  end if;
end $$;

-- Children + today's trips with transport state. No coordinates here.
create or replace function public.parent_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'student_id', c.id,
      'full_name', c.full_name,
      'grade', c.grade,
      'section', c.section,
      'photo_url', c.photo_url,
      'transport_status', c.transport_status,
      'pickup_label', c.pickup_label,
      'can_track', c.can_track,
      'school', jsonb_build_object('id', c.school_id, 'name', c.school_name, 'logo_url', c.school_logo,
                                   'primary_color', c.school_color, 'timezone', c.school_tz),
      'bus', (select jsonb_build_object('code', b.code, 'plate_number', b.plate_number)
                from public.buses b where b.id = c.bus_id),
      'trips', coalesce((
        select jsonb_agg(jsonb_build_object(
          'trip_id', t.id,
          'name', t.name,
          'period', t.period,
          'status', t.status,
          'scheduled_start', t.scheduled_start,
          'started_at', t.started_at,
          'arrived_at', t.arrived_at,
          'completed_at', t.completed_at,
          'delay_minutes', t.delay_minutes,
          'delay_reason', t.delay_reason,
          'cancel_reason', t.cancel_reason,
          'emergency_active', t.emergency_active,
          'attendance', ts.status,
          'boarded_at', ts.boarded_at,
          'dropped_at', ts.dropped_at,
          'drop_place', ts.drop_place,
          'stop_name', st.name,
          'stop_planned_at', st.planned_at,
          'bus', (select jsonb_build_object('code', b.code, 'plate_number', b.plate_number)
                    from public.buses b where b.id = t.bus_id),
          'driver_name', (select d.full_name from public.staff d where d.id = t.driver_id),
          'supervisor', (select jsonb_build_object('name', sv.full_name, 'phone', sv.phone)
                           from public.staff sv where sv.id = t.supervisor_id),
          'trackable', (ts.status = 'boarded' and t.status in ('started', 'in_progress') and c.can_track)
        ) order by t.scheduled_start)
          from public.trip_students ts
          join public.trips t on t.id = ts.trip_id
          left join public.trip_stops st on st.id = ts.trip_stop_id
         where ts.student_id = c.id
           and t.trip_date = (now() at time zone c.school_tz)::date
      ), '[]'::jsonb)
    ) order by c.full_name)
    from (
      select s.id, s.full_name, s.grade, s.section, s.photo_url, s.transport_status, s.pickup_label, s.bus_id,
             sc.id as school_id, sc.name as school_name, sc.logo_url as school_logo,
             sc.primary_color as school_color, sc.timezone as school_tz,
             bool_or(sg.can_track) as can_track
        from public.students s
        join public.schools sc on sc.id = s.school_id
        join public.student_guardians sg on sg.student_id = s.id
        join public.guardians g on g.id = sg.guardian_id
       where g.user_id = v_uid and g.status = 'active'
       group by s.id, sc.id
    ) c
  ), '[]'::jsonb);
end $$;

-- Live tracking for ONE child. Returns trackable=false (with a reason)
-- unless the child is on board an active trip right now.
create or replace function public.parent_tracking(p_student uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  r record;
  p public.bus_live_positions;
  v_dest_lat double precision;
  v_dest_lng double precision;
  v_dest_label text;
  v_dist double precision;
  v_speed double precision;
begin
  perform private.assert_my_student(p_student);

  select t.*, ts.status as att, ts.boarded_at, s.home_lat, s.home_lng, s.pickup_lat, s.pickup_lng,
         st.lat as stop_lat, st.lng as stop_lng, st.name as stop_name,
         sc.lat as school_lat, sc.lng as school_lng, sc.name as school_name,
         exists (select 1 from public.student_guardians sg join public.guardians g on g.id = sg.guardian_id
                  where sg.student_id = s.id and g.user_id = v_uid and sg.can_track) as can_track
    into r
    from public.trip_students ts
    join public.trips t on t.id = ts.trip_id
    join public.students s on s.id = ts.student_id
    join public.schools sc on sc.id = t.school_id
    left join public.trip_stops st on st.id = ts.trip_stop_id
   where ts.student_id = p_student
     and t.trip_date = (now() at time zone sc.timezone)::date
   order by (t.status in ('started', 'in_progress')) desc, t.scheduled_start desc
   limit 1;

  if r.id is null then
    return jsonb_build_object('trackable', false, 'reason', 'no_trip_today');
  end if;
  if not r.can_track then
    return jsonb_build_object('trackable', false, 'reason', 'tracking_disabled', 'trip_id', r.id);
  end if;
  if r.status not in ('started', 'in_progress') then
    return jsonb_build_object('trackable', false, 'reason',
      case when r.status = 'scheduled' then 'trip_not_started' when r.status = 'cancelled' then 'trip_cancelled' else 'trip_ended' end,
      'trip_id', r.id, 'trip_status', r.status);
  end if;
  if r.att <> 'boarded' then
    return jsonb_build_object('trackable', false, 'reason',
      case r.att when 'pending' then 'not_boarded' when 'absent' then 'absent' else 'dropped' end,
      'trip_id', r.id, 'trip_status', r.status, 'attendance', r.att);
  end if;

  select * into p from public.bus_live_positions where trip_id = r.id;

  if r.period = 'morning' then
    v_dest_lat := coalesce(r.end_lat, r.school_lat); v_dest_lng := coalesce(r.end_lng, r.school_lng);
    v_dest_label := coalesce(r.end_label, r.school_name);
  else
    v_dest_lat := coalesce(r.stop_lat, r.home_lat, r.pickup_lat); v_dest_lng := coalesce(r.stop_lng, r.home_lng, r.pickup_lng);
    v_dest_label := coalesce(r.stop_name, 'المنزل');
  end if;

  v_dist := public.distance_m(p.lat, p.lng, v_dest_lat, v_dest_lng);
  -- Rough estimate from real distance & recent average speed; flagged as
  -- an estimate and omitted when there is no fresh position.
  select avg(speed) into v_speed from (
    select speed from public.bus_locations where trip_id = r.id and speed is not null
     order by recorded_at desc limit 20) x;
  v_speed := greatest(coalesce(v_speed, 0), 5.5);  -- floor ~20 km/h for city traffic

  return jsonb_build_object(
    'trackable', true,
    'trip_id', r.id,
    'trip_status', r.status,
    'period', r.period,
    'boarded_at', r.boarded_at,
    'position', case when p.trip_id is null then null else jsonb_build_object(
        'lat', p.lat, 'lng', p.lng, 'heading', p.heading, 'speed', p.speed, 'recorded_at', p.recorded_at) end,
    'destination', jsonb_build_object('label', v_dest_label, 'lat', v_dest_lat, 'lng', v_dest_lng),
    'distance_m', round(v_dist::numeric),
    'eta_minutes', case when v_dist is null or p.recorded_at < now() - interval '5 minutes' then null
                        else ceil(v_dist * 1.3 / v_speed / 60.0) end,
    'delay_minutes', r.delay_minutes,
    'delay_reason', r.delay_reason,
    'path', coalesce((select jsonb_agg(jsonb_build_array(bl.lng, bl.lat) order by bl.recorded_at)
                        from public.bus_locations bl
                       where bl.trip_id = r.id and bl.recorded_at >= r.boarded_at), '[]'::jsonb)
  );
end $$;

-- ---------------------------------------------------------------------
-- School dashboard KPIs (members only)
-- ---------------------------------------------------------------------
create or replace function public.school_dashboard(p_school uuid, p_date date default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_date date;
  v_late int;
  v_result jsonb;
begin
  if not exists (select 1 from public.school_members where school_id = p_school and user_id = auth.uid())
     and not private.is_platform_admin() then
    perform private.fail('forbidden', 'لا تملك صلاحية الاطلاع على بيانات هذه المدرسة');
  end if;
  v_date := coalesce(p_date, private.school_today(p_school));
  select coalesce((settings ->> 'late_threshold_min')::int, 10) into v_late from public.schools where id = p_school;

  with day_trips as (
    select * from public.trips where school_id = p_school and trip_date = v_date
  ), att as (
    select ts.*, t.period, t.status as trip_status from public.trip_students ts join day_trips t on t.id = ts.trip_id
  )
  select jsonb_build_object(
    'date', v_date,
    'students_total', (select count(*) from public.students where school_id = p_school and transport_status = 'active'),
    'students_on_bus', (select count(distinct student_id) from att where status = 'boarded' and trip_status in ('started', 'in_progress')),
    'students_at_school', (select count(distinct student_id) from att where period = 'morning' and status = 'dropped' and drop_place = 'school'),
    'students_home', (select count(distinct student_id) from att where period = 'afternoon' and status = 'dropped'),
    'students_absent', (select count(distinct student_id) from att where status = 'absent'),
    'trips_total', (select count(*) from day_trips),
    'trips_active', (select count(*) from day_trips where status in ('started', 'in_progress')),
    'trips_completed', (select count(*) from day_trips where status = 'completed'),
    'trips_scheduled', (select count(*) from day_trips where status = 'scheduled'),
    'trips_cancelled', (select count(*) from day_trips where status = 'cancelled'),
    'trips_delayed', (select count(*) from day_trips where status not in ('completed', 'cancelled') and
                       (delay_minutes > 0 or (status = 'scheduled' and now() > scheduled_start + make_interval(mins => v_late)))),
    'trips_not_started_late', (select count(*) from day_trips where status = 'scheduled'
                                and now() > scheduled_start + make_interval(mins => v_late)),
    'emergencies', (select count(*) from day_trips where emergency_active),
    'buses_total', (select count(*) from public.buses where school_id = p_school),
    'buses_available', (select count(*) from public.buses b where b.school_id = p_school and b.status = 'active'
                         and not exists (select 1 from day_trips t where t.bus_id = b.id and t.status in ('started', 'in_progress'))),
    'buses_on_trip', (select count(distinct bus_id) from day_trips where status in ('started', 'in_progress')),
    'buses_stopped', (select count(*) from public.buses where school_id = p_school and status <> 'active'),
    'buses_over_capacity', (select count(*) from public.bus_load where school_id = p_school and over_capacity),
    'drivers', (select count(*) from public.staff where school_id = p_school and role = 'driver' and status = 'active'),
    'supervisors', (select count(*) from public.staff where school_id = p_school and role = 'supervisor' and status = 'active'),
    'open_incidents', (select count(*) from public.incidents where school_id = p_school and status <> 'resolved'),
    'open_requests', (select count(*) from public.parent_requests where school_id = p_school and status in ('open', 'in_review'))
  ) into v_result;
  return v_result;
end $$;

-- ---------------------------------------------------------------------
-- AI action proposals: explicit admin approval executes the change.
-- ---------------------------------------------------------------------
create or replace function public.decide_ai_proposal(p_id uuid, p_approve boolean)
returns public.ai_action_proposals language plpgsql security definer set search_path = '' as $$
declare
  a public.ai_action_proposals;
begin
  select * into a from public.ai_action_proposals where id = p_id for update;
  if not found then perform private.fail('not_found', 'الاقتراح غير موجود'); end if;
  if not exists (select 1 from public.school_members m where m.school_id = a.school_id
                  and m.user_id = auth.uid() and m.role in ('owner', 'admin')) then
    perform private.fail('forbidden', 'الموافقة متاحة لمدير المدرسة فقط');
  end if;
  if a.status <> 'pending' then perform private.fail('already_decided', 'تم اتخاذ قرار بشأن هذا الاقتراح مسبقًا'); end if;

  if not p_approve then
    update public.ai_action_proposals set status = 'rejected', decided_by = auth.uid(), decided_at = now()
     where id = a.id returning * into a;
    return a;
  end if;

  begin
    if a.kind = 'move_student_bus' then
      if not exists (select 1 from public.students where id = (a.payload ->> 'student_id')::uuid and school_id = a.school_id) then
        perform private.fail('not_found', 'الطالب غير موجود');
      end if;
      perform public.transfer_student((a.payload ->> 'student_id')::uuid, (a.payload ->> 'bus_id')::uuid);
    elsif a.kind = 'change_route_driver' then
      update public.routes set driver_id = (a.payload ->> 'driver_id')::uuid
       where id = (a.payload ->> 'route_id')::uuid and school_id = a.school_id;
      if not found then perform private.fail('not_found', 'الرحلة غير موجودة'); end if;
    elsif a.kind = 'change_route_bus' then
      update public.routes set bus_id = (a.payload ->> 'bus_id')::uuid
       where id = (a.payload ->> 'route_id')::uuid and school_id = a.school_id;
      if not found then perform private.fail('not_found', 'الرحلة غير موجودة'); end if;
    end if;
    update public.ai_action_proposals set status = 'approved', decided_by = auth.uid(), decided_at = now()
     where id = a.id returning * into a;
  exception when others then
    update public.ai_action_proposals set status = 'failed', decided_by = auth.uid(), decided_at = now(), error = sqlerrm
     where id = a.id returning * into a;
  end;
  return a;
end $$;

-- ---------------------------------------------------------------------
-- Audit trail for management data
-- ---------------------------------------------------------------------
create or replace function private.audit_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_changes jsonb;
  v_school uuid;
begin
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(k, jsonb_build_object('from', v_old -> k, 'to', v_new -> k)) into v_changes
      from jsonb_object_keys(v_new) k
     where k not in ('updated_at') and (v_old -> k) is distinct from (v_new -> k);
    if v_changes is null then return new; end if;
  else
    v_changes := coalesce(v_new, v_old);
  end if;
  v_school := coalesce((v_new ->> 'school_id')::uuid, (v_old ->> 'school_id')::uuid,
                       case when tg_table_name = 'schools' then coalesce((v_new ->> 'id')::uuid, (v_old ->> 'id')::uuid) end);
  insert into public.audit_log (school_id, actor, action, entity, entity_id, changes)
  values (v_school, auth.uid(), lower(tg_op), tg_table_name,
          coalesce(v_new ->> 'id', v_old ->> 'id', v_new ->> 'student_id', v_old ->> 'student_id'), v_changes);
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['schools','school_members','staff','guardians','buses','students',
                           'student_guardians','routes','route_stops','route_students','incidents','parent_requests']
  loop
    execute format('create trigger %I after insert or update or delete on public.%I
                    for each row execute function private.audit_trigger()', t || '_audit', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke execute on function public.claim_my_records(), public.my_access(), public.parent_overview(),
  public.parent_tracking(uuid), public.school_dashboard(uuid, date), public.decide_ai_proposal(uuid, boolean),
  public.create_school(text, text, text, text, double precision, double precision, text)
  from public, anon;
grant execute on function public.claim_my_records(), public.my_access(), public.parent_overview(),
  public.parent_tracking(uuid), public.school_dashboard(uuid, date), public.decide_ai_proposal(uuid, boolean),
  public.create_school(text, text, text, text, double precision, double precision, text)
  to authenticated, service_role;
grant execute on all functions in schema private to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Realtime (RLS is enforced by Supabase Realtime for postgres_changes)
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.bus_live_positions, public.trips,
      public.trip_students, public.trip_events, public.notifications, public.incidents;
  end if;
end $$;
alter table public.bus_live_positions replica identity full;
alter table public.trips replica identity full;
