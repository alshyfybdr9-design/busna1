-- =====================================================================
-- إدارة المنصة: فريق المنصة (مدير/دعم)، خطط الاشتراك وحدودها،
-- والوصول الاستثنائي المؤقت (قراءة فقط) لبيانات جهة — مبرر ومسجل.
-- =====================================================================

-- ---------------- أدوار فريق المنصة ----------------
alter table users add column platform_role text check (platform_role in ('admin', 'support'));
update users set platform_role = 'admin' where is_platform_admin;

-- توافق خلفي: is_platform_admin يعكس "لديه دور في المنصة"
create or replace function app.sync_platform_flag() returns trigger language plpgsql as $$
begin
  if new.platform_role is null and new.is_platform_admin and (tg_op = 'INSERT' or not old.is_platform_admin) then
    new.platform_role := 'admin';
  end if;
  new.is_platform_admin := new.platform_role is not null;
  return new;
end $$;
create trigger users_platform_flag before insert or update on users for each row execute function app.sync_platform_flag();

grant select (platform_role) on users to busna_app;

create or replace function app.is_platform() returns boolean language sql stable as $$
  select app.cur_role() in ('platform_admin', 'platform_support')
$$;

-- وصول الدعم الاستثنائي يعامَل كموظف للقراءة فقط؛ الكتابة مستحيلة لأن المعاملة نفسها read-only
create or replace function app.is_staff() returns boolean language sql stable as $$
  select app.cur_role() in ('tenant_admin', 'supervisor', 'platform_readonly')
$$;

create table platform_invites (
  id          uuid primary key default gen_random_uuid(),
  token_hash  text not null unique,
  role        text not null check (role in ('admin', 'support')),
  full_name   text not null,
  email       citext not null,
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references users(id),
  revoked_at  timestamptz,
  created_by  uuid references users(id),
  created_at  timestamptz not null default now()
);

-- ---------------- الخطط والاشتراكات ----------------
create table platform_plans (
  id                       uuid primary key default gen_random_uuid(),
  code                     text not null unique check (code ~ '^[a-z0-9_-]{2,30}$'),
  name                     text not null,
  max_students             int check (max_students is null or max_students > 0),
  max_buses                int check (max_buses is null or max_buses > 0),
  max_drivers              int check (max_drivers is null or max_drivers > 0),
  assistant_daily_limit    int check (assistant_daily_limit is null or assistant_daily_limit >= 0),
  monthly_price            numeric(12, 2),
  currency                 text not null default 'SAR',
  active                   boolean not null default true,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create trigger platform_plans_touch before update on platform_plans for each row execute function app.touch_updated_at();

create table tenant_subscriptions (
  tenant_id          uuid primary key references tenants(id) on delete cascade,
  plan_id            uuid not null references platform_plans(id),
  status             text not null default 'trial' check (status in ('trial', 'active', 'past_due', 'cancelled')),
  current_period_end date,
  notes              text,
  updated_by         uuid references users(id),
  updated_at         timestamptz not null default now()
);
create trigger tenant_subscriptions_touch before update on tenant_subscriptions for each row execute function app.touch_updated_at();

-- خطط مبدئية: الحدود قابلة للتعديل، والأسعار تُترك فارغة ليحددها مدير المنصة
insert into platform_plans (code, name, max_students, max_buses, max_drivers, assistant_daily_limit) values
  ('trial', 'تجريبية', 50, 3, 5, 100),
  ('basic', 'أساسية', 300, 10, 15, 1000),
  ('pro', 'متقدمة', 2000, 50, 80, 5000),
  ('custom', 'مخصصة (بلا حدود)', null, null, null, null);

insert into tenant_subscriptions (tenant_id, plan_id, status, current_period_end)
select t.id, p.id, 'trial', current_date + 30 from tenants t, platform_plans p where p.code = 'trial'
on conflict do nothing;

-- فرض حدود الخطة داخل قاعدة البيانات
create or replace function app.enforce_plan_limit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  kind text := tg_argv[0];
  lim int;
  cnt int;
begin
  -- نفحص فقط عند الإضافة أو التفعيل (لا يُفحص الحقل إلا داخل فرع نوعه، فـ plpgsql لا يختصر الشروط)
  if kind = 'students' then
    if new.status <> 'active' then return new; end if;
    if tg_op = 'UPDATE' then
      if old.status = 'active' then return new; end if;
    end if;
  elsif kind = 'buses' then
    if new.status = 'retired' then return new; end if;
    if tg_op = 'UPDATE' then
      if old.status <> 'retired' then return new; end if;
    end if;
  else
    if new.role <> 'driver' or new.status <> 'active' then return new; end if;
    if tg_op = 'UPDATE' then
      if old.status = 'active' then return new; end if;
    end if;
  end if;
  select case kind when 'students' then p.max_students when 'buses' then p.max_buses else p.max_drivers end into lim
  from tenant_subscriptions s join platform_plans p on p.id = s.plan_id where s.tenant_id = new.tenant_id;
  if lim is null then return new; end if;
  if kind = 'students' then
    select count(*) into cnt from students where tenant_id = new.tenant_id and status = 'active';
  elsif kind = 'buses' then
    select count(*) into cnt from buses where tenant_id = new.tenant_id and status <> 'retired';
  else
    select count(*) into cnt from memberships where tenant_id = new.tenant_id and role = 'driver' and status = 'active';
  end if;
  if cnt >= lim then
    raise exception 'plan_limit_reached' using errcode = 'P0001', detail = kind;
  end if;
  return new;
end $$;
create trigger students_plan_limit before insert or update of status on students for each row execute function app.enforce_plan_limit('students');
create trigger buses_plan_limit before insert or update of status on buses for each row execute function app.enforce_plan_limit('buses');
create trigger drivers_plan_limit before insert or update of status on memberships for each row execute function app.enforce_plan_limit('drivers');

-- الخطة والاستهلاك للجهة الحالية (أعداد فقط)
create or replace function app.tenant_plan()
returns table (plan_code text, plan_name text, status text, current_period_end date,
               max_students int, max_buses int, max_drivers int, assistant_daily_limit int,
               students bigint, buses bigint, drivers bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  select p.code, p.name, s.status, s.current_period_end, p.max_students, p.max_buses, p.max_drivers, p.assistant_daily_limit,
    (select count(*) from students x where x.tenant_id = s.tenant_id and x.status = 'active'),
    (select count(*) from buses x where x.tenant_id = s.tenant_id and x.status <> 'retired'),
    (select count(*) from memberships x where x.tenant_id = s.tenant_id and x.role = 'driver' and x.status = 'active')
  from tenant_subscriptions s join platform_plans p on p.id = s.plan_id
  where s.tenant_id = app.cur_tenant()
$$;

-- إحصاءات المنصة متاحة لفريق الدعم أيضًا (أعداد فقط)
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
  where app.is_platform()
$$;

-- ---------------- الوصول الاستثنائي ----------------
create table platform_access_grants (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  reason      text not null check (length(reason) >= 15),
  ticket_id   uuid references support_tickets(id) on delete set null,
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  revoked_by  uuid references users(id),
  created_at  timestamptz not null default now(),
  check (expires_at <= created_at + interval '60 minutes')
);
create index on platform_access_grants (tenant_id, created_at desc);
create index on platform_access_grants (user_id, expires_at);

-- ---------------- RLS ----------------
alter table platform_invites enable row level security;
alter table platform_plans enable row level security;
alter table tenant_subscriptions enable row level security;
alter table platform_access_grants enable row level security;

create policy pinv_admin on platform_invites for all to busna_app
  using (app.cur_role() = 'platform_admin') with check (app.cur_role() = 'platform_admin');
create policy auth_service on platform_invites for all to busna_auth using (true) with check (true);

create policy plans_select on platform_plans for select to busna_app using (true);
create policy plans_write on platform_plans for all to busna_app
  using (app.cur_role() = 'platform_admin') with check (app.cur_role() = 'platform_admin');

create policy subs_select on tenant_subscriptions for select to busna_app
  using (app.is_platform() or (tenant_id = app.cur_tenant() and app.is_staff()));
create policy subs_write on tenant_subscriptions for all to busna_app
  using (app.cur_role() = 'platform_admin') with check (app.cur_role() = 'platform_admin');

create policy grants_select on platform_access_grants for select to busna_app
  using (user_id = app.cur_user() or app.cur_role() = 'platform_admin'
         or (tenant_id = app.cur_tenant() and app.cur_role() = 'tenant_admin'));
create policy grants_insert on platform_access_grants for insert to busna_app
  with check (app.is_platform() and user_id = app.cur_user());
create policy grants_revoke on platform_access_grants for update to busna_app
  using (user_id = app.cur_user() or app.cur_role() = 'platform_admin'
         or (tenant_id = app.cur_tenant() and app.cur_role() = 'tenant_admin'))
  with check (user_id = app.cur_user() or app.cur_role() = 'platform_admin'
         or (tenant_id = app.cur_tenant() and app.cur_role() = 'tenant_admin'));
create policy auth_service on platform_access_grants for all to busna_auth using (true) with check (true);
create policy worker_service on platform_access_grants for all to busna_worker using (true) with check (true);

-- فريق الدعم يرى قائمة الجهات وطابور تذاكر المنصة ودليل التطبيق، دون صلاحيات إنشاء/إيقاف جهات
drop policy tenant_select on tenants;
create policy tenant_select on tenants for select to busna_app
  using (id = app.cur_tenant() or app.is_platform());

drop policy users_select_platform_support on users;
create policy users_select_platform_support on users for select to busna_app
  using (app.is_platform() and (
    exists (select 1 from support_tickets t where t.requester_user_id = users.id and t.queue = 'platform')
    or users.platform_role is not null));

drop policy tickets_select on support_tickets;
create policy tickets_select on support_tickets for select to busna_app
  using ((tenant_id = app.cur_tenant() and (requester_user_id = app.cur_user() or (app.is_staff() and queue = 'tenant')))
         or (app.is_platform() and queue = 'platform'));

create or replace function app.ticket_visible(p_ticket uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from support_tickets t where t.id = p_ticket and (
    (t.tenant_id = app.cur_tenant() and (t.requester_user_id = app.cur_user() or (app.is_staff() and t.queue = 'tenant')))
    or (app.is_platform() and t.queue = 'platform')))
$$;
create or replace function app.ticket_agent(p_ticket uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from support_tickets t where t.id = p_ticket and (
    (t.tenant_id = app.cur_tenant() and app.is_staff() and t.queue = 'tenant')
    or (app.is_platform() and t.queue = 'platform')))
$$;

drop policy kb_select on knowledge_articles;
create policy kb_select on knowledge_articles for select to busna_app
  using ((tenant_id is null and (status = 'published' or app.is_platform()))
         or (tenant_id = app.cur_tenant() and (status = 'published' or app.is_staff())));
drop policy kb_write on knowledge_articles;
create policy kb_write on knowledge_articles for all to busna_app
  using ((tenant_id = app.cur_tenant() and app.cur_role() = 'tenant_admin') or (tenant_id is null and app.is_platform()))
  with check ((tenant_id = app.cur_tenant() and app.cur_role() = 'tenant_admin') or (tenant_id is null and app.is_platform()));

drop policy audit_insert on audit_logs;
create policy audit_insert on audit_logs for insert to busna_app
  with check (actor_user_id = app.cur_user() and (tenant_id = app.cur_tenant() or app.is_platform()));

-- فريق المنصة يكتب حدث إشعار "وصول دعم" لجهة أخرى فقط
create policy outbox_insert_platform on outbox_events for insert to busna_app
  with check (app.is_platform() and kind = 'support_access');

grant select, insert, update on platform_invites to busna_app;
grant select, insert, update, delete on platform_plans to busna_app;
grant select, insert, update on tenant_subscriptions to busna_app;
grant select, insert, update on platform_access_grants to busna_app;
grant select, insert, update on platform_invites, platform_access_grants to busna_auth;
grant select (platform_role) on users to busna_auth;
grant update (platform_role) on users to busna_auth;
grant select on platform_access_grants to busna_worker;
grant select (platform_role) on users to busna_worker;

revoke all on function app.tenant_plan(), app.is_platform() from public;
grant execute on function app.tenant_plan(), app.is_platform(), app.enforce_plan_limit(), app.sync_platform_flag() to busna_app, busna_auth, busna_worker;
