-- Independent tenant capability for electronic payment documentation approval.
-- This capability is intentionally separate from collectPayments.
alter table public.platform_role_policies
  drop constraint if exists platform_role_policies_capability_check;

alter table public.platform_role_policies
  add constraint platform_role_policies_capability_check
  check (capability = any (array[
    'manageSubscribers','manageGenerators','recordReadings','accessFieldApp',
    'approveReadings','manageTariffs','issueInvoices','collectPayments',
    'approvePaymentDocumentation',
    'manageExpenses','managePayroll','manageTeam','manageMessaging','viewAudit'
  ]));

drop function if exists public.powerhub_admin_save_role_policy(bigint,text,text,boolean);

create function public.powerhub_admin_save_role_policy(
  p_actor_user_id bigint,
  p_role text,
  p_capability text,
  p_is_allowed boolean
)
returns table(success boolean, policy_id bigint, role text, capability text, is_allowed boolean, replayed boolean)
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare v_id bigint;
begin
  if not exists (select 1 from public.users where id=p_actor_user_id and role='admin' and account_status='active') then
    raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode='P0001';
  end if;
  if p_role not in ('owner','manager','accountant','collector','technician','viewer') then
    raise exception 'INVALID_ROLE' using errcode='P0001';
  end if;
  if p_capability not in (
    'manageSubscribers','manageGenerators','recordReadings','accessFieldApp',
    'approveReadings','manageTariffs','issueInvoices','collectPayments',
    'approvePaymentDocumentation','manageExpenses','managePayroll',
    'manageTeam','manageMessaging','viewAudit'
  ) then
    raise exception 'INVALID_CAPABILITY' using errcode='P0001';
  end if;
  insert into public.platform_role_policies(role,capability,is_allowed,updated_by_user_id,updated_at)
  values(p_role,p_capability,p_is_allowed,p_actor_user_id,now())
  on conflict(role,capability) do update
    set is_allowed=excluded.is_allowed,updated_by_user_id=excluded.updated_by_user_id,updated_at=now()
  returning id into v_id;
  return query select true,v_id,p_role,p_capability,p_is_allowed,false;
end;
$$;

revoke execute on function public.powerhub_admin_save_role_policy(bigint,text,text,boolean) from public,anon,authenticated;
grant execute on function public.powerhub_admin_save_role_policy(bigint,text,text,boolean) to service_role;

