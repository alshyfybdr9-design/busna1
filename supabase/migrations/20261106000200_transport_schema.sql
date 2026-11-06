-- =====================================================================
-- Busna — School transport domain
-- Composite foreign keys (id, school_id) guarantee at the database level
-- that a row can never reference a row belonging to another school.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Fleet
-- ---------------------------------------------------------------------
create table public.buses (
  id                    uuid primary key default gen_random_uuid(),
  school_id             uuid not null references public.schools (id) on delete cascade,
  code                  text not null,                 -- رقم الباص e.g. "باص 7"
  plate_number          text not null,                 -- لوحة المركبة
  vehicle_type          text not null default 'حافلة',
  model_year            int check (model_year between 1990 and 2100),
  capacity              int not null check (capacity between 1 and 120),
  default_driver_id     uuid,
  default_supervisor_id uuid,
  status                public.bus_status not null default 'active',
  gps_source            text not null default 'driver_app' check (gps_source in ('driver_app', 'device')),
  gps_device_id         text,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (id, school_id),
  unique (school_id, code),
  unique (school_id, plate_number),
  foreign key (default_driver_id, school_id) references public.staff (id, school_id) on delete set null (default_driver_id),
  foreign key (default_supervisor_id, school_id) references public.staff (id, school_id) on delete set null (default_supervisor_id)
);
create trigger buses_updated_at before update on public.buses
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------
-- Students
-- ---------------------------------------------------------------------
create table public.students (
  id               uuid primary key default gen_random_uuid(),
  school_id        uuid not null references public.schools (id) on delete cascade,
  student_number   text not null,
  full_name        text not null check (length(trim(full_name)) > 1),
  grade            text,
  section          text,
  photo_url        text,
  home_address     text,
  home_lat         double precision check (home_lat between -90 and 90),
  home_lng         double precision check (home_lng between -180 and 180),
  pickup_label     text,
  pickup_lat       double precision check (pickup_lat between -90 and 90),
  pickup_lng       double precision check (pickup_lng between -180 and 180),
  bus_id           uuid,
  transport_status public.transport_status not null default 'active',
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (id, school_id),
  unique (school_id, student_number),
  foreign key (bus_id, school_id) references public.buses (id, school_id) on delete set null (bus_id)
);
create index students_bus_idx on public.students (bus_id);
create index students_school_name_idx on public.students (school_id, full_name);
create trigger students_updated_at before update on public.students
  for each row execute function private.set_updated_at();

create table public.student_guardians (
  school_id   uuid not null,
  student_id  uuid not null,
  guardian_id uuid not null,
  relation    text not null default 'ولي أمر',
  is_primary  boolean not null default false,
  can_track   boolean not null default true,
  created_at  timestamptz not null default now(),
  primary key (student_id, guardian_id),
  foreign key (student_id, school_id)  references public.students (id, school_id) on delete cascade,
  foreign key (guardian_id, school_id) references public.guardians (id, school_id) on delete cascade
);
create index student_guardians_guardian_idx on public.student_guardians (guardian_id);

-- ---------------------------------------------------------------------
-- Routes = recurring trip templates (الرحلات المتكررة)
-- ---------------------------------------------------------------------
create table public.routes (
  id             uuid primary key default gen_random_uuid(),
  school_id      uuid not null references public.schools (id) on delete cascade,
  name           text not null,
  period         public.trip_period not null,
  bus_id         uuid,
  driver_id      uuid,
  supervisor_id  uuid,
  -- 0 = Sunday ... 6 = Saturday (Saudi school week is Sun..Thu)
  weekdays       smallint[] not null default '{0,1,2,3,4}' check (weekdays <@ '{0,1,2,3,4,5,6}'::smallint[]),
  departure_time time not null,
  start_label    text,
  start_lat      double precision,
  start_lng      double precision,
  end_label      text,
  end_lat        double precision,
  end_lng        double precision,
  -- Optional planned polyline: [[lng,lat], ...]
  path           jsonb,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (id, school_id),
  foreign key (bus_id, school_id)        references public.buses (id, school_id) on delete set null (bus_id),
  foreign key (driver_id, school_id)     references public.staff (id, school_id) on delete set null (driver_id),
  foreign key (supervisor_id, school_id) references public.staff (id, school_id) on delete set null (supervisor_id)
);
create trigger routes_updated_at before update on public.routes
  for each row execute function private.set_updated_at();

create table public.route_stops (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null,
  route_id    uuid not null,
  seq         int not null check (seq >= 0),
  name        text not null,
  lat         double precision not null check (lat between -90 and 90),
  lng         double precision not null check (lng between -180 and 180),
  -- planned minutes after departure
  offset_min  int not null default 0 check (offset_min >= 0),
  created_at  timestamptz not null default now(),
  unique (id, school_id),
  unique (route_id, seq) deferrable initially deferred,
  foreign key (route_id, school_id) references public.routes (id, school_id) on delete cascade
);

create table public.route_students (
  school_id  uuid not null,
  route_id   uuid not null,
  student_id uuid not null,
  stop_id    uuid,
  created_at timestamptz not null default now(),
  primary key (route_id, student_id),
  foreign key (route_id, school_id)   references public.routes (id, school_id) on delete cascade,
  foreign key (student_id, school_id) references public.students (id, school_id) on delete cascade,
  foreign key (stop_id, school_id)    references public.route_stops (id, school_id) on delete set null (stop_id)
);
create index route_students_student_idx on public.route_students (student_id);

-- ---------------------------------------------------------------------
-- Trips = dated instances of a route (snapshot of assignment)
-- ---------------------------------------------------------------------
create table public.trips (
  id               uuid primary key default gen_random_uuid(),
  school_id        uuid not null references public.schools (id) on delete cascade,
  route_id         uuid,
  name             text not null,
  trip_date        date not null,
  period           public.trip_period not null,
  bus_id           uuid,
  driver_id        uuid,
  supervisor_id    uuid,
  status           public.trip_status not null default 'scheduled',
  scheduled_start  timestamptz not null,
  start_label      text,
  start_lat        double precision,
  start_lng        double precision,
  end_label        text,
  end_lat          double precision,
  end_lng          double precision,
  path             jsonb,
  started_at       timestamptz,
  started_by       uuid references auth.users (id) on delete set null,
  arrived_at       timestamptz,          -- arrival at school / end point
  arrived_kind     text check (arrived_kind in ('school', 'end_point')),
  completed_at     timestamptz,
  completed_by     uuid references auth.users (id) on delete set null,
  cancelled_at     timestamptz,
  cancelled_by     uuid references auth.users (id) on delete set null,
  cancel_reason    text,
  delay_minutes    int not null default 0 check (delay_minutes >= 0),
  delay_reason     text,
  emergency_active boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (id, school_id),
  unique (route_id, trip_date),
  foreign key (route_id, school_id)      references public.routes (id, school_id) on delete set null (route_id),
  foreign key (bus_id, school_id)        references public.buses (id, school_id) on delete set null (bus_id),
  foreign key (driver_id, school_id)     references public.staff (id, school_id) on delete set null (driver_id),
  foreign key (supervisor_id, school_id) references public.staff (id, school_id) on delete set null (supervisor_id)
);
create index trips_school_date_idx on public.trips (school_id, trip_date);
create index trips_driver_date_idx on public.trips (driver_id, trip_date);
create index trips_supervisor_date_idx on public.trips (supervisor_id, trip_date);
create index trips_active_idx on public.trips (school_id) where status in ('started', 'in_progress');
create trigger trips_updated_at before update on public.trips
  for each row execute function private.set_updated_at();

create table public.trip_stops (
  id           uuid primary key default gen_random_uuid(),
  school_id    uuid not null,
  trip_id      uuid not null,
  seq          int not null,
  name         text not null,
  lat          double precision not null,
  lng          double precision not null,
  planned_at   timestamptz,
  arrived_at   timestamptz,
  unique (id, school_id),
  unique (trip_id, seq),
  foreign key (trip_id, school_id) references public.trips (id, school_id) on delete cascade
);

create table public.trip_students (
  id                   uuid primary key default gen_random_uuid(),
  school_id            uuid not null,
  trip_id              uuid not null,
  student_id           uuid not null,
  trip_stop_id         uuid,
  status               public.attendance_status not null default 'pending',
  boarded_at           timestamptz,
  boarded_lat          double precision,
  boarded_lng          double precision,
  boarded_by           uuid references auth.users (id) on delete set null,
  dropped_at           timestamptz,
  dropped_lat          double precision,
  dropped_lng          double precision,
  dropped_by           uuid references auth.users (id) on delete set null,
  drop_place           text check (drop_place in ('school', 'home', 'stop')),
  absent_at            timestamptz,
  absent_by            uuid references auth.users (id) on delete set null,
  approach_notified_at timestamptz,
  updated_at           timestamptz not null default now(),
  unique (id, school_id),
  unique (trip_id, student_id),
  foreign key (trip_id, school_id)      references public.trips (id, school_id) on delete cascade,
  foreign key (student_id, school_id)   references public.students (id, school_id) on delete cascade,
  foreign key (trip_stop_id, school_id) references public.trip_stops (id, school_id) on delete set null (trip_stop_id)
);
create index trip_students_student_idx on public.trip_students (student_id);
create index trip_students_trip_status_idx on public.trip_students (trip_id, status);
create trigger trip_students_updated_at before update on public.trip_students
  for each row execute function private.set_updated_at();

-- Immutable timeline of everything that happened on a trip.
create table public.trip_events (
  id            uuid primary key default gen_random_uuid(),
  school_id     uuid not null,
  trip_id       uuid not null,
  type          text not null,
  actor_user_id uuid references auth.users (id) on delete set null,
  actor_role    text,
  student_id    uuid,
  lat           double precision,
  lng           double precision,
  data          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  foreign key (trip_id, school_id) references public.trips (id, school_id) on delete cascade
);
create index trip_events_trip_idx on public.trip_events (trip_id, created_at);
create index trip_events_school_idx on public.trip_events (school_id, created_at desc);

-- ---------------------------------------------------------------------
-- Live tracking
-- bus_live_positions: one row per ACTIVE trip (deleted when the trip ends)
-- bus_locations:      append-only breadcrumb history (partition by month
--                     in production once volume requires it).
-- ---------------------------------------------------------------------
create table public.bus_live_positions (
  trip_id     uuid primary key,
  school_id   uuid not null,
  bus_id      uuid,
  lat         double precision not null,
  lng         double precision not null,
  heading     double precision,
  speed       double precision,       -- m/s
  accuracy    double precision,       -- metres
  recorded_at timestamptz not null,
  received_at timestamptz not null default now(),
  foreign key (trip_id, school_id) references public.trips (id, school_id) on delete cascade
);
create index bus_live_positions_school_idx on public.bus_live_positions (school_id);

create table public.bus_locations (
  id          bigint generated always as identity primary key,
  school_id   uuid not null,
  trip_id     uuid not null,
  bus_id      uuid,
  lat         double precision not null,
  lng         double precision not null,
  heading     double precision,
  speed       double precision,
  accuracy    double precision,
  recorded_at timestamptz not null,
  received_at timestamptz not null default now(),
  foreign key (trip_id, school_id) references public.trips (id, school_id) on delete cascade
);
create index bus_locations_trip_time_idx on public.bus_locations (trip_id, recorded_at);

-- ---------------------------------------------------------------------
-- Notifications, incidents, parent requests
-- ---------------------------------------------------------------------
create table public.notifications (
  id                uuid primary key default gen_random_uuid(),
  school_id         uuid not null references public.schools (id) on delete cascade,
  recipient_user_id uuid references auth.users (id) on delete cascade,
  guardian_id       uuid,
  student_id        uuid,
  trip_id           uuid,
  type              text not null,
  title             text not null,
  body              text not null,
  data              jsonb not null default '{}'::jsonb,
  -- delivery pipeline (push / sms) state
  delivery_status   text not null default 'pending' check (delivery_status in ('pending', 'sent', 'failed', 'skipped')),
  delivered_at      timestamptz,
  read_at           timestamptz,
  created_at        timestamptz not null default now(),
  check (recipient_user_id is not null or guardian_id is not null),
  foreign key (guardian_id, school_id) references public.guardians (id, school_id) on delete cascade
);
create index notifications_guardian_idx on public.notifications (guardian_id, created_at desc);
create index notifications_user_idx on public.notifications (recipient_user_id, created_at desc);
create index notifications_pending_idx on public.notifications (created_at) where delivery_status = 'pending';
-- Prevent duplicate event notifications (e.g. "approaching") per student per trip.
create unique index notifications_dedupe_idx on public.notifications (guardian_id, trip_id, student_id, type)
  where guardian_id is not null and trip_id is not null and student_id is not null;

create table public.incidents (
  id            uuid primary key default gen_random_uuid(),
  school_id     uuid not null references public.schools (id) on delete cascade,
  trip_id       uuid,
  bus_id        uuid,
  reported_by   uuid references auth.users (id) on delete set null,
  reporter_role text,
  category      text not null check (category in ('breakdown', 'accident', 'traffic', 'student_behavior', 'medical', 'other')),
  severity      public.incident_severity not null default 'medium',
  description   text not null,
  lat           double precision,
  lng           double precision,
  status        public.incident_status not null default 'open',
  resolved_by   uuid references auth.users (id) on delete set null,
  resolved_at   timestamptz,
  resolution    text,
  created_at    timestamptz not null default now(),
  foreign key (trip_id, school_id) references public.trips (id, school_id) on delete set null (trip_id),
  foreign key (bus_id, school_id)  references public.buses (id, school_id) on delete set null (bus_id)
);
create index incidents_school_idx on public.incidents (school_id, created_at desc);

create table public.parent_requests (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references public.schools (id) on delete cascade,
  guardian_id uuid not null,
  student_id  uuid,
  kind        public.request_kind not null,
  body        text not null check (length(trim(body)) > 0),
  data        jsonb not null default '{}'::jsonb,
  status      public.request_status not null default 'open',
  response    text,
  handled_by  uuid references auth.users (id) on delete set null,
  handled_at  timestamptz,
  created_at  timestamptz not null default now(),
  foreign key (guardian_id, school_id) references public.guardians (id, school_id) on delete cascade,
  foreign key (student_id, school_id)  references public.students (id, school_id) on delete cascade
);
create index parent_requests_school_idx on public.parent_requests (school_id, status, created_at desc);

-- ---------------------------------------------------------------------
-- Audit log & AI action proposals
-- ---------------------------------------------------------------------
create table public.audit_log (
  id          bigint generated always as identity primary key,
  school_id   uuid,
  actor       uuid,
  action      text not null,
  entity      text not null,
  entity_id   text,
  changes     jsonb,
  created_at  timestamptz not null default now()
);
create index audit_log_school_idx on public.audit_log (school_id, created_at desc);

-- Changes suggested by the School AI Assistant. Nothing is applied until
-- an admin explicitly approves (public.approve_ai_proposal).
create table public.ai_action_proposals (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references public.schools (id) on delete cascade,
  created_by  uuid references auth.users (id) on delete set null,
  kind        text not null check (kind in ('move_student_bus', 'change_route_driver', 'change_route_bus')),
  summary     text not null,
  payload     jsonb not null,
  status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'failed')),
  decided_by  uuid references auth.users (id) on delete set null,
  decided_at  timestamptz,
  error       text,
  created_at  timestamptz not null default now()
);
