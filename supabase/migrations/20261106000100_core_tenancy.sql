-- =====================================================================
-- Busna — Core multi-tenancy
-- Every tenant is a school. Every tenant-owned row carries school_id and
-- is protected by RLS. Authorization helpers live in the `private` schema,
-- which is NOT exposed through the Supabase Data API.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
create type public.member_role       as enum ('owner', 'admin', 'viewer');
create type public.staff_role        as enum ('driver', 'supervisor');
create type public.record_status     as enum ('active', 'suspended');
create type public.transport_status  as enum ('active', 'suspended', 'withdrawn');
create type public.bus_status        as enum ('active', 'maintenance', 'out_of_service');
create type public.trip_period       as enum ('morning', 'afternoon');
-- Lifecycle: scheduled -> started -> in_progress -> completed (or cancelled).
-- "Delayed" and "Emergency" are orthogonal flags on the trip (a trip can be
-- in progress AND delayed), see trips.delay_minutes / trips.emergency_active.
create type public.trip_status       as enum ('scheduled', 'started', 'in_progress', 'completed', 'cancelled');
create type public.attendance_status as enum ('pending', 'boarded', 'absent', 'dropped');
create type public.incident_severity as enum ('low', 'medium', 'high', 'critical');
create type public.incident_status   as enum ('open', 'acknowledged', 'resolved');
create type public.request_kind      as enum ('feedback', 'complaint', 'pickup_change', 'contact', 'absence_notice');
create type public.request_status    as enum ('open', 'in_review', 'resolved', 'rejected');

-- ---------------------------------------------------------------------
-- Utilities
-- ---------------------------------------------------------------------
create or replace function private.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Normalises Saudi mobile numbers to E.164 (+9665XXXXXXXX). Other
-- international numbers are kept as "+<digits>".
create or replace function public.normalize_phone(p text)
returns text language plpgsql immutable as $$
declare d text;
begin
  if p is null then return null; end if;
  d := regexp_replace(translate(p, '٠١٢٣٤٥٦٧٨٩', '0123456789'), '[^0-9+]', '', 'g');
  if d = '' then return null; end if;
  if d like '+%' then return '+' || regexp_replace(d, '[^0-9]', '', 'g'); end if;
  if d like '00%' then return '+' || substr(d, 3); end if;
  if d ~ '^05[0-9]{8}$' then return '+966' || substr(d, 2); end if;
  if d ~ '^5[0-9]{8}$'  then return '+966' || d; end if;
  if d ~ '^9665[0-9]{8}$' then return '+' || d; end if;
  return '+' || d;
end $$;

-- Great-circle distance in metres.
create or replace function public.distance_m(lat1 double precision, lng1 double precision,
                                             lat2 double precision, lng2 double precision)
returns double precision language sql immutable as $$
  select case when lat1 is null or lat2 is null or lng1 is null or lng2 is null then null
  else 2 * 6371000 * asin(sqrt(
      power(sin(radians(lat2 - lat1) / 2), 2) +
      cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))
  end
$$;

-- ---------------------------------------------------------------------
-- Tenants & identities
-- ---------------------------------------------------------------------
create table public.schools (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique check (slug ~ '^[a-z0-9-]{3,40}$'),
  name          text not null check (length(trim(name)) > 1),
  name_en       text,
  logo_url      text,
  primary_color text not null default '#0E9F6E' check (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  accent_color  text not null default '#065F46' check (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  timezone      text not null default 'Asia/Riyadh',
  city          text,
  address       text,
  lat           double precision check (lat between -90 and 90),
  lng           double precision check (lng between -180 and 180),
  -- approach_radius_m, arrival_radius_m, late_threshold_min ...
  settings      jsonb not null default '{"approach_radius_m": 700, "late_threshold_min": 10}'::jsonb,
  status        public.record_status not null default 'active',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger schools_updated_at before update on public.schools
  for each row execute function private.set_updated_at();

-- Busna platform operators (create & manage tenants).
create table public.platform_admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  full_name  text,
  phone      text,
  avatar_url text,
  locale     text not null default 'ar',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_updated_at before update on public.profiles
  for each row execute function private.set_updated_at();

-- School administration accounts (dashboard users).
create table public.school_members (
  school_id  uuid not null references public.schools (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       public.member_role not null default 'admin',
  created_at timestamptz not null default now(),
  primary key (school_id, user_id)
);
create index school_members_user_idx on public.school_members (user_id);

-- Drivers & supervisors. A record can exist before the person has an
-- account; user_id is linked when they sign in with the same verified
-- phone number (see public.claim_my_records()).
create table public.staff (
  id             uuid primary key default gen_random_uuid(),
  school_id      uuid not null references public.schools (id) on delete cascade,
  user_id        uuid references auth.users (id) on delete set null,
  role           public.staff_role not null,
  full_name      text not null check (length(trim(full_name)) > 1),
  phone          text not null,
  national_id    text,
  license_number text,
  license_expiry date,
  photo_url      text,
  status         public.record_status not null default 'active',
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (id, school_id),
  unique (school_id, role, phone)
);
create index staff_user_idx on public.staff (user_id) where user_id is not null;
create index staff_school_idx on public.staff (school_id, role);
create trigger staff_updated_at before update on public.staff
  for each row execute function private.set_updated_at();

create table public.guardians (
  id           uuid primary key default gen_random_uuid(),
  school_id    uuid not null references public.schools (id) on delete cascade,
  user_id      uuid references auth.users (id) on delete set null,
  full_name    text not null check (length(trim(full_name)) > 1),
  phone        text not null,
  phone_alt    text,
  email        text,
  notify_push  boolean not null default true,
  notify_sms   boolean not null default false,
  status       public.record_status not null default 'active',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, school_id),
  unique (school_id, phone)
);
create index guardians_user_idx on public.guardians (user_id) where user_id is not null;
create trigger guardians_updated_at before update on public.guardians
  for each row execute function private.set_updated_at();

create or replace function private.normalize_phone_trigger()
returns trigger language plpgsql as $$
begin
  new.phone := public.normalize_phone(new.phone);
  if tg_table_name = 'guardians' then
    new.phone_alt := public.normalize_phone(new.phone_alt);
  end if;
  return new;
end $$;
create trigger staff_phone before insert or update of phone on public.staff
  for each row execute function private.normalize_phone_trigger();
create trigger guardians_phone before insert or update of phone, phone_alt on public.guardians
  for each row execute function private.normalize_phone_trigger();

-- ---------------------------------------------------------------------
-- Authorization helpers (SECURITY DEFINER, fixed search_path).
-- Used by RLS policies as `school_id in (select private.x())` so that
-- they are evaluated once per statement, not once per row.
-- ---------------------------------------------------------------------
create or replace function private.is_platform_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_admins where user_id = (select auth.uid()))
$$;

-- Schools where the caller is owner/admin (write access to management data).
create or replace function private.admin_school_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select school_id from public.school_members
   where user_id = (select auth.uid()) and role in ('owner', 'admin')
$$;

-- Schools where the caller has dashboard access (owner/admin/viewer).
create or replace function private.member_school_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select school_id from public.school_members where user_id = (select auth.uid())
$$;

create or replace function private.my_staff_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select id from public.staff where user_id = (select auth.uid()) and status = 'active'
$$;

create or replace function private.my_guardian_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select id from public.guardians where user_id = (select auth.uid()) and status = 'active'
$$;

-- Any school the caller is affiliated with in any capacity.
create or replace function private.affiliated_school_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select school_id from public.school_members where user_id = (select auth.uid())
  union
  select school_id from public.staff where user_id = (select auth.uid()) and status = 'active'
  union
  select school_id from public.guardians where user_id = (select auth.uid()) and status = 'active'
$$;

grant execute on all functions in schema private to authenticated, service_role;
