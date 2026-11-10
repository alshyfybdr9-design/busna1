-- =====================================================================
-- ميزات ولي الأمر والسلامة:
--  1) تنبيه «الباص اقترب» بمسافة يحددها ولي الأمر
--  2) رسائل جماعية من إدارة النقل (تأخير، عطل، تغيير مسار...)
--  3) التسليم الآمن: مستلمون مصرّح لهم وتأكيد التسليم عند النزول
--  4) طلبات تغيير العنوان/نقطة التوقف (دائم أو مؤقت)
-- =====================================================================

-- ---------------- 1) تفضيلات تنبيه الاقتراب ----------------
-- لا صف = إعداد الجهة الافتراضي. approach_meters = null يعني أن ولي الأمر أوقف التنبيه.
create table guardian_alert_prefs (
  tenant_id        uuid not null references tenants(id) on delete cascade,
  guardian_user_id uuid not null references users(id) on delete cascade,
  student_id       uuid not null references students(id) on delete cascade,
  approach_meters  int check (approach_meters is null or approach_meters between 200 and 5000),
  updated_at       timestamptz not null default now(),
  primary key (student_id, guardian_user_id)
);

-- ---------------- 2) الرسائل الجماعية ----------------
create table broadcasts (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  created_by      uuid not null references users(id),
  audience        text not null check (audience in ('all_parents', 'routes', 'trips', 'drivers', 'everyone')),
  route_ids       uuid[] not null default '{}',
  trip_ids        uuid[] not null default '{}',
  category        text not null check (category in ('delay', 'breakdown', 'route_change', 'weather', 'early_dismissal', 'general')),
  title           text not null check (length(title) between 2 and 120),
  body            text not null check (length(body) between 2 and 1000),
  delay_minutes   int check (delay_minutes is null or delay_minutes between 1 and 240),
  recipient_count int,
  created_at      timestamptz not null default now(),
  check (audience <> 'routes' or cardinality(route_ids) between 1 and 50),
  check (audience <> 'trips' or cardinality(trip_ids) between 1 and 50)
);
create index on broadcasts (tenant_id, created_at desc);

-- ---------------- 3) التسليم الآمن ----------------
-- تفعّله الإدارة للطلاب الصغار: لا يُسجّل نزولهم في رحلة العودة إلا مع تحديد من استلمهم.
alter table students add column requires_handover boolean not null default false;

create table authorized_pickups (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  student_id   uuid not null references students(id) on delete cascade,
  full_name    text not null check (length(full_name) between 2 and 120),
  relationship text check (relationship is null or length(relationship) <= 40),
  phone        text check (phone is null or phone ~ '^\+?[0-9]{8,15}$'),
  added_by     uuid not null references users(id),
  status       text not null default 'active' check (status in ('active', 'revoked')),
  revoked_by   uuid references users(id),
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index on authorized_pickups (student_id);

-- من استلم الطالب: لقطة للاسم وقت النزول (لا تتغير لو حُذف المستلم لاحقًا)
alter table boarding_events
  add column handover_kind text check (handover_kind is null or handover_kind in ('guardian', 'authorized')),
  add column handover_ref  uuid,
  add column handover_to   text;

alter table safety_alerts drop constraint safety_alerts_kind_check;
alter table safety_alerts add constraint safety_alerts_kind_check check (kind in
  ('unresolved_riders', 'unrecorded_riders', 'inspection_overdue', 'child_found',
   'emergency', 'issue', 'location_lost', 'no_receiver'));

-- قائمة المستلمين المسموح بهم لطلاب رحلة: لسائق الرحلة أو طاقم الجهة فقط.
-- تعيد الاسم وصلة القرابة فقط (بدون أرقام أو بريد) لطلاب «التسليم الآمن».
create or replace function app.trip_receivers(p_trip uuid)
returns table (student_id uuid, kind text, ref_id uuid, full_name text, relationship text)
language sql stable security definer set search_path = public, pg_temp as $$
  with allowed as (
    select t.id from trips t
    where t.id = p_trip and t.tenant_id = app.cur_tenant()
      and (app.is_staff() or (app.cur_role() = 'driver' and t.driver_user_id = app.cur_user()))
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
revoke all on function app.trip_receivers(uuid) from public;
grant execute on function app.trip_receivers(uuid) to busna_app;

-- ---------------- 4) طلبات تغيير العنوان / نقطة التوقف ----------------
create table stop_change_requests (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  student_id   uuid not null references students(id) on delete cascade,
  requested_by uuid not null references users(id),
  kind         text not null check (kind in ('permanent', 'temporary')),
  direction    text not null check (direction in ('to_school', 'from_school', 'both')),
  start_date   date not null,
  end_date     date,
  address      text not null check (length(address) between 3 and 300),
  lat          double precision check (lat is null or lat between -90 and 90),
  lng          double precision check (lng is null or lng between -180 and 180),
  note         text check (note is null or length(note) <= 300),
  status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  reviewed_by  uuid references users(id),
  reviewed_at  timestamptz,
  review_note  text check (review_note is null or length(review_note) <= 300),
  created_at   timestamptz not null default now(),
  check ((kind = 'permanent' and end_date is null)
      or (kind = 'temporary' and end_date is not null and end_date >= start_date and end_date <= start_date + 60))
);
create index on stop_change_requests (tenant_id, status, created_at desc);
create index on stop_change_requests (student_id);

-- تعيين مؤقت: يُستخدم عند إنشاء رحلات الفترة بدل التعيين الدائم في route_riders
create table rider_overrides (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  request_id uuid references stop_change_requests(id) on delete set null,
  student_id uuid not null references students(id) on delete cascade,
  direction  text not null check (direction in ('to_school', 'from_school')),
  route_id   uuid not null references routes(id) on delete cascade,
  stop_id    uuid not null references route_stops(id) on delete cascade,
  start_date date not null,
  end_date   date not null check (end_date >= start_date),
  status     text not null default 'active' check (status in ('active', 'cancelled')),
  created_by uuid not null references users(id),
  created_at timestamptz not null default now()
);
create index on rider_overrides (student_id, direction, start_date);
create index on rider_overrides (route_id, start_date);

-- ---------------- RLS ----------------
alter table guardian_alert_prefs enable row level security;
alter table broadcasts enable row level security;
alter table authorized_pickups enable row level security;
alter table stop_change_requests enable row level security;
alter table rider_overrides enable row level security;

grant select, insert, update on guardian_alert_prefs to busna_app;
grant select, insert on broadcasts to busna_app;
grant select, insert, update on authorized_pickups to busna_app;
grant select, insert, update on stop_change_requests to busna_app;
grant select, insert, update on rider_overrides to busna_app;

grant select on guardian_alert_prefs, broadcasts, authorized_pickups, stop_change_requests, rider_overrides,
  route_stops, route_riders, routes, boarding_events to busna_worker;
grant update (recipient_count) on broadcasts to busna_worker;

create policy prefs_select on guardian_alert_prefs for select to busna_app
  using (tenant_id = app.cur_tenant() and (app.is_staff() or guardian_user_id = app.cur_user()));
create policy prefs_insert on guardian_alert_prefs for insert to busna_app
  with check (tenant_id = app.cur_tenant() and app.cur_role() = 'parent'
              and guardian_user_id = app.cur_user() and app.is_guardian_of(student_id));
create policy prefs_update on guardian_alert_prefs for update to busna_app
  using (tenant_id = app.cur_tenant() and guardian_user_id = app.cur_user())
  with check (tenant_id = app.cur_tenant() and guardian_user_id = app.cur_user() and app.is_guardian_of(student_id));

create policy bc_select on broadcasts for select to busna_app
  using (tenant_id = app.cur_tenant() and app.is_staff());
create policy bc_insert on broadcasts for insert to busna_app
  with check (tenant_id = app.cur_tenant() and app.cur_role() in ('tenant_admin', 'supervisor') and created_by = app.cur_user());

create policy ap_select on authorized_pickups for select to busna_app
  using (tenant_id = app.cur_tenant() and (app.is_staff() or (app.cur_role() = 'parent' and app.is_guardian_of(student_id))));
create policy ap_insert on authorized_pickups for insert to busna_app
  with check (tenant_id = app.cur_tenant() and added_by = app.cur_user() and status = 'active' and (
    app.cur_role() in ('tenant_admin', 'supervisor') or (app.cur_role() = 'parent' and app.is_guardian_of(student_id))));
create policy ap_update on authorized_pickups for update to busna_app
  using (tenant_id = app.cur_tenant() and (
    app.cur_role() in ('tenant_admin', 'supervisor') or (app.cur_role() = 'parent' and app.is_guardian_of(student_id))))
  with check (tenant_id = app.cur_tenant() and (
    app.cur_role() in ('tenant_admin', 'supervisor') or (app.cur_role() = 'parent' and app.is_guardian_of(student_id))));

create policy scr_select on stop_change_requests for select to busna_app
  using (tenant_id = app.cur_tenant() and (app.is_staff() or (app.cur_role() = 'parent' and app.is_guardian_of(student_id))));
create policy scr_insert on stop_change_requests for insert to busna_app
  with check (tenant_id = app.cur_tenant() and app.cur_role() = 'parent' and app.is_guardian_of(student_id)
              and requested_by = app.cur_user() and status = 'pending');
-- ولي الأمر يلغي طلبه المعلق فقط؛ الإدارة تعتمد أو ترفض
create policy scr_update on stop_change_requests for update to busna_app
  using (tenant_id = app.cur_tenant() and (app.cur_role() in ('tenant_admin', 'supervisor')
    or (app.cur_role() = 'parent' and requested_by = app.cur_user() and status = 'pending')))
  with check (tenant_id = app.cur_tenant() and (app.cur_role() in ('tenant_admin', 'supervisor')
    or (app.cur_role() = 'parent' and requested_by = app.cur_user() and status = 'cancelled')));

create policy ro_select on rider_overrides for select to busna_app
  using (tenant_id = app.cur_tenant() and (app.is_staff() or (app.cur_role() = 'parent' and app.is_guardian_of(student_id))));
create policy ro_write on rider_overrides for insert to busna_app
  with check (tenant_id = app.cur_tenant() and app.cur_role() in ('tenant_admin', 'supervisor') and created_by = app.cur_user());
create policy ro_update on rider_overrides for update to busna_app
  using (tenant_id = app.cur_tenant() and app.cur_role() in ('tenant_admin', 'supervisor'))
  with check (tenant_id = app.cur_tenant() and app.cur_role() in ('tenant_admin', 'supervisor'));

do $$
declare t text;
begin
  foreach t in array array['guardian_alert_prefs', 'broadcasts', 'authorized_pickups', 'stop_change_requests', 'rider_overrides',
                           'route_stops', 'route_riders', 'routes', 'boarding_events']
  loop
    if not exists (select 1 from pg_policies where tablename = t and policyname = 'worker_service') then
      execute format('create policy worker_service on %I for all to busna_worker using (true) with check (true)', t);
    end if;
  end loop;
end $$;

-- ولي الأمر يرى نقطة التوقف المعتمدة مؤقتًا لطفله أيضًا
create or replace function app.parent_has_stop(p_stop uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from route_riders rr join guardian_students gs on gs.student_id = rr.student_id
                 where rr.stop_id = p_stop and gs.guardian_user_id = app.cur_user()
                   and rr.tenant_id = app.cur_tenant())
      or exists (select 1 from trip_riders tr join guardian_students gs on gs.student_id = tr.student_id
                 where tr.stop_id = p_stop and gs.guardian_user_id = app.cur_user()
                   and tr.tenant_id = app.cur_tenant())
      or exists (select 1 from rider_overrides o join guardian_students gs on gs.student_id = o.student_id
                 where o.stop_id = p_stop and o.status = 'active' and gs.guardian_user_id = app.cur_user()
                   and o.tenant_id = app.cur_tenant())
$$;
