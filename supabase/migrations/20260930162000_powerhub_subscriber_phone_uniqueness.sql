-- Prevent future duplicate subscriber phone numbers within the same tenant.
-- Existing duplicate test/historical rows are preserved; new inserts/updates are blocked.
create or replace function public.powerhub_guard_subscriber_phone_unique()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(new.tenant_id, hashtext('powerhub-subscriber-phone')::bigint);

  if exists (
    select 1
    from public.subscribers s
    where s.tenant_id = new.tenant_id
      and s.phone = new.phone
      and s.id <> coalesce(new.id, 0)
  ) then
    raise exception 'DUPLICATE_SUBSCRIBER_PHONE' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists powerhub_guard_subscriber_phone_unique on public.subscribers;

create trigger powerhub_guard_subscriber_phone_unique
before insert or update of tenant_id, phone on public.subscribers
for each row
execute function public.powerhub_guard_subscriber_phone_unique();

revoke all on function public.powerhub_guard_subscriber_phone_unique() from public, anon, authenticated;
grant execute on function public.powerhub_guard_subscriber_phone_unique() to service_role;
