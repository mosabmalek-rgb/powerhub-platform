create or replace function public.powerhub_apply_trial_duration_8_days()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.status = 'trial' then
    new.ends_at := new.started_at + interval '8 days';
    new.auto_renew := false;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_powerhub_trial_duration on public.tenant_subscriptions;
create trigger trg_powerhub_trial_duration
before insert or update of status, started_at, ends_at on public.tenant_subscriptions
for each row execute function public.powerhub_apply_trial_duration_8_days();

comment on function public.powerhub_apply_trial_duration_8_days() is 'P5 SaaS: PowerHub trial subscriptions last exactly 8 days.';
