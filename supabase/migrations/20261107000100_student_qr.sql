-- =====================================================================
-- Busna — Student QR cards
--
-- Every student gets an opaque random token that is printed as a QR code
-- on the student card. The QR carries ONLY that token ("busna:s1:<token>"):
-- no name, school or internal id, so a lost card leaks nothing. An admin
-- can re-issue the token at any time, which invalidates the old card.
--
-- Scanning resolves a token only inside the scanned trip's own school and
-- then goes through the normal record_attendance() rules (role, trip state,
-- allowed transitions, notifications, timeline).
-- =====================================================================

-- Volatile default: evaluated per existing row, so every current student
-- gets its own token when the column is added.
alter table public.students
  add column qr_token text not null default encode(extensions.gen_random_bytes(12), 'hex')
    check (qr_token ~ '^[0-9a-f]{24}$');
alter table public.students add constraint students_school_qr_key unique (school_id, qr_token);

-- Re-issue a student's QR (admin). Unknown student and "not your school"
-- return the same error so the call cannot be used to probe other tenants.
create or replace function public.regenerate_student_qr(p_student uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_school uuid;
  v_token text := encode(extensions.gen_random_bytes(12), 'hex');
begin
  perform private.require_uid();
  select s.school_id into v_school from public.students s
   where s.id = p_student and s.school_id in (select private.admin_school_ids());
  if v_school is null then perform private.fail('not_found', 'الطالب غير موجود'); end if;
  update public.students set qr_token = v_token where id = p_student;
  return v_token;
end $$;

-- Attendance by scanning a student card (driver / supervisor of the trip).
-- p_qr accepts the full QR text ("busna:s1:<token>") or the bare token.
create or replace function public.record_attendance_by_qr(p_trip uuid, p_qr text, p_status public.attendance_status,
  p_lat double precision default null, p_lng double precision default null, p_at timestamptz default null)
returns public.trip_students language plpgsql security definer set search_path = '' as $$
declare
  t public.trips;
  v_token text := lower(regexp_replace(trim(coalesce(p_qr, '')), '^busna:s1:', '', 'i'));
  v_trip_student uuid;
begin
  select * into t from public.trips where id = p_trip;
  if not found then perform private.fail('trip_not_found', 'الرحلة غير موجودة'); end if;
  perform private.trip_role(t, array['driver', 'supervisor']);

  if v_token !~ '^[0-9a-f]{24}$' then
    perform private.fail('invalid_qr', 'رمز البطاقة غير صحيح أو تم إلغاؤه');
  end if;

  select ts.id into v_trip_student
    from public.trip_students ts
    join public.students s on s.id = ts.student_id
   where ts.trip_id = t.id and s.school_id = t.school_id and s.qr_token = v_token;

  if v_trip_student is null then
    if exists (select 1 from public.students s where s.school_id = t.school_id and s.qr_token = v_token) then
      perform private.fail('student_not_on_trip', 'الطالب غير مسجّل في هذه الرحلة');
    end if;
    perform private.fail('invalid_qr', 'رمز البطاقة غير صحيح أو تم إلغاؤه');
  end if;

  return public.record_attendance(v_trip_student, p_status, p_lat, p_lng, p_at);
end $$;

revoke execute on function public.regenerate_student_qr(uuid),
  public.record_attendance_by_qr(uuid, text, public.attendance_status, double precision, double precision, timestamptz)
  from public, anon;
grant execute on function public.regenerate_student_qr(uuid),
  public.record_attendance_by_qr(uuid, text, public.attendance_status, double precision, double precision, timestamptz)
  to authenticated, service_role;
