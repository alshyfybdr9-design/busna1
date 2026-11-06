-- =====================================================================
-- Busna — security & trip-flow tests (run by supabase/tests/run.sh)
-- Each block switches to the `authenticated` role with a real user's JWT
-- claims, so RLS and RPC authorization are exercised exactly as in prod.
-- =====================================================================
\set ON_ERROR_STOP on
\set QUIET on

create schema tests;
grant usage on schema tests to authenticated, anon;

create function tests.login(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, false);
$$;

create function tests.expect_error(p_sql text, p_code text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm not like p_code || '%' and sqlstate <> p_code then
      raise exception 'expected error "%" but got "%" (%) for: %', p_code, sqlerrm, sqlstate, p_sql;
    end if;
    return;
  end;
  raise exception 'expected error "%" but statement succeeded: %', p_code, p_sql;
end $$;

create function tests.trip(p_route uuid) returns uuid language sql stable security definer set search_path = '' as $$
  select id from public.trips where route_id = p_route and trip_date = (now() at time zone 'Asia/Riyadh')::date
$$;
create function tests.ts(p_route uuid, p_student uuid) returns uuid language sql stable security definer set search_path = '' as $$
  select ts.id from public.trip_students ts join public.trips t on t.id = ts.trip_id
   where t.route_id = p_route and ts.student_id = p_student and t.trip_date = (now() at time zone 'Asia/Riyadh')::date
$$;
create function tests.count_notifications(p_type text, p_student uuid) returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.notifications where type = p_type and student_id = p_student
$$;
create function tests.pt(p_lat double precision, p_lng double precision, p_ago_s int default 0) returns jsonb language sql stable as $$
  select jsonb_build_object('lat', p_lat, 'lng', p_lng, 'speed', 8.3, 'heading', 90, 'accuracy', 10,
                            't', to_char((now() - make_interval(secs => p_ago_s)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
$$;
grant execute on all functions in schema tests to authenticated, anon;

-- Named users / ids
\set owner_a     '''10000000-0000-4000-8000-000000000001'''
\set viewer_a    '''10000000-0000-4000-8000-000000000007'''
\set driver1     '''10000000-0000-4000-8000-000000000002'''
\set driver2     '''10000000-0000-4000-8000-000000000003'''
\set sup1        '''10000000-0000-4000-8000-000000000004'''
\set parent1     '''10000000-0000-4000-8000-000000000005'''
\set parent2     '''10000000-0000-4000-8000-000000000006'''
\set owner_b     '''20000000-0000-4000-8000-000000000001'''
\set parent_b    '''20000000-0000-4000-8000-000000000003'''

\echo '▶ sanity: today''s trips were generated'
do $$ begin
  assert (select count(*) from public.trips) = 4, 'expected 4 trips today (3 school A + 1 school B)';
  assert (select count(*) from public.trip_students where trip_id = tests.trip('a5000000-0000-4000-8000-000000000001')) = 5;
end $$;

-- ---------------------------------------------------------------------
\echo '▶ anon sees nothing and cannot call RPCs'
set role anon;
select tests.expect_error('select count(*) from public.students', '42501');
select tests.expect_error('select public.parent_overview()', '42501');
reset role;

-- ---------------------------------------------------------------------
\echo '▶ tenant isolation: school A owner'
select tests.login(:owner_a); set role authenticated;
do $$ begin
  assert (select count(*) from public.schools) = 1, 'owner A must see only school A';
  assert (select count(*) from public.students) = 8, 'owner A sees 8 students';
  assert not exists (select 1 from public.students where school_id = 'b0000000-0000-4000-8000-000000000001');
  assert not exists (select 1 from public.trips where school_id = 'b0000000-0000-4000-8000-000000000001');
  assert not exists (select 1 from public.buses where school_id = 'b0000000-0000-4000-8000-000000000001');
  assert (select count(*) from public.trips) = 3;
end $$;
-- cannot write into school B
select tests.expect_error($q$insert into public.students (school_id, student_number, full_name)
  values ('b0000000-0000-4000-8000-000000000001', 'X1', 'طالب دخيل')$q$, '42501');
-- cannot reference school B's bus from a school A student (composite FK)
select tests.expect_error($q$update public.students set bus_id = 'b2000000-0000-4000-8000-000000000001'
  where id = 'a4000000-0000-4000-8000-000000000001'$q$, '23503');
-- cannot move own row to another tenant
select tests.expect_error($q$update public.buses set school_id = 'b0000000-0000-4000-8000-000000000001'
  where id = 'a2000000-0000-4000-8000-000000000001'$q$, '42501');
-- cannot read school B dashboard
select tests.expect_error($q$select public.school_dashboard('b0000000-0000-4000-8000-000000000001')$q$, 'forbidden');
-- cannot write trips directly
select tests.expect_error($q$update public.trips set status = 'completed'$q$, '42501');
-- can manage own data
do $$ begin
  insert into public.students (school_id, student_number, full_name, grade)
  values ('a0000000-0000-4000-8000-000000000001', '24999', 'طالب تجريبي', 'الأول الابتدائي');
  delete from public.students where student_number = '24999';
  assert (select (public.school_dashboard('a0000000-0000-4000-8000-000000000001') ->> 'students_total')::int) = 8;
end $$;
-- slug/status are platform-only
select tests.expect_error($q$update public.schools set status = 'suspended'$q$, '42501');
reset role;

\echo '▶ tenant isolation: school B owner'
select tests.login(:owner_b); set role authenticated;
do $$ begin
  assert (select count(*) from public.students) = 1;
  assert (select count(*) from public.guardians) = 1;
  assert (select count(*) from public.notifications) = 0;
end $$;
select tests.expect_error($q$select public.transfer_student('a4000000-0000-4000-8000-000000000001', null)$q$, 'forbidden');
reset role;

\echo '▶ viewer is read-only'
select tests.login(:viewer_a); set role authenticated;
do $$ begin assert (select count(*) from public.students) = 8; end $$;
select tests.expect_error($q$insert into public.buses (school_id, code, plate_number, capacity)
  values ('a0000000-0000-4000-8000-000000000001', 'باص 9', 'س س س 1', 10)$q$, '42501');
do $$ begin
  update public.students set full_name = 'تعديل' where id = 'a4000000-0000-4000-8000-000000000001';
  assert not found, 'viewer update must affect 0 rows';
end $$;
reset role;

-- ---------------------------------------------------------------------
\echo '▶ parent scope'
select tests.login(:parent1); set role authenticated;
do $$ begin
  assert (select count(*) from public.students) = 2, 'parent1 sees exactly 2 children';
  assert jsonb_array_length(public.parent_overview()) = 2;
  assert (select count(*) from public.trip_stops) = 0, 'parents cannot list stops (other children''s pickup points)';
  assert (select count(*) from public.trip_events) = 0, 'parents cannot read trip timelines';
  assert (select count(*) from public.trip_students) = 4, '2 children x 2 trips';
  assert (select count(*) from public.guardians) = 1, 'only own guardian record';
  assert (select count(*) from public.staff) = 0;
end $$;
select tests.expect_error($q$select public.parent_tracking('a4000000-0000-4000-8000-000000000003')$q$, 'forbidden');
select tests.expect_error($q$select public.school_dashboard('a0000000-0000-4000-8000-000000000001')$q$, 'forbidden');
-- requests: own child ok, other child rejected
insert into public.parent_requests (school_id, guardian_id, student_id, kind, body)
values ('a0000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001',
        'a4000000-0000-4000-8000-000000000001', 'pickup_change', 'أرغب بتغيير نقطة الصعود إلى بوابة 2');
select tests.expect_error($q$insert into public.parent_requests (school_id, guardian_id, student_id, kind, body)
  values ('a0000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001',
          'a4000000-0000-4000-8000-000000000003', 'complaint', 'x')$q$, '42501');
do $$ begin
  assert (public.parent_tracking('a4000000-0000-4000-8000-000000000001') ->> 'reason') = 'trip_not_started';
end $$;
reset role;

-- ---------------------------------------------------------------------
\echo '▶ driver scope & start_trip authorization'
select tests.login(:driver2); set role authenticated;
do $$ begin
  assert (select count(*) from public.trips) = 1, 'driver2 sees only own trip';
  assert (select count(*) from public.guardians) = 0, 'drivers cannot read guardian records';
end $$;
select tests.expect_error(format('select public.start_trip(%L)', tests.trip('a5000000-0000-4000-8000-000000000001')), 'not_assigned');
reset role;

select tests.login(:sup1); set role authenticated;
select tests.expect_error(format('select public.start_trip(%L)', tests.trip('a5000000-0000-4000-8000-000000000001')), 'not_assigned');
select tests.expect_error(format('select public.record_attendance(%L, ''boarded'')',
  tests.ts('a5000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001')), 'trip_not_started');
reset role;

select tests.login(:driver1); set role authenticated;
select tests.expect_error(format('select public.push_locations(%L, %L)', tests.trip('a5000000-0000-4000-8000-000000000001'),
  jsonb_build_array(tests.pt(24.84, 46.655))), 'trip_not_active');
do $$ declare t public.trips; begin
  t := public.start_trip(tests.trip('a5000000-0000-4000-8000-000000000001'), 24.8400, 46.6550);
  assert t.status = 'started';
  assert t.started_by = auth.uid();
end $$;
select tests.expect_error(format('select public.start_trip(%L)', tests.trip('a5000000-0000-4000-8000-000000000001')), 'invalid_state');
-- second active trip for the same driver is refused
select tests.expect_error(format('select public.start_trip(%L)', tests.trip('a5000000-0000-4000-8000-000000000002')), 'driver_busy');
reset role;

do $$ begin
  assert tests.count_notifications('trip_started', 'a4000000-0000-4000-8000-000000000001') = 1;
end $$;

\echo '▶ parent cannot see the bus before the child boards'
select tests.login(:parent1); set role authenticated;
do $$ begin
  assert (select count(*) from public.bus_live_positions) = 0, 'no live position before boarding';
  assert (select count(*) from public.bus_locations) = 0;
  assert (public.parent_tracking('a4000000-0000-4000-8000-000000000001') ->> 'reason') = 'not_boarded';
end $$;
reset role;

\echo '▶ driver publishes locations; approach notification fires once'
select tests.login(:driver1); set role authenticated;
do $$ declare r jsonb; begin
  r := public.push_locations(tests.trip('a5000000-0000-4000-8000-000000000001'), jsonb_build_array(
         tests.pt(24.8410, 46.6570, 30), tests.pt(24.8430, 46.6600, 20),
         tests.pt(999, 46.66, 10),                 -- junk point: dropped
         tests.pt(24.8445, 46.6615, 5)));
  assert (r ->> 'accepted')::int = 3, 'junk points must be dropped: ' || r::text;
  assert (r ->> 'status') = 'in_progress';
  -- replay of the same batch (offline retry) must not re-notify
  perform public.push_locations(tests.trip('a5000000-0000-4000-8000-000000000001'), jsonb_build_array(tests.pt(24.8446, 46.6616, 1)));
end $$;
reset role;
do $$ begin
  assert tests.count_notifications('bus_approaching', 'a4000000-0000-4000-8000-000000000001') = 1, 'approach notified once';
  assert tests.count_notifications('bus_approaching', 'a4000000-0000-4000-8000-000000000004') = 0, 'far student not notified yet';
end $$;

\echo '▶ boarding unlocks tracking for that parent only'
select tests.login(:driver1); set role authenticated;
do $$ declare ts public.trip_students; begin
  ts := public.record_attendance(tests.ts('a5000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001'), 'boarded', 24.8450, 46.6620);
  assert ts.status = 'boarded' and ts.boarded_at is not null and ts.boarded_lat is not null;
  -- idempotent double tap
  ts := public.record_attendance(ts.id, 'boarded');
  perform public.record_attendance(tests.ts('a5000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000002'), 'boarded', 24.8450, 46.6620);
end $$;
-- next GPS fix, after boarding (separate transaction, like a real device)
select public.push_locations(tests.trip('a5000000-0000-4000-8000-000000000001'), jsonb_build_array(tests.pt(24.8470, 46.6680, 0))) is not null as pushed;
select tests.expect_error(format('select public.record_attendance(%L, ''dropped'')',
  tests.ts('a5000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000003')), 'invalid_transition');
reset role;

select tests.login(:parent1); set role authenticated;
do $$ declare r jsonb; begin
  assert (select count(*) from public.bus_live_positions) = 1, 'parent1 now sees the bus';
  r := public.parent_tracking('a4000000-0000-4000-8000-000000000001');
  assert (r ->> 'trackable')::boolean, r::text;
  assert (r -> 'position' ->> 'lat') is not null;
  -- breadcrumbs only since boarding (the 3 pre-boarding points are hidden)
  assert jsonb_array_length(r -> 'path') = 1, 'path must start at boarding: ' || (r -> 'path')::text;
  assert (select count(*) from public.bus_locations) = 1;
end $$;
reset role;

select tests.login(:parent2); set role authenticated;
do $$ begin
  assert (select count(*) from public.bus_live_positions) = 0, 'parent2''s child is not on board';
  assert (public.parent_tracking('a4000000-0000-4000-8000-000000000003') ->> 'trackable')::boolean = false;
end $$;
reset role;

select tests.login(:parent_b); set role authenticated;
do $$ begin
  assert (select count(*) from public.bus_live_positions) = 0;
  assert (select count(*) from public.notifications) = 0;
end $$;
reset role;

\echo '▶ supervisor: attendance + contacts; driver cannot read contacts'
select tests.login(:sup1); set role authenticated;
do $$ begin
  perform public.record_attendance(tests.ts('a5000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000003'), 'absent');
  perform public.record_attendance(tests.ts('a5000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000004'), 'boarded', 24.852, 46.66);
  assert (select count(*) from public.get_trip_contacts(tests.trip('a5000000-0000-4000-8000-000000000001'))) >= 4;
  perform public.add_trip_note(tests.trip('a5000000-0000-4000-8000-000000000001'), 'ازدحام عند دوار النرجس');
end $$;
reset role;
select tests.login(:driver1); set role authenticated;
select tests.expect_error(format('select * from public.get_trip_contacts(%L)', tests.trip('a5000000-0000-4000-8000-000000000001')), 'not_assigned');

\echo '▶ end_trip refuses while students are on board'
select tests.expect_error(format('select public.end_trip(%L)', tests.trip('a5000000-0000-4000-8000-000000000001')), 'students_on_board');

\echo '▶ arrival at school checks everyone in; trip still open'
do $$ declare r jsonb; t public.trips; begin
  r := public.arrive_trip(tests.trip('a5000000-0000-4000-8000-000000000001'), 24.8105, 46.6152);
  assert (r ->> 'dropped')::int = 3, r::text;
  select * into t from public.trips where id = tests.trip('a5000000-0000-4000-8000-000000000001');
  assert t.status = 'in_progress' and t.arrived_kind = 'school';
end $$;
-- one student (لمى) was never picked up
select tests.expect_error(format('select public.end_trip(%L)', tests.trip('a5000000-0000-4000-8000-000000000001')), 'students_pending');
do $$ declare t public.trips; begin
  t := public.end_trip(tests.trip('a5000000-0000-4000-8000-000000000001'), 24.8105, 46.6152, true);
  assert t.status = 'completed' and t.completed_by = auth.uid();
end $$;
select tests.expect_error(format('select public.push_locations(%L, %L)', tests.trip('a5000000-0000-4000-8000-000000000001'),
  jsonb_build_array(tests.pt(24.81, 46.615))), 'trip_not_active');
reset role;

do $$ begin
  assert not exists (select 1 from public.bus_live_positions), 'live position removed at trip end';
  assert tests.count_notifications('student_arrived_school', 'a4000000-0000-4000-8000-000000000001') = 1;
  assert tests.count_notifications('student_absent', 'a4000000-0000-4000-8000-000000000005') = 1;
  assert tests.count_notifications('student_absent', 'a4000000-0000-4000-8000-000000000003') = 1;
  assert (select count(*) from public.trip_events where trip_id = tests.trip('a5000000-0000-4000-8000-000000000001')) = 12, 'every action is on the timeline';
end $$;

select tests.login(:parent1); set role authenticated;
do $$ begin
  assert (select count(*) from public.bus_live_positions) = 0;
  assert (select count(*) from public.bus_locations) = 0, 'history hidden once the trip ends';
  assert (public.parent_tracking('a4000000-0000-4000-8000-000000000001') ->> 'trackable')::boolean = false;
  assert (select count(*) from public.notifications where student_id = 'a4000000-0000-4000-8000-000000000001') >= 4;
  update public.notifications set read_at = now() where student_id = 'a4000000-0000-4000-8000-000000000001';
end $$;
select tests.expect_error($q$update public.notifications set body = 'x'$q$, '42501');
reset role;

\echo '▶ delay, incident & emergency; cancel is admin-only'
select tests.login(:driver2); set role authenticated;
do $$ begin
  perform public.start_trip(tests.trip('a5000000-0000-4000-8000-000000000003'));
  perform public.report_delay(tests.trip('a5000000-0000-4000-8000-000000000003'), 15, 'ازدحام على طريق أنس بن مالك');
  perform public.record_attendance(tests.ts('a5000000-0000-4000-8000-000000000003', 'a4000000-0000-4000-8000-000000000006'), 'boarded');
  perform public.report_incident(tests.trip('a5000000-0000-4000-8000-000000000003'), 'breakdown', 'critical', 'عطل في المكابح', 24.82, 46.62);
end $$;
select tests.expect_error(format('select public.cancel_trip(%L, ''x'')', tests.trip('a5000000-0000-4000-8000-000000000003')), 'not_assigned');
reset role;
do $$ begin
  assert (select emergency_active from public.trips where id = tests.trip('a5000000-0000-4000-8000-000000000003'));
  assert (select count(*) from public.notifications where type = 'trip_delayed') = 2, 'one per guardian of pending/boarded (student 008 has none)';
  assert (select count(*) from public.notifications where type = 'trip_issue') = 1, 'only guardians of boarded students';
  assert (select count(*) from public.notifications where type = 'incident' and recipient_user_id = '10000000-0000-4000-8000-000000000001') = 1;
end $$;

select tests.login(:owner_a); set role authenticated;
do $$ declare d jsonb; begin
  d := public.school_dashboard('a0000000-0000-4000-8000-000000000001');
  assert (d ->> 'trips_active')::int = 1, d::text;
  assert (d ->> 'students_on_bus')::int = 1, d::text;
  assert (d ->> 'students_at_school')::int = 3, d::text;
  assert (d ->> 'emergencies')::int = 1, d::text;
  assert (d ->> 'buses_stopped')::int = 1, d::text;
  assert (d ->> 'open_requests')::int = 1, d::text;
  assert (select count(*) from public.audit_log) > 0;
end $$;
select tests.expect_error(format('select public.cancel_trip(%L, ''عطل'')', tests.trip('a5000000-0000-4000-8000-000000000003')), 'students_on_board');
do $$ begin
  perform public.cancel_trip(tests.trip('a5000000-0000-4000-8000-000000000002'), 'إجازة طارئة');
  assert (select status from public.trips where id = tests.trip('a5000000-0000-4000-8000-000000000002')) = 'cancelled';
end $$;
reset role;

\echo '▶ AI proposals require explicit admin approval'
select tests.login(:owner_a); set role authenticated;
do $$ declare p public.ai_action_proposals; begin
  insert into public.ai_action_proposals (school_id, created_by, kind, summary, payload)
  values ('a0000000-0000-4000-8000-000000000001', auth.uid(), 'move_student_bus', 'نقل فيصل إلى باص 1',
          jsonb_build_object('student_id', 'a4000000-0000-4000-8000-000000000008', 'bus_id', 'a2000000-0000-4000-8000-000000000001'))
  returning * into p;
  assert (select bus_id from public.students where id = 'a4000000-0000-4000-8000-000000000008') = 'a2000000-0000-4000-8000-000000000002',
    'nothing changes before approval';
  p := public.decide_ai_proposal(p.id, true);
  assert p.status = 'approved', coalesce(p.error, p.status);
  assert (select bus_id from public.students where id = 'a4000000-0000-4000-8000-000000000008') = 'a2000000-0000-4000-8000-000000000001';
  assert exists (select 1 from public.route_students where student_id = 'a4000000-0000-4000-8000-000000000008'
                  and route_id = 'a5000000-0000-4000-8000-000000000001');
end $$;
reset role;
select tests.login(:viewer_a); set role authenticated;
select tests.expect_error($q$insert into public.ai_action_proposals (school_id, created_by, kind, summary, payload)
  values ('a0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000007', 'change_route_bus', 'x', '{}')$q$, '42501');
reset role;

\echo '▶ account linking by verified phone'
insert into auth.users (id, phone, phone_confirmed_at) values ('30000000-0000-4000-8000-000000000001', '966553332211', now());
insert into auth.users (id, phone) values ('30000000-0000-4000-8000-000000000002', '966557778899');  -- unverified
select tests.login('30000000-0000-4000-8000-000000000001'); set role authenticated;
do $$ declare r jsonb; begin
  assert (select count(*) from public.students) = 0;
  r := public.claim_my_records();
  assert (r ->> 'guardians_linked')::int = 1, r::text;
  assert (select count(*) from public.students) = 2, 'sees both children after linking';
end $$;
reset role;
select tests.login('30000000-0000-4000-8000-000000000002'); set role authenticated;
do $$ declare r jsonb; begin
  r := public.claim_my_records();
  assert (r ->> 'guardians_linked')::int = 0, 'unverified phone must not link';
end $$;
reset role;

\echo '▶ platform onboarding'
select tests.login(:owner_a); set role authenticated;
select tests.expect_error($q$select public.create_school('new-school', 'مدرسة جديدة', 'admin@alrowad.sa')$q$, 'forbidden');
reset role;
select tests.login('90000000-0000-4000-8000-000000000001'); set role authenticated;
do $$ declare s public.schools; begin
  s := public.create_school('al-fajr', 'مدارس الفجر', 'admin@alrowad.sa', 'الدمام');
  assert s.slug = 'al-fajr';
end $$;
reset role;
select tests.login(:owner_a); set role authenticated;
do $$ begin
  assert jsonb_array_length(public.my_access() -> 'schools') = 2, 'owner now has two schools';
end $$;
reset role;

\echo '✔ all Busna database tests passed'
