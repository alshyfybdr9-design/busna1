-- =====================================================================
-- Busna — Reports (aggregated server-side; members of the school only)
-- p_kind: attendance | trips | delays | drivers | buses | absences | incidents | punctuality
-- Returns a JSON array of flat rows (column order = key order).
-- =====================================================================
create or replace function public.school_report(p_school uuid, p_kind text, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz text;
  v_late int;
  v_school_start time;
  v_rows jsonb;
begin
  if not exists (select 1 from public.school_members where school_id = p_school and user_id = auth.uid()) then
    perform private.fail('forbidden', 'لا تملك صلاحية الاطلاع على تقارير هذه المدرسة');
  end if;
  if p_to < p_from or p_to - p_from > 370 then perform private.fail('invalid_range', 'الفترة غير صحيحة (الحد الأقصى سنة)'); end if;
  select timezone, coalesce((settings ->> 'late_threshold_min')::int, 10), coalesce((settings ->> 'school_start_time')::time, '07:00')
    into v_tz, v_late, v_school_start from public.schools where id = p_school;

  if p_kind = 'attendance' then
    select jsonb_agg(r order by r ->> 'الطالب') into v_rows from (
      select jsonb_build_object(
        'الطالب', s.full_name, 'الرقم المدرسي', s.student_number, 'الصف', coalesce(s.grade, ''),
        'عدد الرحلات', count(*), 'صعد', count(*) filter (where ts.status in ('boarded', 'dropped')),
        'غائب', count(*) filter (where ts.status = 'absent'),
        'نسبة الحضور %', round(100.0 * count(*) filter (where ts.status in ('boarded', 'dropped')) / nullif(count(*) filter (where t.status <> 'cancelled'), 0), 1)) r
        from public.trip_students ts join public.trips t on t.id = ts.trip_id join public.students s on s.id = ts.student_id
       where t.school_id = p_school and t.trip_date between p_from and p_to and t.status = 'completed'
       group by s.id) x;

  elsif p_kind = 'trips' then
    select jsonb_agg(r order by r ->> 'التاريخ', r ->> 'الانطلاق المجدول') into v_rows from (
      select jsonb_build_object(
        'التاريخ', t.trip_date, 'الرحلة', t.name, 'الفترة', case t.period when 'morning' then 'صباحية' else 'مسائية' end,
        'الباص', coalesce(b.code, ''), 'السائق', coalesce(d.full_name, ''),
        'الحالة', case t.status when 'completed' then 'مكتملة' when 'cancelled' then 'ملغاة' when 'scheduled' then 'لم تبدأ' else 'جارية' end,
        'الانطلاق المجدول', to_char(t.scheduled_start at time zone v_tz, 'HH24:MI'),
        'البدء الفعلي', coalesce(to_char(t.started_at at time zone v_tz, 'HH24:MI'), ''),
        'الوصول', coalesce(to_char(t.arrived_at at time zone v_tz, 'HH24:MI'), ''),
        'الانتهاء', coalesce(to_char(t.completed_at at time zone v_tz, 'HH24:MI'), ''),
        'الطلاب', (select count(*) from public.trip_students where trip_id = t.id),
        'صعدوا', (select count(*) from public.trip_students where trip_id = t.id and status in ('boarded', 'dropped')),
        'غائبون', (select count(*) from public.trip_students where trip_id = t.id and status = 'absent')) r
        from public.trips t left join public.buses b on b.id = t.bus_id left join public.staff d on d.id = t.driver_id
       where t.school_id = p_school and t.trip_date between p_from and p_to) x;

  elsif p_kind = 'delays' then
    select jsonb_agg(r order by (r ->> 'دقائق التأخير')::int desc) into v_rows from (
      select jsonb_build_object(
        'التاريخ', t.trip_date, 'الرحلة', t.name, 'الباص', coalesce(b.code, ''), 'السائق', coalesce(d.full_name, ''),
        'دقائق التأخير', greatest(t.delay_minutes, coalesce(floor(extract(epoch from (t.started_at - t.scheduled_start)) / 60)::int, 0)),
        'تأخر البدء (د)', coalesce(floor(extract(epoch from (t.started_at - t.scheduled_start)) / 60)::int, 0),
        'السبب', coalesce(t.delay_reason, case when t.started_at is null then 'لم تبدأ' else 'بدء متأخر' end)) r
        from public.trips t left join public.buses b on b.id = t.bus_id left join public.staff d on d.id = t.driver_id
       where t.school_id = p_school and t.trip_date between p_from and p_to and t.status <> 'cancelled'
         and (t.delay_minutes > 0 or t.started_at > t.scheduled_start + make_interval(mins => v_late)
              or (t.started_at is null and t.scheduled_start < now() - make_interval(mins => v_late)))) x;

  elsif p_kind = 'drivers' then
    select jsonb_agg(r order by r ->> 'السائق') into v_rows from (
      select jsonb_build_object(
        'السائق', d.full_name, 'الرحلات المجدولة', count(t.id),
        'المكتملة', count(t.id) filter (where t.status = 'completed'),
        'بدء في الموعد %', round(100.0 * count(t.id) filter (where t.started_at <= t.scheduled_start + make_interval(mins => v_late))
                                 / nullif(count(t.id) filter (where t.started_at is not null), 0), 1),
        'متوسط تأخر البدء (د)', round(avg(greatest(extract(epoch from (t.started_at - t.scheduled_start)) / 60, 0))::numeric, 1),
        'البلاغات', (select count(*) from public.incidents i where i.school_id = p_school and i.trip_id in (
                        select id from public.trips where driver_id = d.id and trip_date between p_from and p_to))) r
        from public.staff d left join public.trips t on t.driver_id = d.id and t.trip_date between p_from and p_to and t.status <> 'cancelled'
       where d.school_id = p_school and d.role = 'driver'
       group by d.id) x;

  elsif p_kind = 'buses' then
    select jsonb_agg(r order by r ->> 'الباص') into v_rows from (
      select jsonb_build_object(
        'الباص', b.code, 'اللوحة', b.plate_number, 'السعة', b.capacity,
        'الرحلات', count(distinct t.id),
        'متوسط الركاب', round(avg(x.riders)::numeric, 1),
        'متوسط الإشغال %', round(100.0 * avg(x.riders) / b.capacity, 1),
        'أعلى عدد ركاب', coalesce(max(x.riders), 0)) r
        from public.buses b
        left join public.trips t on t.bus_id = b.id and t.trip_date between p_from and p_to and t.status = 'completed'
        left join lateral (select count(*) filter (where status in ('boarded', 'dropped')) riders
                             from public.trip_students where trip_id = t.id) x on t.id is not null
       where b.school_id = p_school
       group by b.id) y;

  elsif p_kind = 'absences' then
    select jsonb_agg(r order by r ->> 'التاريخ' desc, r ->> 'الطالب') into v_rows from (
      select jsonb_build_object(
        'التاريخ', t.trip_date, 'الطالب', s.full_name, 'الصف', coalesce(s.grade, ''),
        'الرحلة', t.name, 'الفترة', case t.period when 'morning' then 'صباحية' else 'مسائية' end,
        'وقت التسجيل', coalesce(to_char(ts.absent_at at time zone v_tz, 'HH24:MI'), '')) r
        from public.trip_students ts join public.trips t on t.id = ts.trip_id join public.students s on s.id = ts.student_id
       where t.school_id = p_school and t.trip_date between p_from and p_to and ts.status = 'absent') x;

  elsif p_kind = 'incidents' then
    select jsonb_agg(r order by r ->> 'الوقت' desc) into v_rows from (
      select jsonb_build_object(
        'الوقت', to_char(i.created_at at time zone v_tz, 'YYYY-MM-DD HH24:MI'), 'الرحلة', coalesce(t.name, ''), 'الباص', coalesce(b.code, ''),
        'النوع', case i.category when 'breakdown' then 'عطل' when 'accident' then 'حادث' when 'traffic' then 'ازدحام'
                   when 'student_behavior' then 'سلوك طالب' when 'medical' then 'صحية' else 'أخرى' end,
        'الخطورة', case i.severity when 'low' then 'منخفضة' when 'medium' then 'متوسطة' when 'high' then 'عالية' else 'طارئة' end,
        'المبلّغ', case i.reporter_role when 'driver' then 'السائق' when 'supervisor' then 'المشرف' else 'الإدارة' end,
        'الوصف', i.description,
        'الحالة', case i.status when 'open' then 'مفتوح' when 'acknowledged' then 'قيد المتابعة' else 'تم الحل' end) r
        from public.incidents i left join public.trips t on t.id = i.trip_id left join public.buses b on b.id = i.bus_id
       where i.school_id = p_school and (i.created_at at time zone v_tz)::date between p_from and p_to) x;

  elsif p_kind = 'punctuality' then
    -- Morning trips: arrival at school before the school start time.
    select jsonb_agg(r order by r ->> 'الرحلة') into v_rows from (
      select jsonb_build_object(
        'الرحلة', t.name, 'الباص', coalesce(max(b.code), ''),
        'رحلات وصلت', count(*) filter (where t.arrived_at is not null),
        'وصلت قبل بداية الدوام', count(*) filter (where (t.arrived_at at time zone v_tz)::time <= v_school_start),
        'نسبة الالتزام %', round(100.0 * count(*) filter (where (t.arrived_at at time zone v_tz)::time <= v_school_start)
                                  / nullif(count(*) filter (where t.arrived_at is not null), 0), 1),
        'متوسط وقت الوصول', coalesce(to_char(make_time(0, 0, 0) + avg((t.arrived_at at time zone v_tz)::time - make_time(0, 0, 0)), 'HH24:MI'), '')) r
        from public.trips t left join public.buses b on b.id = t.bus_id
       where t.school_id = p_school and t.trip_date between p_from and p_to and t.period = 'morning' and t.status = 'completed'
       group by t.route_id, t.name) x;
  else
    perform private.fail('unknown_report', 'نوع التقرير غير معروف');
  end if;

  return coalesce(v_rows, '[]'::jsonb);
end $$;

revoke execute on function public.school_report(uuid, text, date, date) from public, anon;
grant execute on function public.school_report(uuid, text, date, date) to authenticated, service_role;
