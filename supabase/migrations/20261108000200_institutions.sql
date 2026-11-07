-- =====================================================================
-- Busna — Transport companies & institutions (additive, non-breaking)
--
-- Tenant model from now on:
--   tenant (public.schools row, "organization")  ← isolation boundary, branding, billing
--     └─ institutions (school / university / other) served by that tenant
--         └─ students, routes, trips
--
-- The tenant table and its key keep their names (schools / school_id) so
-- every existing policy, RPC and client keeps working; the column
-- org_kind says whether the tenant is a school running its own buses or a
-- transport company serving several institutions. A rename to
-- organizations / org_id can be done later in one dedicated migration.
--
-- Every existing tenant gets one institution (same name, location and
-- timezone). New rows that omit institution_id get the tenant's default
-- institution (routes / students) or the route's institution (trips), so
-- current RPCs such as import_students, save_route and generate_trips need
-- no change.
-- =====================================================================

alter table public.schools
  add column org_kind text not null default 'school_operator'
    check (org_kind in ('school_operator', 'transport_company'));

create table public.institutions (
  id         uuid primary key default gen_random_uuid(),
  school_id  uuid not null references public.schools (id) on delete cascade,  -- tenant
  kind       text not null default 'school' check (kind in ('school', 'university', 'other')),
  name       text not null check (length(trim(name)) > 1),
  name_en    text,
  city       text,
  address    text,
  lat        double precision check (lat between -90 and 90),
  lng        double precision check (lng between -180 and 180),
  timezone   text not null default 'Asia/Riyadh',
  -- e.g. {"start_time": "07:00"}; overrides tenant settings for this institution
  settings   jsonb not null default '{}'::jsonb,
  status     public.record_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, school_id),
  unique (school_id, name)
);
create index institutions_school_idx on public.institutions (school_id, status);
create trigger institutions_updated_at before update on public.institutions
  for each row execute function private.set_updated_at();
create trigger institutions_audit after insert or update or delete on public.institutions
  for each row execute function private.audit_trigger();

-- Every new tenant starts with one institution mirroring it.
create or replace function private.create_default_institution()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.institutions (school_id, kind, name, name_en, city, address, lat, lng, timezone)
  values (new.id, case when new.org_kind = 'transport_company' then 'other' else 'school' end,
          new.name, new.name_en, new.city, new.address, new.lat, new.lng, new.timezone);
  return new;
end $$;
create trigger schools_default_institution after insert on public.schools
  for each row execute function private.create_default_institution();

insert into public.institutions (school_id, kind, name, name_en, city, address, lat, lng, timezone)
select id, 'school', name, name_en, city, address, lat, lng, timezone from public.schools;

-- The tenant's first active institution (used when a writer omits it).
create or replace function private.default_institution(p_school uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select id from public.institutions where school_id = p_school and status = 'active'
   order by created_at, id limit 1
$$;

-- ---------------------------------------------------------------------
-- institution_id on students / routes / trips
-- ---------------------------------------------------------------------
alter table public.students add column institution_id uuid;
alter table public.routes   add column institution_id uuid;
alter table public.trips    add column institution_id uuid;

update public.students set institution_id = private.default_institution(school_id);
update public.routes   set institution_id = private.default_institution(school_id);
update public.trips t  set institution_id = coalesce(
  (select r.institution_id from public.routes r where r.id = t.route_id), private.default_institution(t.school_id));

create or replace function private.fill_institution()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.institution_id is null then
    -- nested IF: PL/pgSQL does not short-circuit AND, and only trips has route_id
    if tg_table_name = 'trips' then
      if new.route_id is not null then
        select r.institution_id into new.institution_id from public.routes r where r.id = new.route_id;
      end if;
    end if;
    if new.institution_id is null then
      new.institution_id := private.default_institution(new.school_id);
    end if;
  end if;
  return new;
end $$;
create trigger students_fill_institution before insert or update of institution_id on public.students
  for each row execute function private.fill_institution();
create trigger routes_fill_institution before insert or update of institution_id on public.routes
  for each row execute function private.fill_institution();
create trigger trips_fill_institution before insert or update of institution_id on public.trips
  for each row execute function private.fill_institution();

-- Composite FKs: an institution of another tenant can never be referenced.
alter table public.students alter column institution_id set not null,
  add foreign key (institution_id, school_id) references public.institutions (id, school_id);
alter table public.routes alter column institution_id set not null,
  add foreign key (institution_id, school_id) references public.institutions (id, school_id);
alter table public.trips alter column institution_id set not null,
  add foreign key (institution_id, school_id) references public.institutions (id, school_id);

create index students_institution_idx on public.students (institution_id);
create index routes_institution_idx   on public.routes (institution_id);
create index trips_institution_date_idx on public.trips (institution_id, trip_date);

-- ---------------------------------------------------------------------
-- RLS: anyone affiliated with the tenant (dashboard, staff, guardians)
-- may read its institutions (names / locations of schools are not
-- private); only owners/admins may write.
-- ---------------------------------------------------------------------
alter table public.institutions enable row level security;
revoke all on public.institutions from anon;
create policy institutions_select on public.institutions for select to authenticated
  using (school_id in (select private.affiliated_school_ids()) or (select private.is_platform_admin()));
create policy institutions_admin_write on public.institutions for all to authenticated
  using (school_id in (select private.admin_school_ids()))
  with check (school_id in (select private.admin_school_ids()));

-- org_kind is a platform decision, like slug/status (admins may not change it).
-- (Column-level UPDATE on schools is granted per column in 0300; org_kind is not in that list.)

grant execute on all functions in schema private to authenticated, service_role;
revoke execute on function private.generate_trips_all_schools() from public, authenticated;

-- ---------------------------------------------------------------------
-- save_route: optional p_route.institution_id (same signature as before).
-- Omitted / empty => keep the route's current institution (or the tenant
-- default for a new route, via the fill trigger).
-- ---------------------------------------------------------------------
create or replace function public.save_route(p_school uuid, p_route_id uuid, p_route jsonb, p_stops jsonb, p_students jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := coalesce(p_route_id, gen_random_uuid());
  v_inst uuid := nullif(p_route ->> 'institution_id', '')::uuid;
begin
  perform private.assert_school_admin(p_school);
  if p_route_id is not null and not exists (select 1 from public.routes where id = p_route_id and school_id = p_school) then
    perform private.fail('not_found', 'الرحلة غير موجودة');
  end if;
  if coalesce(trim(p_route ->> 'name'), '') = '' then perform private.fail('name_required', 'أدخل اسم الرحلة'); end if;
  if v_inst is not null and not exists (select 1 from public.institutions where id = v_inst and school_id = p_school) then
    perform private.fail('institution_not_found', 'الجهة غير موجودة');
  end if;

  insert into public.routes (id, school_id, institution_id, name, period, bus_id, driver_id, supervisor_id, weekdays, departure_time,
                             start_label, start_lat, start_lng, end_label, end_lat, end_lng, active)
  values (v_id, p_school, v_inst, trim(p_route ->> 'name'), (p_route ->> 'period')::public.trip_period,
          nullif(p_route ->> 'bus_id', '')::uuid, nullif(p_route ->> 'driver_id', '')::uuid, nullif(p_route ->> 'supervisor_id', '')::uuid,
          array(select jsonb_array_elements_text(p_route -> 'weekdays')::smallint),
          (p_route ->> 'departure_time')::time,
          nullif(p_route ->> 'start_label', ''), (p_route ->> 'start_lat')::double precision, (p_route ->> 'start_lng')::double precision,
          nullif(p_route ->> 'end_label', ''), (p_route ->> 'end_lat')::double precision, (p_route ->> 'end_lng')::double precision,
          coalesce((p_route ->> 'active')::boolean, true))
  on conflict (id) do update set
    institution_id = coalesce(v_inst, public.routes.institution_id),
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
