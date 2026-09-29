-- Move invoice-notification scheduling from Vercel Cron to Supabase Cron.
-- The callback secret must be provisioned separately in Supabase Vault and is
-- never stored in Git, cron.job, or the application source.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net;

do $$
begin
  if not exists (
    select 1
    from vault.decrypted_secrets
    where name = 'powerhub_cron_secret'
    limit 1
  ) then
    raise exception 'Missing Vault secret: powerhub_cron_secret';
  end if;
end
$$;

do $$
begin
  perform cron.unschedule('powerhub-invoice-notifications');
exception
  when others then
    -- The job may not exist on a fresh environment.
    null;
end
$$;

select cron.schedule(
  'powerhub-invoice-notifications',
  '* * * * *',
  $cron$
  select net.http_post(
    url := 'https://powerhub-platform.vercel.app/api/scheduled/process-invoice-notifications',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'powerhub_cron_secret'
        limit 1
      ),
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
      'Authorization', 'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'powerhub_cron_secret'
        limit 1
      ),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  ) as request_id;
  $cron$
);

revoke all on vault.decrypted_secrets from anon, authenticated;
