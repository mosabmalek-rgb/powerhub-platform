create or replace function public.powerhub_apply_trial_duration()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.status = 'trial' then
    if new.started_at is null then
      new.started_at := now();
    end if;
    if new.ends_at is null or new.ends_at <= new.started_at then
      new.ends_at := new.started_at + interval '8 days';
    end if;
    new.auto_renew := false;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_powerhub_trial_duration on public.tenant_subscriptions;
create trigger trg_powerhub_trial_duration
before insert or update of status, started_at, ends_at on public.tenant_subscriptions
for each row execute function public.powerhub_apply_trial_duration();

comment on function public.powerhub_apply_trial_duration() is 'P5 SaaS: trial duration is admin-configurable through ends_at; 8 days is the default when omitted.';
