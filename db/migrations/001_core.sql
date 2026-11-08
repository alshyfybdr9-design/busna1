-- =====================================================================
-- باصنا — Busna : المخطط الأساسي (المرحلة 1)
-- عزل الجهات (Tenants) يتم عبر Row Level Security.
--
-- أدوار قاعدة البيانات:
--   busna_owner  : مالك الجداول (يشغّل الترحيلات فقط)
--   busna_app    : يستخدمه خادم الـ API لكل طلبات المستخدمين. يخضع لـ RLS
--                  ويقرأ هوية المستخدم/الجهة/الدور من متغيرات الجلسة app.*
--   busna_auth   : وحدة المصادقة فقط (دخول، دعوات، رموز تحديث). صلاحيات جداول محدودة.
--   busna_worker : المهام الخلفية (إشعارات، احتفاظ البيانات). صلاحيات جداول محدودة.
-- لا يُستخدم BYPASSRLS؛ السياسات موجّهة لكل دور بـ "TO role" لتعمل على
-- خدمات Postgres المُدارة أيضًا.
-- =====================================================================

create extension if not exists citext;
create extension if not exists pgcrypto;
create schema if not exists app;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'busna_app') then create role busna_app nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'busna_auth') then create role busna_auth nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'busna_worker') then create role busna_worker nologin; end if;
end $$;

-- ---------------------------------------------------------------------
-- سياق الجلسة (يُضبط داخل كل معاملة بواسطة الخادم عبر set_config(..., true))
-- ---------------------------------------------------------------------
create or replace function app.cur_tenant() returns uuid language sql stable as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;
create or replace function app.cur_user() returns uuid language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;
create or replace function app.cur_role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('app.role', true), ''), 'anonymous')
$$;
create or replace function app.is_staff() returns boolean language sql stable as $$
  select app.cur_role() in ('tenant_admin', 'supervisor')
$$;

create or replace function app.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- ---------------------------------------------------------------------
-- الجهات والمستخدمون
-- ---------------------------------------------------------------------
create table tenants (
  id            uuid primary key default gen_random_uuid(),
  code          citext not null unique check (code ~ '^[A-Za-z0-9-]{4,20}$'),
  name          text not null check (length(name) between 2 and 120),
  name_en       text,
  kind          text not null check (kind in ('school', 'transport_company')),
  logo_url      text,
  contact_phone text,
  contact_email text,
  timezone      text not null default 'Asia/Riyadh',
  settings      jsonb not null default '{}'::jsonb,
  status        text not null default 'active' check (status in ('active', 'suspended')),
  is_demo       boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table users (
  id                 uuid primary key default gen_random_uuid(),
  email              citext unique,
  phone              text unique,
  password_hash      text,
  full_name          text not null check (length(full_name) between 2 and 120),
  locale             text not null default 'ar' check (locale in ('ar', 'en')),
  is_platform_admin  boolean not null default false,
  status             text not null default 'active' check (status in ('active', 'disabled')),
  failed_logins      int not null default 0,
  locked_until       timestamptz,
  last_login_at      timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (email is not null or phone is not null)
);

create table memberships (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  role        text not null check (role in ('tenant_admin', 'supervisor', 'driver', 'parent')),
  status      text not null default 'active' check (status in ('active', 'disabled')),
  permissions jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, user_id, role)
);
create index on memberships (user_id);

create table invites (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  token_hash   text not null unique,
  role         text not null check (role in ('tenant_admin', 'supervisor', 'driver', 'parent')),
  full_name    text not null,
  email        citext,
  phone        text,
  student_ids  uuid[] not null default '{}',
  expires_at   timestamptz not null,
  accepted_at  timestamptz,
  accepted_by  uuid references users(id),
  revoked_at   timestamptz,
  created_by   uuid references users(id),
  created_at   timestamptz not null default now()
);
create index on invites (tenant_id);

create table refresh_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  token_hash   text not null unique,
  family_id    uuid not null,
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  replaced_by  uuid,
  user_agent   text,
  created_at   timestamptz not null default now()
);
create index on refresh_tokens (user_id);

-- ---------------------------------------------------------------------
-- الطلاب وأولياء الأمور
-- ---------------------------------------------------------------------
create table students (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  full_name    text not null check (length(full_name) between 2 and 120),
  grade        text,
  school_name  text,
  student_code text,
  -- رمز عشوائي معتم لبطاقة QR — لا يحتوي بيانات شخصية، ويمكن تدويره.
  qr_token     text not null unique default encode(gen_random_bytes(16), 'hex'),
  notes        text,
  status       text not null default 'active' check (status in ('active', 'inactive')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, student_code)
);
create index on students (tenant_id);

create table guardian_students (
  tenant_id        uuid not null references tenants(id) on delete cascade,
  guardian_user_id uuid not null references users(id) on delete cascade,
  student_id       uuid not null references students(id) on delete cascade,
  relationship     text,
  created_at       timestamptz not null default now(),
  primary key (student_id, guardian_user_id)
);
create index on guardian_students (guardian_user_id);

-- ---------------------------------------------------------------------
-- الباصات والمسارات والجداول
-- ---------------------------------------------------------------------
create table buses (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  plate_number text not null,
  label        text,
  capacity     int check (capacity is null or capacity between 1 and 120),
  status       text not null default 'active' check (status in ('active', 'maintenance', 'retired')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, plate_number)
);

create table routes (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  name           text not null,
  direction      text not null check (direction in ('to_school', 'from_school')),
  bus_id         uuid references buses(id) on delete set null,
  driver_user_id uuid references users(id) on delete set null,
  status         text not null default 'active' check (status in ('active', 'inactive')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index on routes (tenant_id);

create table route_stops (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  route_id     uuid not null references routes(id) on delete cascade,
  seq          int not null,
  name         text not null,
  kind         text not null default 'stop' check (kind in ('stop', 'school')),
  lat          double precision not null check (lat between -90 and 90),
  lng          double precision not null check (lng between -180 and 180),
  planned_time time,
  created_at   timestamptz not null default now(),
  unique (route_id, seq) deferrable initially deferred
);

create table route_riders (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  route_id   uuid not null references routes(id) on delete cascade,
  student_id uuid not null references students(id) on delete cascade,
  stop_id    uuid not null references route_stops(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (route_id, student_id)
);
create index on route_riders (student_id);

create table schedules (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  route_id       uuid not null references routes(id) on delete cascade,
  days_of_week   smallint[] not null check (days_of_week <@ array[0,1,2,3,4,5,6]::smallint[]),
  departure_time time not null,
  status         text not null default 'active' check (status in ('active', 'inactive')),
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- الرحلات والحضور
-- ---------------------------------------------------------------------
create table trips (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  route_id          uuid not null references routes(id) on delete restrict,
  schedule_id       uuid references schedules(id) on delete set null,
  service_date      date not null,
  direction         text not null check (direction in ('to_school', 'from_school')),
  bus_id            uuid references buses(id) on delete set null,
  driver_user_id    uuid references users(id) on delete set null,
  status            text not null default 'scheduled'
                    check (status in ('scheduled', 'in_progress', 'completed', 'cancelled')),
  planned_start     timestamptz,
  started_at        timestamptz,
  ended_at          timestamptz,
  cancelled_reason  text,
  inspection_status text not null default 'not_required'
                    check (inspection_status in ('not_required', 'pending', 'completed', 'issue_reported')),
  last_location_at  timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (schedule_id, service_date)
);
create index on trips (tenant_id, service_date);
create index on trips (driver_user_id, service_date);

create table trip_riders (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  trip_id     uuid not null references trips(id) on delete cascade,
  student_id  uuid not null references students(id) on delete cascade,
  stop_id     uuid references route_stops(id) on delete set null,
  status      text not null default 'expected'
              check (status in ('expected', 'boarded', 'alighted', 'absent', 'no_show')),
  boarded_at  timestamptz,
  alighted_at timestamptz,
  updated_at  timestamptz not null default now(),
  unique (trip_id, student_id)
);
create index on trip_riders (student_id);

-- أحداث مستقلة لكل طالب، غير قابلة للتعديل. client_event_id يمنع التكرار عند المزامنة.
create table boarding_events (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  trip_id         uuid not null references trips(id) on delete cascade,
  trip_rider_id   uuid not null references trip_riders(id) on delete cascade,
  student_id      uuid not null references students(id) on delete cascade,
  type            text not null check (type in ('boarded', 'alighted', 'absent', 'no_show', 'correction')),
  new_status      text not null,
  source          text not null check (source in ('manual', 'qr', 'correction', 'system')),
  client_event_id uuid not null,
  recorded_at     timestamptz not null,
  received_at     timestamptz not null default now(),
  recorded_by     uuid references users(id),
  lat             double precision,
  lng             double precision,
  reason          text,
  unique (tenant_id, client_event_id),
  check (type <> 'correction' or (reason is not null and length(reason) >= 3))
);
create index on boarding_events (trip_id);

create table absences (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  student_id    uuid not null references students(id) on delete cascade,
  absence_date  date not null,
  direction     text not null check (direction in ('to_school', 'from_school', 'both')),
  reason        text,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by  uuid not null references users(id),
  reviewed_by   uuid references users(id),
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index on absences (tenant_id, absence_date);

-- مواقع الباص: تُخزن فقط أثناء رحلة جارية، وتُحذف حسب سياسة الاحتفاظ.
create table bus_locations (
  id           bigserial primary key,
  tenant_id    uuid not null references tenants(id) on delete cascade,
  trip_id      uuid not null references trips(id) on delete cascade,
  recorded_at  timestamptz not null,
  received_at  timestamptz not null default now(),
  lat          double precision not null check (lat between -90 and 90),
  lng          double precision not null check (lng between -180 and 180),
  accuracy_m   real,
  speed_mps    real,
  heading      real,
  unique (trip_id, recorded_at)
);
create index on bus_locations (trip_id, recorded_at desc);
create index on bus_locations (tenant_id, recorded_at);

create table trip_inspections (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  trip_id         uuid not null unique references trips(id) on delete cascade,
  driver_user_id  uuid not null references users(id),
  checklist       jsonb not null,
  result          text not null check (result in ('bus_empty', 'child_found', 'issue')),
  notes           text,
  started_at      timestamptz,
  completed_at    timestamptz not null,
  client_event_id uuid not null,
  verified_by     uuid references users(id),
  verified_at     timestamptz,
  verification_note text,
  created_at      timestamptz not null default now()
);

create table safety_alerts (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  trip_id         uuid references trips(id) on delete cascade,
  kind            text not null check (kind in
                  ('unresolved_riders', 'unrecorded_riders', 'inspection_overdue', 'child_found',
                   'emergency', 'issue', 'location_lost')),
  severity        text not null check (severity in ('critical', 'high', 'medium', 'low')),
  details         jsonb not null default '{}'::jsonb,
  status          text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  dedupe_key      text,
  created_by      uuid references users(id),
  created_at      timestamptz not null default now(),
  acknowledged_by uuid references users(id),
  acknowledged_at timestamptz,
  resolved_by     uuid references users(id),
  resolved_at     timestamptz,
  resolution_note text,
  unique (tenant_id, dedupe_key)
);
create index on safety_alerts (tenant_id, status);

-- ---------------------------------------------------------------------
-- الإشعارات (Outbox + سجل داخل التطبيق + رموز الدفع)
-- ---------------------------------------------------------------------
create table outbox_events (
  id           bigserial primary key,
  tenant_id    uuid not null references tenants(id) on delete cascade,
  kind         text not null,
  payload      jsonb not null,
  created_at   timestamptz not null default now(),
  processed_at timestamptz,
  attempts     int not null default 0,
  last_error   text
);
create index on outbox_events (processed_at) where processed_at is null;

create table notifications (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references tenants(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  kind        text not null,
  title       text not null,
  body        text not null,
  -- نص آمن لشاشة القفل: لا يحتوي اسم الطفل أو تفاصيل حساسة
  push_title  text not null,
  push_body   text not null,
  data        jsonb not null default '{}'::jsonb,
  dedupe_key  text not null,
  push_status text not null default 'none' check (push_status in ('none', 'pending', 'sent', 'failed', 'skipped')),
  read_at     timestamptz,
  created_at  timestamptz not null default now(),
  unique (user_id, dedupe_key)
);
create index on notifications (user_id, created_at desc);

create table push_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  token      text not null unique,
  platform   text not null check (platform in ('ios', 'android', 'web')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- سجل التدقيق (إضافة فقط)
-- ---------------------------------------------------------------------
create table audit_logs (
  id            bigserial primary key,
  tenant_id     uuid references tenants(id) on delete set null,
  actor_user_id uuid references users(id) on delete set null,
  actor_role    text,
  action        text not null,
  entity        text,
  entity_id     text,
  details       jsonb not null default '{}'::jsonb,
  ip            text,
  created_at    timestamptz not null default now()
);
create index on audit_logs (tenant_id, created_at desc);

-- updated_at triggers
do $$
declare t text;
begin
  foreach t in array array['tenants','users','memberships','students','buses','routes','trips','trip_riders']
  loop
    execute format('create trigger %I_touch before update on %I for each row execute function app.touch_updated_at()', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- دوال مساعدة لسياسات RLS (SECURITY DEFINER لتجنب التكرار الدائري في السياسات)
-- كلها مقيدة بالجهة والمستخدم الحاليين في الجلسة.
-- ---------------------------------------------------------------------
create or replace function app.is_guardian_of(p_student uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from guardian_students gs
                 where gs.student_id = p_student and gs.guardian_user_id = app.cur_user()
                   and gs.tenant_id = app.cur_tenant())
$$;

create or replace function app.driver_owns_trip(p_trip uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from trips t
                 where t.id = p_trip and t.driver_user_id = app.cur_user() and t.tenant_id = app.cur_tenant())
$$;

create or replace function app.trip_in_progress(p_trip uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from trips t where t.id = p_trip and t.status = 'in_progress'
                 and t.tenant_id = app.cur_tenant())
$$;

create or replace function app.parent_can_see_trip(p_trip uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from trip_riders tr
                 join guardian_students gs on gs.student_id = tr.student_id
                 where tr.trip_id = p_trip and gs.guardian_user_id = app.cur_user()
                   and tr.tenant_id = app.cur_tenant())
$$;

create or replace function app.driver_has_student(p_student uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from trip_riders tr join trips t on t.id = tr.trip_id
                 where tr.student_id = p_student and t.driver_user_id = app.cur_user()
                   and t.tenant_id = app.cur_tenant()
                   and t.service_date between current_date - 1 and current_date + 7)
$$;

create or replace function app.driver_has_route(p_route uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from routes r where r.id = p_route and r.driver_user_id = app.cur_user()
                 and r.tenant_id = app.cur_tenant())
      or exists (select 1 from trips t where t.route_id = p_route and t.driver_user_id = app.cur_user()
                 and t.tenant_id = app.cur_tenant())
$$;

create or replace function app.parent_has_stop(p_stop uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from route_riders rr join guardian_students gs on gs.student_id = rr.student_id
                 where rr.stop_id = p_stop and gs.guardian_user_id = app.cur_user()
                   and rr.tenant_id = app.cur_tenant())
      or exists (select 1 from trip_riders tr join guardian_students gs on gs.student_id = tr.student_id
                 where tr.stop_id = p_stop and gs.guardian_user_id = app.cur_user()
                   and tr.tenant_id = app.cur_tenant())
$$;

create or replace function app.parent_has_route(p_route uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from route_riders rr join guardian_students gs on gs.student_id = rr.student_id
                 where rr.route_id = p_route and gs.guardian_user_id = app.cur_user()
                   and rr.tenant_id = app.cur_tenant())
      or exists (select 1 from trips t join trip_riders tr on tr.trip_id = t.id
                 join guardian_students gs on gs.student_id = tr.student_id
                 where t.route_id = p_route and gs.guardian_user_id = app.cur_user()
                   and t.tenant_id = app.cur_tenant())
$$;

create or replace function app.user_in_cur_tenant(p_user uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from memberships m where m.user_id = p_user and m.tenant_id = app.cur_tenant())
$$;

-- البحث العام عن جهة برمزها: يعيد بيانات الهوية العامة فقط (لا بيانات مستخدمين أو طلاب).
create or replace function app.resolve_tenant_code(p_code text)
returns table (id uuid, code text, name text, name_en text, logo_url text, kind text)
language sql stable security definer set search_path = public, pg_temp as $$
  select t.id, t.code::text, t.name, t.name_en, t.logo_url, t.kind
  from tenants t where t.code = p_code::citext and t.status = 'active'
$$;

-- إحصاءات استخدام للوحة المنصة: أعداد فقط، بدون بيانات شخصية.
create or replace function app.tenant_usage_stats()
returns table (tenant_id uuid, students bigint, buses bigint, drivers bigint, parents bigint,
               trips_today bigint, active_trips bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  select t.id,
    (select count(*) from students s where s.tenant_id = t.id and s.status = 'active'),
    (select count(*) from buses b where b.tenant_id = t.id and b.status <> 'retired'),
    (select count(*) from memberships m where m.tenant_id = t.id and m.role = 'driver' and m.status = 'active'),
    (select count(*) from memberships m where m.tenant_id = t.id and m.role = 'parent' and m.status = 'active'),
    (select count(*) from trips tr where tr.tenant_id = t.id and tr.service_date = current_date),
    (select count(*) from trips tr where tr.tenant_id = t.id and tr.status = 'in_progress')
  from tenants t
  where app.cur_role() = 'platform_admin'
$$;

revoke all on all functions in schema app from public;
grant usage on schema app to busna_app, busna_auth, busna_worker;
grant execute on all functions in schema app to busna_app, busna_auth, busna_worker;
