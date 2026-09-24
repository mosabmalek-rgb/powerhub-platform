-- PowerHub: allow an authenticated user to recover from a stale device lock.
-- The server passes the authenticated user's own id; the device argument is
-- retained for RPC compatibility but is intentionally not used for deletion.
-- This preserves single-device enforcement on claim while allowing recovery
-- when the original browser/device identity is unavailable.

create or replace function public.powerhub_release_user_device(
  p_user_id uuid,
  p_device_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.powerhub_user_device_locks
  where user_id = p_user_id;

  return found;
end;
$$;

revoke all on function public.powerhub_release_user_device(uuid, uuid) from public;
revoke all on function public.powerhub_release_user_device(uuid, uuid) from anon;
revoke all on function public.powerhub_release_user_device(uuid, uuid) from authenticated;
grant execute on function public.powerhub_release_user_device(uuid, uuid) to service_role;

alter function public.powerhub_release_user_device(uuid, uuid) owner to postgres;
