-- Move the existing field-user database guard to the unified feature policy.
-- The trigger remains the database boundary; only its source of quota changes.

create or replace function public.powerhub_enforce_field_user_quota()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_policy record;
  v_existing boolean;
begin
  if new.role <> 'technician' or new.is_active is not true then
    return new;
  end if;

  select * into v_policy
  from public.powerhub_resolve_tenant_feature_policy(new.tenant_id, 'field_users');

  if not coalesce(v_policy.eligible, false)
     or not coalesce(v_policy.enabled, false) then
    raise exception 'FIELD_USERS_FEATURE_DISABLED' using errcode = 'P0001';
  end if;

  select exists(
    select 1
    from public.staff_profiles p
    where p.tenant_id = new.tenant_id
      and p.user_id = new.user_id
      and p.role = 'technician'
      and p.is_active = true
      and p.id <> coalesce(new.id, 0)
  ) into v_existing;

  if not v_existing
     and v_policy.effective_limit is not null
     and (
       select count(distinct p.user_id)
       from public.staff_profiles p
       where p.tenant_id = new.tenant_id
         and p.role = 'technician'
         and p.is_active = true
     ) >= v_policy.effective_limit then
    raise exception 'FIELD_USER_LIMIT_REACHED' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists powerhub_enforce_field_user_quota on public.staff_profiles;
create trigger powerhub_enforce_field_user_quota
before insert or update of role, is_active, user_id, tenant_id
on public.staff_profiles
for each row execute function public.powerhub_enforce_field_user_quota();

revoke all on function public.powerhub_enforce_field_user_quota() from public, anon, authenticated;
grant execute on function public.powerhub_enforce_field_user_quota() to service_role;
