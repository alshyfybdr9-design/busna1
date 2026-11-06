-- =====================================================================
-- Busna — Admin write RPCs that must be atomic
-- =====================================================================

create or replace function private.assert_school_admin(p_school uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.school_members m
                  where m.school_id = p_school and m.user_id = auth.uid() and m.role in ('owner', 'admin')) then
    perform private.fail('forbidden', 'لا تملك صلاحية التعديل في هذه المدرسة');
  end if;
end $$;

-- Saves a recurring route with its ordered stops and students in ONE
-- transaction. p_stops: [{id, name, lat, lng, offset_min}] in order.
-- p_students: [{student_id, stop_id}] (stop_id refers to an id in p_stops).
create or replace function public.save_route(p_school uuid, p_route_id uuid, p_route jsonb, p_stops jsonb, p_students jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := coalesce(p_route_id, gen_random_uuid());
begin
  perform private.assert_school_admin(p_school);
  if p_route_id is not null and not exists (select 1 from public.routes where id = p_route_id and school_id = p_school) then
    perform private.fail('not_found', 'الرحلة غير موجودة');
  end if;
  if coalesce(trim(p_route ->> 'name'), '') = '' then perform private.fail('name_required', 'أدخل اسم الرحلة'); end if;

  insert into public.routes (id, school_id, name, period, bus_id, driver_id, supervisor_id, weekdays, departure_time,
                             start_label, start_lat, start_lng, end_label, end_lat, end_lng, active)
  values (v_id, p_school, trim(p_route ->> 'name'), (p_route ->> 'period')::public.trip_period,
          nullif(p_route ->> 'bus_id', '')::uuid, nullif(p_route ->> 'driver_id', '')::uuid, nullif(p_route ->> 'supervisor_id', '')::uuid,
          array(select jsonb_array_elements_text(p_route -> 'weekdays')::smallint),
          (p_route ->> 'departure_time')::time,
          nullif(p_route ->> 'start_label', ''), (p_route ->> 'start_lat')::double precision, (p_route ->> 'start_lng')::double precision,
          nullif(p_route ->> 'end_label', ''), (p_route ->> 'end_lat')::double precision, (p_route ->> 'end_lng')::double precision,
          coalesce((p_route ->> 'active')::boolean, true))
  on conflict (id) do update set
    name = excluded.name, period = excluded.period, bus_id = excluded.bus_id, driver_id = excluded.driver_id,
    supervisor_id = excluded.supervisor_id, weekdays = excluded.weekdays, departure_time = excluded.departure_time,
    start_label = excluded.start_label, start_lat = excluded.start_lat, start_lng = excluded.start_lng,
    end_label = excluded.end_label, end_lat = excluded.end_lat, end_lng = excluded.end_lng, active = excluded.active;

  -- stops
  delete from public.route_stops where route_id = v_id
     and id not in (select (s ->> 'id')::uuid from jsonb_array_elements(p_stops) s where s ->> 'id' is not null);
  insert into public.route_stops (id, school_id, route_id, seq, name, lat, lng, offset_min)
  select (s.value ->> 'id')::uuid, p_school, v_id, s.ordinality::int, trim(s.value ->> 'name'),
         (s.value ->> 'lat')::double precision, (s.value ->> 'lng')::double precision,
         greatest(coalesce((s.value ->> 'offset_min')::int, 0), 0)
    from jsonb_array_elements(p_stops) with ordinality s
  on conflict (id) do update set seq = excluded.seq, name = excluded.name, lat = excluded.lat,
    lng = excluded.lng, offset_min = excluded.offset_min
  where public.route_stops.route_id = v_id;  -- never touch another route's stop

  -- students (composite FKs reject students of other schools)
  delete from public.route_students where route_id = v_id;
  insert into public.route_students (school_id, route_id, student_id, stop_id)
  select p_school, v_id, (x ->> 'student_id')::uuid, nullif(x ->> 'stop_id', '')::uuid
    from jsonb_array_elements(p_students) x;

  return v_id;
end $$;

-- Resolve / acknowledge a parent request with a reply (admin).
create or replace function public.respond_parent_request(p_id uuid, p_status public.request_status, p_response text)
returns public.parent_requests language plpgsql security definer set search_path = '' as $$
declare r public.parent_requests;
begin
  select * into r from public.parent_requests where id = p_id for update;
  if not found then perform private.fail('not_found', 'الطلب غير موجود'); end if;
  perform private.assert_school_admin(r.school_id);
  update public.parent_requests set status = p_status, response = nullif(trim(p_response), ''),
         handled_by = auth.uid(), handled_at = now()
   where id = p_id returning * into r;
  if r.response is not null then
    insert into public.notifications (school_id, guardian_id, student_id, type, title, body, data)
    values (r.school_id, r.guardian_id, r.student_id, 'request_reply', 'رد المدرسة على طلبك', r.response,
            jsonb_build_object('request_id', r.id));
  end if;
  return r;
end $$;

revoke execute on function public.save_route(uuid, uuid, jsonb, jsonb, jsonb),
  public.respond_parent_request(uuid, public.request_status, text) from public, anon;
grant execute on function public.save_route(uuid, uuid, jsonb, jsonb, jsonb),
  public.respond_parent_request(uuid, public.request_status, text) to authenticated, service_role;
grant execute on all functions in schema private to authenticated, service_role;

-- Bulk import from Excel. Rows: [{student_number, full_name, grade, section,
-- guardian_name, guardian_phone, relation, home_address, pickup_label,
-- pickup_lat, pickup_lng, bus_code}]. All-or-nothing: if any row is invalid
-- nothing is written and the per-row errors are returned.
create or replace function public.import_students(p_school uuid, p_rows jsonb, p_dry_run boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_errors jsonb := '[]'::jsonb;
  v_created int := 0;
  v_updated int := 0;
  v_guardians int := 0;
  v_student uuid;
  v_guardian uuid;
  v_bus uuid;
  v_phone text;
  v_inserted boolean;
begin
  perform private.assert_school_admin(p_school);
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    perform private.fail('empty', 'الملف لا يحتوي على بيانات');
  end if;
  if jsonb_array_length(p_rows) > 5000 then perform private.fail('too_many', 'الحد الأقصى 5000 طالب في الملف الواحد'); end if;

  -- validate
  for r in select x.value as v, x.ordinality as n from jsonb_array_elements(p_rows) with ordinality x loop
    if coalesce(trim(r.v ->> 'student_number'), '') = '' then
      v_errors := v_errors || jsonb_build_object('row', r.n, 'error', 'الرقم المدرسي مطلوب');
    end if;
    if length(coalesce(trim(r.v ->> 'full_name'), '')) < 2 then
      v_errors := v_errors || jsonb_build_object('row', r.n, 'error', 'اسم الطالب مطلوب');
    end if;
    if coalesce(trim(r.v ->> 'guardian_phone'), '') <> ''
       and public.normalize_phone(r.v ->> 'guardian_phone') !~ '^\+[0-9]{9,15}$' then
      v_errors := v_errors || jsonb_build_object('row', r.n, 'error', 'رقم جوال ولي الأمر غير صحيح');
    end if;
    if coalesce(trim(r.v ->> 'bus_code'), '') <> '' and not exists (
        select 1 from public.buses where school_id = p_school and code = trim(r.v ->> 'bus_code')) then
      v_errors := v_errors || jsonb_build_object('row', r.n, 'error', 'الباص "' || trim(r.v ->> 'bus_code') || '" غير موجود');
    end if;
    if (r.v ->> 'pickup_lat') is not null and (r.v ->> 'pickup_lat') !~ '^-?[0-9]+(\.[0-9]+)?$'
       or (r.v ->> 'pickup_lng') is not null and (r.v ->> 'pickup_lng') !~ '^-?[0-9]+(\.[0-9]+)?$' then
      v_errors := v_errors || jsonb_build_object('row', r.n, 'error', 'إحداثيات نقطة الصعود غير صحيحة');
    end if;
  end loop;
  if (select count(*) from (select trim(x ->> 'student_number') k from jsonb_array_elements(p_rows) x group by 1 having count(*) > 1) d) > 0 then
    v_errors := v_errors || jsonb_build_object('row', null, 'error', 'يوجد رقم مدرسي مكرر داخل الملف');
  end if;
  if jsonb_array_length(v_errors) > 0 or p_dry_run then
    return jsonb_build_object('ok', jsonb_array_length(v_errors) = 0, 'errors', v_errors, 'rows', jsonb_array_length(p_rows));
  end if;

  -- write
  for r in select x.value as v from jsonb_array_elements(p_rows) x loop
    v_bus := (select id from public.buses where school_id = p_school and code = nullif(trim(r.v ->> 'bus_code'), ''));
    insert into public.students (school_id, student_number, full_name, grade, section, home_address,
                                 pickup_label, pickup_lat, pickup_lng, bus_id)
    values (p_school, trim(r.v ->> 'student_number'), trim(r.v ->> 'full_name'), nullif(trim(r.v ->> 'grade'), ''),
            nullif(trim(r.v ->> 'section'), ''), nullif(trim(r.v ->> 'home_address'), ''), nullif(trim(r.v ->> 'pickup_label'), ''),
            (r.v ->> 'pickup_lat')::double precision, (r.v ->> 'pickup_lng')::double precision, v_bus)
    on conflict (school_id, student_number) do update set
      full_name = excluded.full_name,
      grade = coalesce(excluded.grade, public.students.grade),
      section = coalesce(excluded.section, public.students.section),
      home_address = coalesce(excluded.home_address, public.students.home_address),
      pickup_label = coalesce(excluded.pickup_label, public.students.pickup_label),
      pickup_lat = coalesce(excluded.pickup_lat, public.students.pickup_lat),
      pickup_lng = coalesce(excluded.pickup_lng, public.students.pickup_lng),
      bus_id = coalesce(excluded.bus_id, public.students.bus_id)
    returning id, (xmax = 0) into v_student, v_inserted;
    if v_inserted then v_created := v_created + 1; else v_updated := v_updated + 1; end if;

    v_phone := public.normalize_phone(nullif(trim(r.v ->> 'guardian_phone'), ''));
    if v_phone is not null then
      insert into public.guardians (school_id, full_name, phone)
      values (p_school, coalesce(nullif(trim(r.v ->> 'guardian_name'), ''), 'ولي أمر ' || split_part(trim(r.v ->> 'full_name'), ' ', 1)), v_phone)
      on conflict (school_id, phone) do update set full_name = coalesce(nullif(trim(r.v ->> 'guardian_name'), ''), public.guardians.full_name)
      returning id, (xmax = 0) into v_guardian, v_inserted;
      if v_inserted then v_guardians := v_guardians + 1; end if;
      insert into public.student_guardians (school_id, student_id, guardian_id, relation, is_primary)
      values (p_school, v_student, v_guardian, coalesce(nullif(trim(r.v ->> 'relation'), ''), 'ولي أمر'), true)
      on conflict (student_id, guardian_id) do nothing;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'created', v_created, 'updated', v_updated, 'guardians_created', v_guardians, 'errors', '[]'::jsonb);
end $$;

revoke execute on function public.import_students(uuid, jsonb, boolean) from public, anon;
grant execute on function public.import_students(uuid, jsonb, boolean) to authenticated, service_role;

-- Owners add dashboard users (by the email they signed up with).
create or replace function public.add_school_member(p_school uuid, p_email text, p_role public.member_role)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid;
begin
  if not exists (select 1 from public.school_members where school_id = p_school and user_id = auth.uid() and role = 'owner') then
    perform private.fail('forbidden', 'إدارة الفريق متاحة لمالك الحساب فقط');
  end if;
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then
    perform private.fail('user_not_found', 'لا يوجد حساب بهذا البريد. اطلب من الشخص إنشاء حساب أولًا ثم أعد المحاولة');
  end if;
  insert into public.school_members (school_id, user_id, role) values (p_school, v_user, p_role)
  on conflict (school_id, user_id) do update set role = excluded.role;
  return jsonb_build_object('user_id', v_user, 'role', p_role);
end $$;

-- Team list with emails (members only).
create or replace function public.list_school_members(p_school uuid)
returns table (user_id uuid, email text, full_name text, role public.member_role, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.school_members sm where sm.school_id = p_school and sm.user_id = auth.uid()) then
    perform private.fail('forbidden', 'غير مصرح');
  end if;
  return query select m.user_id, u.email::text, p.full_name, m.role, m.created_at
    from public.school_members m join auth.users u on u.id = m.user_id left join public.profiles p on p.id = m.user_id
   where m.school_id = p_school order by m.created_at;
end $$;

revoke execute on function public.add_school_member(uuid, text, public.member_role), public.list_school_members(uuid) from public, anon;
grant execute on function public.add_school_member(uuid, text, public.member_role), public.list_school_members(uuid) to authenticated, service_role;
