-- Platform announcements: durable background scheduler.
-- Production uses Supabase pg_cron; no external scheduler secret is required.
create or replace function public.powerhub_publish_due_platform_announcements()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
begin
  update public.platform_announcements
     set status = 'published',
         published_at = now(),
         scheduled_at = null,
         updated_at = now()
   where status = 'scheduled'
     and scheduled_at is not null
     and scheduled_at <= now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.powerhub_publish_due_platform_announcements() from public;
grant execute on function public.powerhub_publish_due_platform_announcements() to postgres;

select cron.unschedule(jobid)
from cron.job
where jobname = 'powerhub-platform-announcements-publish';

select cron.schedule(
  'powerhub-platform-announcements-publish',
  '* * * * *',
  $$select public.powerhub_publish_due_platform_announcements();$$
);
