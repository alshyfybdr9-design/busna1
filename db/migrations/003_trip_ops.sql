-- =====================================================================
-- عمليات الرحلة: رمز مؤخرة الباص للفحص، وتطبيق الغياب على الرحلات
-- =====================================================================

-- ملصق QR يُثبت في مؤخرة الباص. مسحه أثناء الفحص يثبت أن السائق وصل لآخر الباص
-- (دليل مساعد وليس إثباتًا مستقلًا كاملًا). لا يحتوي بيانات شخصية.
alter table buses add column rear_qr_token text not null unique default encode(gen_random_bytes(12), 'hex');

-- تطبيق طلب غياب معتمد على رحلات اليوم المجدولة/الجارية (الطلاب الذين لم يصعدوا بعد فقط)،
-- أو التراجع عنه عند الإلغاء/الرفض. يسجل حدثًا مستقلًا لكل طالب.
create or replace function app.apply_absence(p_absence uuid) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a absences%rowtype;
  n int := 0;
  r record;
begin
  select * into a from absences where id = p_absence and tenant_id = app.cur_tenant();
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not (app.is_staff() or a.requested_by = app.cur_user()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if a.status = 'approved' then
    for r in
      select tr.id, tr.trip_id, tr.student_id from trip_riders tr join trips t on t.id = tr.trip_id
      where tr.student_id = a.student_id and t.service_date = a.absence_date and t.tenant_id = a.tenant_id
        and t.status in ('scheduled', 'in_progress') and tr.status = 'expected'
        and (a.direction = 'both' or t.direction = a.direction)
    loop
      update trip_riders set status = 'absent' where id = r.id;
      insert into boarding_events (tenant_id, trip_id, trip_rider_id, student_id, type, new_status, source,
                                   client_event_id, recorded_at, recorded_by, reason)
      values (a.tenant_id, r.trip_id, r.id, r.student_id, 'absent', 'absent', 'system',
              gen_random_uuid(), now(), app.cur_user(), 'absence:' || a.id);
      n := n + 1;
    end loop;
  elsif a.status in ('cancelled', 'rejected') then
    for r in
      select tr.id, tr.trip_id, tr.student_id from trip_riders tr join trips t on t.id = tr.trip_id
      where tr.student_id = a.student_id and t.service_date = a.absence_date and t.tenant_id = a.tenant_id
        and t.status = 'scheduled' and tr.status = 'absent'
        and (a.direction = 'both' or t.direction = a.direction)
        and not exists (select 1 from absences a2 where a2.student_id = a.student_id and a2.id <> a.id
                        and a2.absence_date = a.absence_date and a2.status = 'approved'
                        and (a2.direction = 'both' or a2.direction = t.direction))
    loop
      update trip_riders set status = 'expected' where id = r.id;
      insert into boarding_events (tenant_id, trip_id, trip_rider_id, student_id, type, new_status, source,
                                   client_event_id, recorded_at, recorded_by, reason)
      values (a.tenant_id, r.trip_id, r.id, r.student_id, 'correction', 'expected', 'system',
              gen_random_uuid(), now(), app.cur_user(), 'absence_withdrawn:' || a.id);
      n := n + 1;
    end loop;
  end if;
  return n;
end $$;

-- اعتماد تلقائي لطلب غياب قدّمه ولي الأمر إذا كانت سياسة الجهة تسمح بذلك
create or replace function app.auto_approve_absence(p_absence uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  ok boolean;
begin
  select coalesce((t.settings->>'absenceAutoApprove')::boolean, true) into ok
  from tenants t where t.id = app.cur_tenant();
  if not coalesce(ok, false) then return false; end if;
  update absences set status = 'approved', reviewed_at = now()
  where id = p_absence and tenant_id = app.cur_tenant() and requested_by = app.cur_user() and status = 'pending';
  if not found then return false; end if;
  perform app.apply_absence(p_absence);
  return true;
end $$;

-- إلغاء ولي الأمر لطلبه (معلقًا أو معتمدًا) لتاريخ لم يمضِ، مع إرجاع الطالب لقائمة الرحلة إن لم تبدأ
create or replace function app.cancel_own_absence(p_absence uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update absences set status = 'cancelled'
  where id = p_absence and tenant_id = app.cur_tenant() and requested_by = app.cur_user()
    and status in ('pending', 'approved') and absence_date >= current_date;
  if not found then return false; end if;
  perform app.apply_absence(p_absence);
  return true;
end $$;

revoke all on function app.apply_absence(uuid), app.auto_approve_absence(uuid), app.cancel_own_absence(uuid) from public;
grant execute on function app.apply_absence(uuid), app.auto_approve_absence(uuid), app.cancel_own_absence(uuid) to busna_app;

-- رمز إشعارات الجهاز ينتقل للمستخدم الذي سجّل الدخول حاليًا على نفس الجهاز،
-- حتى لا تصل إشعارات مستخدم سابق إلى جهاز لم يعد يستخدمه.
create or replace function app.claim_push_token(p_token text, p_platform text) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into push_tokens (user_id, token, platform) values (app.cur_user(), p_token, p_platform)
  on conflict (token) do update set user_id = excluded.user_id, platform = excluded.platform, last_seen_at = now()
$$;
revoke all on function app.claim_push_token(text, text) from public;
grant execute on function app.claim_push_token(text, text) to busna_app;
