-- Move pg_net out of the exposed public schema without losing queued work.
-- pg_net is non-relocatable: Supabase requires dropping and recreating it.
-- Cron jobs are paused inside this transaction so no request can race the move.
create schema if not exists extensions;

select cron.unschedule(jobname)
from (values ('powerhub-invoice-notifications'), ('powerhub-payment-documentation-retention')) as jobs(jobname)
where exists (select 1 from cron.job where cron.job.jobname = jobs.jobname);

do $$
declare
  pending_requests bigint := 0;
begin
  if exists (
    select 1 from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pg_net' and n.nspname = 'public'
  ) then
    execute 'select count(*) from net.http_request_queue' into pending_requests;
    if pending_requests > 0 then
      raise exception 'Cannot move pg_net while % HTTP requests are queued', pending_requests;
    end if;
    drop extension pg_net;
    create extension pg_net with schema extensions;
  elsif not exists (select 1 from pg_extension where extname = 'pg_net') then
    create extension pg_net with schema extensions;
  end if;
end
$$;

-- Keep the HTTP request queue private to database roles used by the scheduler.
revoke all on schema net from anon, authenticated;
revoke all on all tables in schema net from anon, authenticated;
revoke all on all sequences in schema net from anon, authenticated;

-- Restore the existing schedules after the extension move.
select cron.schedule(
  'powerhub-invoice-notifications',
  '* * * * *',
  $cron$
  select net.http_post(
    url := 'https://powerhub-platform.vercel.app/api/scheduled/process-invoice-notifications',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'powerhub_cron_secret' limit 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  ) as request_id;
  $cron$
);

select cron.schedule(
  'powerhub-payment-documentation-retention',
  '30 2 * * *',
  $cron$
  select net.http_post(
    url := 'https://powerhub-platform.vercel.app/api/scheduled/payment-documentation-retention',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'powerhub_cron_secret' limit 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  ) as request_id;
  $cron$
);
