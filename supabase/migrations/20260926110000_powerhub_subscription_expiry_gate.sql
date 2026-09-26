-- Prevent expired subscriptions from retaining access solely because auto_renew is enabled.
-- Automatic renewal is not performed by this gate; access must stop when ends_at is reached.
create or replace function public.powerhub_subscription_allows(p_tenant_id bigint,p_capability text)
returns boolean
language plpgsql
stable
set search_path=public,pg_temp
as $$
declare
  s public.tenant_subscriptions%rowtype;
begin
  select * into s
  from public.tenant_subscriptions
  where tenant_id=p_tenant_id
  order by created_at desc,id desc
  limit 1;

  if not found then return false; end if;
  if s.status in ('suspended','expired','cancelled','archived') then return false; end if;
  if s.ends_at is not null and s.ends_at <= now() then return false; end if;

  return p_capability in ('onboarding','branch','generator','tariff','subscriber','reading');
end;
$$;

revoke all on function public.powerhub_subscription_allows(bigint,text) from public,anon,authenticated;
grant execute on function public.powerhub_subscription_allows(bigint,text) to service_role;
