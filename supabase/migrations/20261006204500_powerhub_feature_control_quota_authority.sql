-- Make tenant-level Features & Limits controls affect the same effective quota authority used by runtime guards.
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
  v_override integer;
  v_delta integer:=0;
  v_overrides jsonb;
begin
  if p_resource not in ('subscribers','platformUser','fieldUser','branch','sms') then
    raise exception 'INVALID_QUOTA_RESOURCE' using errcode='P0001';
  end if;

  select ts.package_code into v_package_code
  from public.tenant_subscriptions ts
  where ts.tenant_id=p_tenant_id
  order by ts.ends_at desc nulls last, ts.id desc
  limit 1;

  select p into v_catalog
  from jsonb_array_elements(
    coalesce(
      (select value->'packages'
       from public.platform_settings
       where setting_key='subscription_package_catalog'
         and is_enabled=true),
      '[]'::jsonb
    )
  ) p
  where p->>'code'=v_package_code
    and coalesce((p->>'active')::boolean,true)=true
  limit 1;

  v_base:=case p_resource
    when 'subscribers' then coalesce((v_catalog->>'includedSubscribers')::integer,0)
    when 'platformUser' then coalesce((v_catalog->>'platformUsers')::integer,0)
    when 'fieldUser' then coalesce((v_catalog->>'fieldUsers')::integer,0)
    when 'branch' then coalesce((v_catalog->>'branches')::integer,0)
    when 'sms' then coalesce(
      (v_catalog->'features'->'sms'->>'limit')::integer,
      (v_catalog->>'includedMessages')::integer,
      0
    )
  end;

  if p_resource <> 'sms' then
    select coalesce(value->'overrides'->p_tenant_id::text,'{}'::jsonb) into v_overrides
    from public.platform_settings
    where setting_key='owner_limit_overrides';

    if p_resource='subscribers' then
      v_override:=case when (v_overrides->>'subscriberLimit')~'^\\d+

  select coalesce(
    sum(
      quantity * case
        when addon_code='subscribers50' and p_resource='subscribers' then 50
        else 1
      end
    ),
    0
  )::integer
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
    select v_delta + coalesce(sum(l.credited_messages),0)::integer
      into v_delta
    from public.tenant_sms_recharge_ledger l
    where l.tenant_id=p_tenant_id
      and l.status in ('provider_confirmed','manual_confirmed')
      and l.confirmed_at is not null
      and (l.request_id is null or exists (
        select 1
        from public.sms_package_requests r
        join public.tenant_subscriptions ts on ts.id=r.subscription_id
        where r.id=l.request_id
          and ts.ends_at>p_at
      ));
  end if;

  return v_base + coalesce(v_delta,0);
end;
$function$;

revoke all on function public.powerhub_effective_tenant_quota(bigint,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.powerhub_effective_tenant_quota(bigint,text,timestamptz)
  to service_role;

 then (v_overrides->>'subscriberLimit')::integer end;
    elsif p_resource='platformUser' then
      v_override:=case when (v_overrides->>'subaccountLimit')~'^\\d+

  select coalesce(
    sum(
      quantity * case
        when addon_code='subscribers50' and p_resource='subscribers' then 50
        else 1
      end
    ),
    0
  )::integer
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
    select v_delta + coalesce(sum(l.credited_messages),0)::integer
      into v_delta
    from public.tenant_sms_recharge_ledger l
    where l.tenant_id=p_tenant_id
      and l.status in ('provider_confirmed','manual_confirmed')
      and l.confirmed_at is not null
      and (l.request_id is null or exists (
        select 1
        from public.sms_package_requests r
        join public.tenant_subscriptions ts on ts.id=r.subscription_id
        where r.id=l.request_id
          and ts.ends_at>p_at
      ));
  end if;

  return v_base + coalesce(v_delta,0);
end;
$function$;

revoke all on function public.powerhub_effective_tenant_quota(bigint,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.powerhub_effective_tenant_quota(bigint,text,timestamptz)
  to service_role;

 then (v_overrides->>'subaccountLimit')::integer end;
    elsif p_resource='fieldUser' then
      v_override:=case when (v_overrides->>'fieldUserLimit')~'^\\d+

  select coalesce(
    sum(
      quantity * case
        when addon_code='subscribers50' and p_resource='subscribers' then 50
        else 1
      end
    ),
    0
  )::integer
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
    select v_delta + coalesce(sum(l.credited_messages),0)::integer
      into v_delta
    from public.tenant_sms_recharge_ledger l
    where l.tenant_id=p_tenant_id
      and l.status in ('provider_confirmed','manual_confirmed')
      and l.confirmed_at is not null
      and (l.request_id is null or exists (
        select 1
        from public.sms_package_requests r
        join public.tenant_subscriptions ts on ts.id=r.subscription_id
        where r.id=l.request_id
          and ts.ends_at>p_at
      ));
  end if;

  return v_base + coalesce(v_delta,0);
end;
$function$;

revoke all on function public.powerhub_effective_tenant_quota(bigint,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.powerhub_effective_tenant_quota(bigint,text,timestamptz)
  to service_role;

 then (v_overrides->>'fieldUserLimit')::integer end;
    else
      v_override:=case when (v_overrides->>'branchLimit')~'^\\d+

  select coalesce(
    sum(
      quantity * case
        when addon_code='subscribers50' and p_resource='subscribers' then 50
        else 1
      end
    ),
    0
  )::integer
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
    select v_delta + coalesce(sum(l.credited_messages),0)::integer
      into v_delta
    from public.tenant_sms_recharge_ledger l
    where l.tenant_id=p_tenant_id
      and l.status in ('provider_confirmed','manual_confirmed')
      and l.confirmed_at is not null
      and (l.request_id is null or exists (
        select 1
        from public.sms_package_requests r
        join public.tenant_subscriptions ts on ts.id=r.subscription_id
        where r.id=l.request_id
          and ts.ends_at>p_at
      ));
  end if;

  return v_base + coalesce(v_delta,0);
end;
$function$;

revoke all on function public.powerhub_effective_tenant_quota(bigint,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.powerhub_effective_tenant_quota(bigint,text,timestamptz)
  to service_role;

 then (v_overrides->>'branchLimit')::integer end;
    end if;

    v_base:=greatest(0,coalesce(v_override,v_base));
  end if;
  -- Tenant-level feature controls are the authoritative per-owner limit override.
  declare
    v_control record;
    v_control_feature text;
  begin
    v_control_feature:=case p_resource
      when 'subscribers' then 'subscriber_management'
      when 'platformUser' then 'platform_users'
      when 'fieldUser' then 'field_users'
      when 'branch' then 'branch_management'
      when 'sms' then 'sms'
    end;
    select c.limit_mode,c.manual_limit into v_control
    from public.tenant_feature_controls c
    where c.tenant_id=p_tenant_id and c.feature_key=v_control_feature
    order by c.updated_at desc nulls last,c.id desc limit 1;
    if coalesce(v_control.limit_mode,'inherit')='manual' and v_control.manual_limit is not null then
      v_base:=greatest(0,v_control.manual_limit);
    elsif coalesce(v_control.limit_mode,'inherit')='unlimited' then
      v_base:=2147483647;
    end if;
  end;

  select coalesce(
    sum(
      quantity * case
        when addon_code='subscribers50' and p_resource='subscribers' then 50
        else 1
      end
    ),
    0
  )::integer
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
    select v_delta + coalesce(sum(l.credited_messages),0)::integer
      into v_delta
    from public.tenant_sms_recharge_ledger l
    where l.tenant_id=p_tenant_id
      and l.status in ('provider_confirmed','manual_confirmed')
      and l.confirmed_at is not null
      and (l.request_id is null or exists (
        select 1
        from public.sms_package_requests r
        join public.tenant_subscriptions ts on ts.id=r.subscription_id
        where r.id=l.request_id
          and ts.ends_at>p_at
      ));
  end if;

  return v_base + coalesce(v_delta,0);
end;
$function$;

revoke all on function public.powerhub_effective_tenant_quota(bigint,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.powerhub_effective_tenant_quota(bigint,text,timestamptz)
  to service_role;


