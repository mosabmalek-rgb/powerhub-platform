-- Finalize quota authority on package base + active subscription add-ons.
-- Manual quota controls remain only as a legacy record for audit/history; they no longer affect effective quota.

create or replace function public.powerhub_effective_tenant_quota(
  p_tenant_id bigint,
  p_resource text,
  p_at timestamptz default now()
)
returns integer
language plpgsql
security definer
set search_path=public,pg_temp
as $function$
declare
  v_package_code text;
  v_catalog jsonb;
  v_base integer:=0;
  v_delta integer:=0;
begin
  if p_resource not in('subscribers','platformUser','fieldUser','branch','sms') then
    raise exception 'INVALID_QUOTA_RESOURCE' using errcode='P0001';
  end if;

  select ts.package_code into v_package_code
  from public.tenant_subscriptions ts
  where ts.tenant_id=p_tenant_id
  order by ts.ends_at desc nulls last,ts.id desc
  limit 1;

  select p into v_catalog
  from jsonb_array_elements(coalesce(
    (select value->'packages' from public.platform_settings
     where setting_key='subscription_package_catalog' and is_enabled=true),
    '[]'::jsonb
  )) p
  where p->>'code'=v_package_code
    and coalesce((p->>'active')::boolean,true)=true
  limit 1;

  v_base:=case p_resource
    when 'subscribers' then coalesce((v_catalog->>'includedSubscribers')::integer,0)
    when 'platformUser' then coalesce((v_catalog->>'platformUsers')::integer,0)
    when 'fieldUser' then coalesce((v_catalog->>'fieldUsers')::integer,0)
    when 'branch' then coalesce((v_catalog->>'branches')::integer,0)
    when 'sms' then coalesce((v_catalog->'features'->'sms'->>'limit')::integer,(v_catalog->>'includedMessages')::integer,0)
  end;

  select coalesce(sum(quantity*case when addon_code='subscribers50' and p_resource='subscribers' then 50 else 1 end),0)::integer
  into v_delta
  from public.tenant_addon_requests
  where tenant_id=p_tenant_id
    and status='approved'
    and addon_code=case
      when p_resource='subscribers' then 'subscribers50'
      when p_resource='platformUser' then 'platformUser'
      when p_resource='fieldUser' then 'fieldUser'
      when p_resource='branch' then 'branch'
      when p_resource='sms' then 'sms'
    end
    and (starts_at is null or starts_at<=p_at)
    and (ends_at is null or ends_at>p_at);

  if p_resource='sms' then
    select v_delta+coalesce(sum(l.credited_messages),0)::integer into v_delta
    from public.tenant_sms_recharge_ledger l
    where l.tenant_id=p_tenant_id
      and l.status in('provider_confirmed','manual_confirmed')
      and l.confirmed_at is not null
      and (l.request_id is null or exists(
        select 1 from public.sms_package_requests r
        join public.tenant_subscriptions ts on ts.id=r.subscription_id
        where r.id=l.request_id and ts.ends_at>p_at
      ));
  end if;

  return v_base+coalesce(v_delta,0);
end;
$function$;

revoke all on function public.powerhub_effective_tenant_quota(bigint,text,timestamptz) from public,anon,authenticated;
grant execute on function public.powerhub_effective_tenant_quota(bigint,text,timestamptz) to service_role;
