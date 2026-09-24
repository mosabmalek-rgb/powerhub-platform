-- PowerHub: recover an idle browser from a stale single-device lock.
-- The lock remains strict while the previous device is actively making requests.
-- An idle lock is recoverable after 15 minutes, preventing a login loop after
-- browser storage/device identity drift without disabling single-device control.

create or replace function public.powerhub_claim_user_device(
  p_user_id uuid,
  p_device_id uuid,
  p_lease_until timestamp with time zone
)
returns table(allowed boolean, locked_until timestamp with time zone, active_device_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.powerhub_user_device_locks%rowtype;
  v_stale boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select *
    into v_existing
  from public.powerhub_user_device_locks
  where user_id = p_user_id
  for update;

  v_stale := found
    and v_existing.locked_until > now()
    and v_existing.device_id <> p_device_id
    and coalesce(v_existing.last_seen_at, v_existing.updated_at, v_existing.created_at) <= now() - interval '15 minutes';

  if not found
     or v_existing.locked_until <= now()
     or v_existing.device_id = p_device_id
     or v_stale then
    insert into public.powerhub_user_device_locks (
      user_id,
      device_id,
      locked_until,
      last_seen_at,
      updated_at
    )
    values (
      p_user_id,
      p_device_id,
      p_lease_until,
      now(),
      now()
    )
    on conflict (user_id) do update
      set device_id = excluded.device_id,
          locked_until = excluded.locked_until,
          last_seen_at = now(),
          updated_at = now();

    return query
      select true, p_lease_until, p_device_id;
    return;
  end if;

  return query
    select false, v_existing.locked_until, v_existing.device_id;
end;
$$;

revoke all on function public.powerhub_claim_user_device(uuid, uuid, timestamptz) from public;
revoke all on function public.powerhub_claim_user_device(uuid, uuid, timestamptz) from anon;
revoke all on function public.powerhub_claim_user_device(uuid, uuid, timestamptz) from authenticated;
grant execute on function public.powerhub_claim_user_device(uuid, uuid, timestamptz) to service_role;
alter function public.powerhub_claim_user_device(uuid, uuid, timestamptz) owner to postgres;
