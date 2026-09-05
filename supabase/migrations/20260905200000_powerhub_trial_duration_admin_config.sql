alter table public.tenant_subscriptions
  add column if not exists trial_duration_days integer;

alter table public.tenant_subscriptions
  drop constraint if exists tenant_subscriptions_trial_duration_days_check;

alter table public.tenant_subscriptions
  add constraint tenant_subscriptions_trial_duration_days_check
  check (trial_duration_days is null or trial_duration_days between 1 and 3650);

create or replace function public.powerhub_apply_trial_duration()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.status = 'trial' then
    new.trial_duration_days := greatest(1, coalesce(new.trial_duration_days, 8));
    if new.started_at is null then
      new.started_at := now();
    end if;
    new.ends_at := new.started_at + make_interval(days => new.trial_duration_days);
    new.auto_renew := false;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_powerhub_trial_duration on public.tenant_subscriptions;
create trigger trg_powerhub_trial_duration
before insert or update of status, started_at, ends_at, trial_duration_days
on public.tenant_subscriptions
for each row execute function public.powerhub_apply_trial_duration();

comment on column public.tenant_subscriptions.trial_duration_days is 'Admin-configurable trial duration in days; defaults to 8 when status is trial.';
