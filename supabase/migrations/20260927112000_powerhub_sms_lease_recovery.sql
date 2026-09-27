-- PowerHub P0: recover SMS rows left in processing after a worker crash.
-- The provider call remains outside the database transaction. The lease is only
-- a safety boundary for reclaiming abandoned work; it is not a delivery claim.

alter table public.notification_messages
  add column if not exists lease_until timestamptz,
  add column if not exists claimed_by bigint references public.users(id) on delete set null,
  add column if not exists next_attempt_at timestamptz;

create index if not exists notification_messages_sms_lease_idx
  on public.notification_messages (status, lease_until, next_attempt_at, id)
  where channel = 'sms';

create or replace function public.powerhub_sync_sms_lease()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.channel = 'sms' and new.status = 'processing' and old.status is distinct from 'processing' then
    new.lease_until := now() + interval '10 minutes';
  elsif new.channel = 'sms' and new.status <> 'processing' then
    new.lease_until := null;
    new.claimed_by := null;
  end if;
  return new;
end;
$$;

drop trigger if exists notification_messages_sms_lease_trigger on public.notification_messages;
create trigger notification_messages_sms_lease_trigger
before update on public.notification_messages
for each row execute function public.powerhub_sync_sms_lease();

create or replace function public.powerhub_reclaim_stale_sms_notifications(p_limit integer default 200)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_reclaimed integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'INVALID_RECLAIM_LIMIT' using errcode = '22023';
  end if;

  with stale as (
    select id
    from public.notification_messages
    where channel = 'sms'
      and status = 'processing'
      and (lease_until is null or lease_until < now())
    order by coalesce(lease_until, created_at), id
    for update skip locked
    limit p_limit
  )
  update public.notification_messages as messages
  set status = 'pending',
      next_attempt_at = now(),
      last_error = coalesce(messages.last_error, 'استُعيدت رسالة SMS بعد انتهاء مهلة العامل.'),
      updated_at = now()
  from stale
  where messages.id = stale.id;

  get diagnostics v_reclaimed = row_count;
  return v_reclaimed;
end;
$$;

revoke all on function public.powerhub_reclaim_stale_sms_notifications(integer) from public, anon, authenticated;
grant execute on function public.powerhub_reclaim_stale_sms_notifications(integer) to service_role;
