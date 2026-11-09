-- =====================================================================
-- المرحلة 3: تذاكر الدعم، قاعدة المعرفة، «مساعد باصنا»
-- التذاكر تُوجَّه إلى طابور الجهة (تشغيل النقل) أو طابور المنصة (استخدام التطبيق).
-- =====================================================================

create table support_tickets (
  id                uuid primary key default gen_random_uuid(),
  ref               bigserial unique,
  tenant_id         uuid not null references tenants(id) on delete cascade,
  queue             text not null check (queue in ('tenant', 'platform')),
  category          text not null check (category in ('app_usage', 'trip', 'absence', 'payment', 'safety', 'account', 'other')),
  subject           text not null check (length(subject) between 3 and 200),
  status            text not null default 'open' check (status in ('open', 'in_progress', 'waiting_user', 'resolved', 'closed')),
  priority          text not null default 'normal' check (priority in ('normal', 'high', 'urgent')),
  requester_user_id uuid not null references users(id) on delete cascade,
  requester_role    text not null,
  student_id        uuid references students(id) on delete set null,
  trip_id           uuid references trips(id) on delete set null,
  source            text not null default 'app' check (source in ('app', 'web', 'assistant')),
  conversation_id   uuid,
  assigned_to       uuid references users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  last_activity_at  timestamptz not null default now(),
  resolved_at       timestamptz
);
create index on support_tickets (tenant_id, queue, status);
create index on support_tickets (queue, status) where queue = 'platform';
create index on support_tickets (requester_user_id);
create trigger support_tickets_touch before update on support_tickets for each row execute function app.touch_updated_at();

create table ticket_messages (
  id             uuid primary key default gen_random_uuid(),
  ticket_id      uuid not null references support_tickets(id) on delete cascade,
  tenant_id      uuid not null references tenants(id) on delete cascade,
  author_user_id uuid references users(id) on delete set null,
  author_kind    text not null check (author_kind in ('requester', 'agent', 'assistant', 'system')),
  body           text not null check (length(body) between 1 and 5000),
  internal       boolean not null default false,
  created_at     timestamptz not null default now()
);
create index on ticket_messages (ticket_id, created_at);

-- ---------------- قاعدة المعرفة ----------------
-- tenant_id = null: مقالات المنصة العامة عن استخدام التطبيق (يديرها مدير المنصة)
create table knowledge_articles (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid references tenants(id) on delete cascade,
  audience   text[] not null default '{parent,driver,staff}' check (audience <@ array['parent','driver','staff']::text[]),
  title      text not null check (length(title) between 3 and 200),
  body       text not null check (length(body) between 3 and 8000),
  tags       text[] not null default '{}',
  status     text not null default 'published' check (status in ('published', 'draft')),
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on knowledge_articles (tenant_id, status);
create trigger knowledge_articles_touch before update on knowledge_articles for each row execute function app.touch_updated_at();

-- ---------------- المساعد ----------------
create table assistant_conversations (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  role            text not null,
  provider        text not null,
  created_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);
create index on assistant_conversations (user_id, last_message_at desc);
create index on assistant_conversations (tenant_id, last_message_at);

-- model_message: رسالة بصيغة المزود لإعادة التشغيل (إضافة فقط)؛ display: ما يُعرض للمستخدم
create table assistant_messages (
  id              bigserial primary key,
  conversation_id uuid not null references assistant_conversations(id) on delete cascade,
  tenant_id       uuid not null references tenants(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  model_message   jsonb,
  display         jsonb,
  created_at      timestamptz not null default now()
);
create index on assistant_messages (conversation_id, id);

-- إجراءات تنتظر تأكيد المستخدم قبل التنفيذ (لا يُنفّذها النموذج بنفسه)
create table assistant_actions (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid references assistant_conversations(id) on delete cascade,
  tenant_id       uuid not null references tenants(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  tool            text not null,
  params          jsonb not null,
  summary         text not null,
  status          text not null default 'pending' check (status in ('pending', 'confirmed', 'cancelled', 'expired', 'failed')),
  result          jsonb,
  expires_at      timestamptz not null default now() + interval '30 minutes',
  created_at      timestamptz not null default now(),
  decided_at      timestamptz,
  -- يُبلَّغ النموذج بنتيجة التأكيد في أول رسالة لاحقة (ثم يُعلَّم)
  reported_to_model boolean not null default false
);
create index on assistant_actions (user_id, status);

-- سجل تدقيق لاستدعاءات الأدوات: أسماء الحقول والنتيجة فقط، بدون القيم الحساسة
create table assistant_tool_log (
  id              bigserial primary key,
  conversation_id uuid,
  tenant_id       uuid not null references tenants(id) on delete cascade,
  user_id         uuid references users(id) on delete set null,
  tool            text not null,
  arg_keys        text[] not null default '{}',
  outcome         text not null check (outcome in ('ok', 'denied', 'not_found', 'error', 'needs_confirmation', 'invalid')),
  duration_ms     int,
  created_at      timestamptz not null default now()
);
create index on assistant_tool_log (tenant_id, created_at desc);

create table assistant_usage (
  tenant_id     uuid not null references tenants(id) on delete cascade,
  user_id       uuid not null references users(id) on delete cascade,
  day           date not null,
  requests      int not null default 0,
  input_tokens  bigint not null default 0,
  output_tokens bigint not null default 0,
  primary key (tenant_id, user_id, day)
);

-- ---------------- دوال مساعدة ----------------
create or replace function app.ticket_visible(p_ticket uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from support_tickets t where t.id = p_ticket and (
    (t.tenant_id = app.cur_tenant() and (t.requester_user_id = app.cur_user() or (app.is_staff() and t.queue = 'tenant')))
    or (app.cur_role() = 'platform_admin' and t.queue = 'platform')))
$$;

create or replace function app.ticket_agent(p_ticket uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from support_tickets t where t.id = p_ticket and (
    (t.tenant_id = app.cur_tenant() and app.is_staff() and t.queue = 'tenant')
    or (app.cur_role() = 'platform_admin' and t.queue = 'platform')))
$$;

create or replace function app.ticket_tenant(p_ticket uuid) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select tenant_id from support_tickets where id = p_ticket
$$;

-- استهلاك المساعد اليوم (أعداد فقط) لتطبيق حدود الاستخدام والتكلفة
create or replace function app.assistant_usage_today() returns table (tenant_requests bigint, user_requests bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(requests), 0)::bigint,
         coalesce(sum(requests) filter (where user_id = app.cur_user()), 0)::bigint
  from assistant_usage where tenant_id = app.cur_tenant() and day = current_date
$$;

-- غير الموظف (صاحب التذكرة) يستطيع فقط إغلاقها أو إعادة فتحها وتحديث وقت النشاط
create or replace function app.tickets_guard() returns trigger language plpgsql as $$
begin
  if current_user = 'busna_worker' then return new; end if;
  if not app.ticket_agent(old.id) then
    if new.queue is distinct from old.queue or new.category is distinct from old.category
       or new.priority is distinct from old.priority or new.assigned_to is distinct from old.assigned_to
       or new.subject is distinct from old.subject or new.requester_user_id is distinct from old.requester_user_id
       or new.tenant_id is distinct from old.tenant_id
       or (new.status is distinct from old.status and new.status not in ('closed', 'open')) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger support_tickets_guard before update on support_tickets for each row execute function app.tickets_guard();

-- ---------------- RLS ----------------
do $$
declare t text;
begin
  foreach t in array array['support_tickets','ticket_messages','knowledge_articles','assistant_conversations',
    'assistant_messages','assistant_actions','assistant_tool_log','assistant_usage']
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

create policy tickets_select on support_tickets for select to busna_app
  using ((tenant_id = app.cur_tenant() and (requester_user_id = app.cur_user() or (app.is_staff() and queue = 'tenant')))
         or (app.cur_role() = 'platform_admin' and queue = 'platform'));
create policy tickets_insert on support_tickets for insert to busna_app
  with check (tenant_id = app.cur_tenant() and requester_user_id = app.cur_user() and status = 'open'
              and app.cur_role() in ('tenant_admin', 'supervisor', 'driver', 'parent'));
create policy tickets_update on support_tickets for update to busna_app
  using (app.ticket_agent(id) or (tenant_id = app.cur_tenant() and requester_user_id = app.cur_user()))
  with check (app.ticket_agent(id) or (tenant_id = app.cur_tenant() and requester_user_id = app.cur_user()));

create policy tmsg_select on ticket_messages for select to busna_app
  using (app.ticket_visible(ticket_id) and (not internal or app.ticket_agent(ticket_id)));
create policy tmsg_insert on ticket_messages for insert to busna_app
  with check (app.ticket_visible(ticket_id) and author_user_id = app.cur_user()
              and tenant_id = app.ticket_tenant(ticket_id)
              and (not internal or app.ticket_agent(ticket_id))
              and author_kind in ('requester', 'agent'));

create policy kb_select on knowledge_articles for select to busna_app
  using ((tenant_id is null and (status = 'published' or app.cur_role() = 'platform_admin'))
         or (tenant_id = app.cur_tenant() and (status = 'published' or app.is_staff())));
create policy kb_write on knowledge_articles for all to busna_app
  using ((tenant_id = app.cur_tenant() and app.cur_role() = 'tenant_admin') or (tenant_id is null and app.cur_role() = 'platform_admin'))
  with check ((tenant_id = app.cur_tenant() and app.cur_role() = 'tenant_admin') or (tenant_id is null and app.cur_role() = 'platform_admin'));

create policy conv_own on assistant_conversations for all to busna_app
  using (user_id = app.cur_user() and tenant_id = app.cur_tenant())
  with check (user_id = app.cur_user() and tenant_id = app.cur_tenant());
create policy amsg_own on assistant_messages for all to busna_app
  using (user_id = app.cur_user() and tenant_id = app.cur_tenant())
  with check (user_id = app.cur_user() and tenant_id = app.cur_tenant());
create policy aact_own on assistant_actions for all to busna_app
  using (user_id = app.cur_user() and tenant_id = app.cur_tenant())
  with check (user_id = app.cur_user() and tenant_id = app.cur_tenant());
create policy alog_insert on assistant_tool_log for insert to busna_app
  with check (user_id = app.cur_user() and tenant_id = app.cur_tenant());
create policy alog_select on assistant_tool_log for select to busna_app
  using (tenant_id = app.cur_tenant() and (user_id = app.cur_user() or app.cur_role() = 'tenant_admin'));
create policy ausage_own on assistant_usage for all to busna_app
  using (user_id = app.cur_user() and tenant_id = app.cur_tenant())
  with check (user_id = app.cur_user() and tenant_id = app.cur_tenant());

-- الخدمات
create policy worker_service on support_tickets for all to busna_worker using (true) with check (true);
create policy worker_service on ticket_messages for all to busna_worker using (true) with check (true);
create policy worker_service on assistant_conversations for all to busna_worker using (true) with check (true);
create policy worker_service on assistant_actions for all to busna_worker using (true) with check (true);
create policy worker_service on assistant_tool_log for all to busna_worker using (true) with check (true);

grant select, insert, update on support_tickets, ticket_messages to busna_app;
grant select, insert, update, delete on knowledge_articles to busna_app;
grant select, insert, update, delete on assistant_conversations, assistant_messages, assistant_actions, assistant_usage to busna_app;
grant select, insert on assistant_tool_log to busna_app;
grant usage on sequence support_tickets_ref_seq, assistant_messages_id_seq, assistant_tool_log_id_seq to busna_app;
grant select on support_tickets, ticket_messages to busna_worker;
grant select, delete on assistant_conversations to busna_worker;
grant select, update, delete on assistant_actions to busna_worker;
grant select, delete on assistant_tool_log to busna_worker;

revoke all on function app.ticket_visible(uuid), app.ticket_agent(uuid), app.ticket_tenant(uuid), app.assistant_usage_today() from public;
grant execute on function app.ticket_visible(uuid), app.ticket_agent(uuid), app.ticket_tenant(uuid), app.assistant_usage_today(), app.tickets_guard() to busna_app;

-- ---------------- مقالات المنصة الأساسية (عامة، عن استخدام التطبيق فقط) ----------------
insert into knowledge_articles (tenant_id, audience, title, body, tags) values
 (null, '{parent}', 'كيف أتابع رحلة ابني؟',
  'من الشاشة الرئيسية اختر بطاقة ابنك ثم «تتبع الباص». يظهر موقع الباص أثناء الرحلة الجارية فقط، ويظهر بجانبه وقت آخر تحديث. إذا ظهر «آخر تحديث منذ…» فالموقع قد لا يكون الحالي.', '{تتبع,موقع,رحلة}'),
 (null, '{parent}', 'كيف أبلغ عن غياب ابني؟',
  'من بطاقة ابنك اختر «طلب غياب»، ثم حدد التاريخ والرحلة (ذهاب، عودة، أو كلاهما) واضغط إرسال ثم تأكيد. يمكنك إلغاء الطلب لاحقًا من نفس الشاشة إذا لم يمضِ تاريخه.', '{غياب,إجازة}'),
 (null, '{parent,driver,staff}', 'لماذا لا تصلني الإشعارات؟',
  'تأكد من السماح بإشعارات تطبيق باصنا من إعدادات الجوال. جميع الإشعارات محفوظة أيضًا في شاشة «الإشعارات» داخل التطبيق.', '{إشعارات}'),
 (null, '{driver}', 'كيف أبدأ الرحلة وأشارك الموقع؟',
  'افتح الرحلة من «رحلاتي اليوم» واضغط «بدء الرحلة» ووافق على إذن الموقع واختر «السماح دائمًا» حتى يستمر الإرسال والشاشة مقفلة. يتوقف إرسال الموقع تلقائيًا عند إنهاء الرحلة.', '{موقع,بدء,رحلة}'),
 (null, '{driver}', 'ماذا أفعل إذا انقطع الإنترنت أثناء الرحلة؟',
  'استمر في تسجيل الصعود والنزول كالمعتاد؛ يحفظ التطبيق الأحداث والمواقع على الجوال ويرسلها تلقائيًا عند عودة الاتصال دون تكرار. إنهاء الرحلة يحتاج اتصالًا لمزامنة كل الأحداث أولًا.', '{انقطاع,اتصال,مزامنة}'),
 (null, '{driver}', 'لماذا لا أستطيع تسجيل نزول طالب؟',
  'لا يسمح النظام بتسجيل نزول طالب لم يُسجّل صعوده. إذا صعد الطالب فعلًا دون تسجيل، أبلغ المشرف ليصحح الحالة مع ذكر السبب.', '{نزول,صعود,تصحيح}'),
 (null, '{staff}', 'كيف أضيف طالبًا وأعيّنه لمسار؟',
  'من «الطلاب» اضغط «إضافة». ثم من «المسارات» افتح المسار واختر الطالب ونقطة التوقف واضغط «إضافة». الرحلات التي تُنشأ بعد ذلك تتضمن الطالب.', '{طالب,مسار,تعيين}');

-- مدير المنصة يرى أسماء أصحاب تذاكر طابور المنصة فقط (للدعم)، دون باقي المستخدمين
create policy users_select_platform_support on users for select to busna_app
  using (app.cur_role() = 'platform_admin'
         and exists (select 1 from support_tickets t where t.requester_user_id = users.id and t.queue = 'platform'));
