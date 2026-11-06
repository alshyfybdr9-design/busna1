-- =====================================================================
-- Busna — Automatic daily trip generation
-- Runs every 30 minutes; generate_trips() is idempotent, so each school gets
-- today's trips shortly after midnight in its own timezone, and late route
-- edits are picked up for trips that have not started.
-- =====================================================================
create or replace function private.generate_trips_all_schools()
returns int language plpgsql security definer set search_path = '' as $$
declare
  s record;
  n int := 0;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  for s in select id, timezone from public.schools where status = 'active' loop
    begin
      n := n + public.generate_trips(s.id, (now() at time zone s.timezone)::date);
    exception when others then
      raise warning 'generate_trips failed for school %: %', s.id, sqlerrm;
    end;
  end loop;
  return n;
end $$;
revoke execute on function private.generate_trips_all_schools() from public, authenticated;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('busna-generate-trips', '*/30 * * * *', 'select private.generate_trips_all_schools()');
  else
    raise notice 'pg_cron not available: schedule private.generate_trips_all_schools() externally';
  end if;
end $$;
