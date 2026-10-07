-- Unified subscription add-on management from Feature Controls.
-- Numeric resources are extended only by time-bounded add-ons.
-- Non-quantitative features remain enable/disable controls.
-- Add-ons always terminate with the active subscription end and are explicitly
-- renewed or expired with the next subscription cycle.

alter table public.tenant_addon_requests
  add column if not exists billing_mode text not null default 'free'
    check (billing_mode in ('free','paid')),
  add column if not exists source text not null default 'owner_request'
    check (source in ('owner_request','admin_grant','migration')),
  add column if not exists request_key uuid;

create unique index if not exists tenant_addon_requests_request_key_uidx
  on public.tenant_addon_requests(request_key)
  where request_key is not null;

create index if not exists tenant_addon_requests_tenant_active_idx
  on public.tenant_addon_requests(tenant_id,status,starts_at,ends_at);

-- Migrate the current manual quota model into real, time-bounded add-ons.
-- This is intentionally fail-closed for reductions/unlimited controls.
do $migration$
declare
  c record;
  v_package_code text;
  v_base integer;
  v_delta integer;
  v_addon_code text;
  v_quantity integer;
  v_site_id bigint;
  v_subscription_started timestamptz;
  v_subscription_end timestamptz;
  v_starts_at timestamptz;
  v_days integer;
  v_existing bigint;
begin
  for c in
    select tfc.id,tfc.tenant_id,tfc.feature_key,tfc.manual_limit,
           tfc.updated_by_user_id,tfc.updated_at
    from public.tenant_feature_controls tfc
    where tfc.limit_mode='manual'
  loop
    select ts.package_code,ts.started_at,ts.ends_at
      into v_package_code,v_subscription_started,v_subscription_end
    from public.tenant_subscriptions ts
    where ts.tenant_id=c.tenant_id
      and ts.status in ('trial','active')
      and (ts.ends_at is null or ts.ends_at>now())
    order by ts.created_at desc,ts.id desc
    limit 1;

    if v_package_code is null or v_subscription_end is null then
      raise exception 'MANUAL_QUOTA_MIGRATION_REQUIRES_ACTIVE_SUBSCRIPTION tenant=% feature=%',
        c.tenant_id,c.feature_key using errcode='P0001';
    end if;

    select case c.feature_key
      when 'subscriber_management' then coalesce((pkg->>'includedSubscribers')::integer,0)
      when 'platform_users' then coalesce((pkg->>'platformUsers')::integer,0)
      when 'field_users' then coalesce((pkg->>'fieldUsers')::integer,0)
      when 'branch_management' then coalesce((pkg->>'branches')::integer,0)
      when 'sms' then coalesce(
        (pkg->'features'->'sms'->>'limit')::integer,
        (pkg->>'includedMessages')::integer,
        0
      )
    end
      into v_base
    from public.platform_settings ps
    cross join lateral jsonb_array_elements(
      coalesce(ps.value->'packages','[]'::jsonb)
    ) pkg
    where ps.setting_key='subscription_package_catalog'
      and ps.is_enabled=true
      and lower(pkg->>'code')=lower(v_package_code)
    limit 1;

    if v_base is null then
      raise exception 'MANUAL_QUOTA_MIGRATION_PACKAGE_LIMIT_NOT_FOUND tenant=% feature=% package=%',
        c.tenant_id,c.feature_key,v_package_code using errcode='P0001';
    end if;

    v_delta:=c.manual_limit-v_base;

    if v_delta<0 then
      raise exception 'MANUAL_QUOTA_MIGRATION_REDUCTION_UNSUPPORTED tenant=% feature=% manual=% base=%',
        c.tenant_id,c.feature_key,c.manual_limit,v_base using errcode='P0001';
    end if;

    if v_delta=0 then
      update public.tenant_feature_controls
      set limit_mode='inherit',
          manual_limit=null,
          override_reason='تمت إعادة ضبط الحد اليدوي إلى حد الباقة أثناء توحيد نظام الإضافات.',
          updated_at=now()
      where id=c.id;
      continue;
    end if;

    v_addon_code:=case c.feature_key
      when 'subscriber_management' then 'subscribers50'
      when 'platform_users' then 'platformUser'
      when 'field_users' then 'fieldUser'
      when 'branch_management' then 'branch'
      when 'sms' then 'sms'
      else null
    end;

    if v_addon_code is null then
      raise exception 'MANUAL_QUOTA_MIGRATION_UNSUPPORTED_FEATURE tenant=% feature=%',
        c.tenant_id,c.feature_key using errcode='P0001';
    end if;

    if c.feature_key='subscriber_management' then
      if mod(v_delta,50)<>0 then
        raise exception 'MANUAL_SUBSCRIBER_LIMIT_MUST_BE_MULTIPLE_OF_50 tenant=% delta=%',
          c.tenant_id,v_delta using errcode='P0001';
      end if;
      v_quantity:=v_delta/50;
    else
      v_quantity:=v_delta;
    end if;

    select s.id
      into v_site_id
    from public.sites s
    where s.tenant_id=c.tenant_id
      and s.status<>'archived'
    order by s.id
    limit 1;

    if v_site_id is null then
      raise exception 'MANUAL_QUOTA_MIGRATION_SITE_REQUIRED tenant=% feature=%',
        c.tenant_id,c.feature_key using errcode='P0001';
    end if;

    v_starts_at:=greatest(
      coalesce(v_subscription_started,c.updated_at),
      c.updated_at
    );
    v_starts_at:=least(v_starts_at,now());
    v_days:=greatest(
      1,
      ceil(extract(epoch from (v_subscription_end-v_starts_at))/86400.0)::integer
    );

    select id into v_existing
    from public.tenant_addon_requests
    where tenant_id=c.tenant_id
      and addon_code=v_addon_code
      and source='migration'
      and starts_at=v_starts_at
      and ends_at=v_subscription_end
    order by id desc
    limit 1;

    if v_existing is null then
      insert into public.tenant_addon_requests(
        tenant_id,site_id,requested_by_user_id,addon_code,quantity,status,
        note,created_at,reviewed_at,reviewed_by_user_id,review_note,
        duration_days,starts_at,ends_at,billing_mode,source
      )
      values(
        c.tenant_id,v_site_id,coalesce(c.updated_by_user_id,1),
        v_addon_code,v_quantity,'approved',
        'ترحيل تلقائي من الحد اليدوي إلى إضافة مؤقتة مرتبطة بدورة الاشتراك.',
        coalesce(c.updated_at,now()),coalesce(c.updated_at,now()),
        coalesce(c.updated_by_user_id,1),
        'تم تحويل الزيادة السابقة إلى إضافة مجانية مرتبطة بنهاية الاشتراك.',
        v_days,v_starts_at,v_subscription_end,'free','migration'
      )
      returning id into v_existing;

      insert into public.audit_logs(
        tenant_id,site_id,user_id,entity_type,entity_id,action,before_data,after_data
      )
      values(
        c.tenant_id,v_site_id,coalesce(c.updated_by_user_id,1),
        'tenant_addon_request',v_existing::text,'migrate_manual_quota_to_addon',
        jsonb_build_object(
          'featureKey',c.feature_key,
          'manualLimit',c.manual_limit,
          'baseLimit',v_base,
          'delta',v_delta
        ),
        jsonb_build_object(
          'addonCode',v_addon_code,
          'quantity',v_quantity,
          'billingMode','free',
          'startsAt',v_starts_at,
          'endsAt',v_subscription_end
        )
      );
    end if;

    update public.tenant_feature_controls
    set limit_mode='inherit',
        manual_limit=null,
        override_reason='تم تحويل الزيادة السابقة إلى إضافة مرتبطة بالاشتراك.',
        updated_at=now()
    where id=c.id;
  end loop;

  if exists(
    select 1 from public.tenant_feature_controls
    where limit_mode='unlimited'
  ) then
    raise exception 'UNLIMITED_FEATURE_CONTROLS_MUST_BE_MIGRATED_MANUALLY' using errcode='P0001';
  end if;
end;
$migration$;

-- Admin-side direct grant. This is the mutation used by the Feature Controls
-- screen; it creates an already-approved add-on and never edits a quota limit.
create or replace function public.powerhub_admin_grant_tenant_addon(
  p_actor_user_id bigint,
  p_tenant_id bigint,
  p_feature_key text,
  p_quantity integer,
  p_billing_mode text default 'free',
  p_note text default null,
  p_request_key uuid default null
)
returns table(
  success boolean,
  request_id bigint,
  tenant_id bigint,
  feature_key text,
  addon_code text,
  quantity integer,
  display_quantity integer,
  billing_mode text,
  starts_at timestamptz,
  ends_at timestamptz,
  replayed boolean
)
language plpgsql
security definer
set search_path=public,pg_temp
as $function$
declare
  v_actor_role text;
  v_feature_type text;
  v_feature_active boolean;
  v_package_code text;
  v_policy text;
  v_subscription public.tenant_subscriptions%rowtype;
  v_addon_code text;
  v_storage_quantity integer;
  v_display_quantity integer;
  v_site_id bigint;
  v_existing public.tenant_addon_requests%rowtype;
  v_request_id bigint;
  v_now timestamptz:=now();
  v_days integer;
begin
  select platform_role into v_actor_role
  from public.users
  where id=p_actor_user_id
    and role='admin'
    and account_status='active'
    and platform_role in('platform_owner','platform_admin');

  if v_actor_role is null then
    raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501';
  end if;

  if p_tenant_id is null or not exists(
    select 1 from public.tenants where id=p_tenant_id
  ) then
    raise exception 'TENANT_NOT_FOUND' using errcode='P0001';
  end if;

  if p_quantity is null or p_quantity<1 then
    raise exception 'INVALID_ADDON_QUANTITY' using errcode='P0001';
  end if;

  if p_billing_mode not in('free','paid') then
    raise exception 'INVALID_BILLING_MODE' using errcode='P0001';
  end if;

  select fc.feature_type,fc.is_active
    into v_feature_type,v_feature_active
  from public.feature_catalog fc
  where fc.feature_key=trim(p_feature_key)
  limit 1;

  if v_feature_type is null then
    raise exception 'FEATURE_NOT_FOUND' using errcode='P0001';
  end if;

  if not v_feature_active then
    raise exception 'FEATURE_GLOBALLY_DISABLED' using errcode='P0001';
  end if;

  if v_feature_type<>'quota' then
    raise exception 'FEATURE_NOT_ADDON_MANAGEABLE' using errcode='P0001';
  end if;

  select ts.*
    into v_subscription
  from public.tenant_subscriptions ts
  where ts.tenant_id=p_tenant_id
    and ts.status in('trial','active')
    and (ts.ends_at is null or ts.ends_at>v_now)
  order by ts.created_at desc,ts.id desc
  limit 1
  for update;

  if not found or v_subscription.ends_at is null then
    raise exception 'SUBSCRIPTION_REQUIRED' using errcode='P0001';
  end if;

  v_package_code:=v_subscription.package_code;

  select p.policy
    into v_policy
  from public.package_feature_policies p
  where p.package_code=v_package_code
    and p.feature_key=trim(p_feature_key)
  limit 1;

  if coalesce(v_policy,'none') not in('included','addon') then
    raise exception 'FEATURE_NOT_AVAILABLE_IN_PACKAGE' using errcode='P0001';
  end if;

  v_addon_code:=case trim(p_feature_key)
    when 'subscriber_management' then 'subscribers50'
    when 'platform_users' then 'platformUser'
    when 'field_users' then 'fieldUser'
    when 'branch_management' then 'branch'
    when 'sms' then 'sms'
    else null
  end;

  if v_addon_code is null then
    raise exception 'FEATURE_NOT_ADDON_MANAGEABLE' using errcode='P0001';
  end if;

  if p_feature_key='subscriber_management' then
    if mod(p_quantity,50)<>0 then
      raise exception 'SUBSCRIBER_ADDON_QUANTITY_MULTIPLE_REQUIRED' using errcode='P0001';
    end if;
    v_storage_quantity:=p_quantity/50;
    v_display_quantity:=p_quantity;
  else
    v_storage_quantity:=p_quantity;
    v_display_quantity:=p_quantity;
  end if;

  select s.id into v_site_id
  from public.sites s
  where s.tenant_id=p_tenant_id
    and s.status<>'archived'
  order by s.id
  limit 1;

  if v_site_id is null then
    raise exception 'TENANT_SITE_REQUIRED_FOR_AUDIT' using errcode='P0001';
  end if;

  if p_request_key is not null then
    select * into v_existing
    from public.tenant_addon_requests
    where request_key=p_request_key
    for update;

    if found then
      if v_existing.tenant_id<>p_tenant_id
         or v_existing.addon_code<>v_addon_code
         or v_existing.quantity<>v_storage_quantity
         or v_existing.billing_mode<>p_billing_mode then
        raise exception 'ADDON_REQUEST_KEY_REUSED' using errcode='P0001';
      end if;

      return query
      select true,v_existing.id,v_existing.tenant_id,trim(p_feature_key),
        v_existing.addon_code,v_existing.quantity,v_display_quantity,
        v_existing.billing_mode,v_existing.starts_at,v_existing.ends_at,true;
      return;
    end if;
  end if;

  v_days:=greatest(
    1,
    ceil(extract(epoch from (v_subscription.ends_at-v_now))/86400.0)::integer
  );

  insert into public.tenant_addon_requests(
    tenant_id,site_id,requested_by_user_id,addon_code,quantity,status,
    note,created_at,reviewed_at,reviewed_by_user_id,review_note,
    duration_days,starts_at,ends_at,billing_mode,source,request_key
  )
  values(
    p_tenant_id,v_site_id,p_actor_user_id,v_addon_code,v_storage_quantity,'approved',
    nullif(btrim(p_note),''),
    v_now,v_now,p_actor_user_id,'منح مباشر من إدارة الميزات والحدود.',
    v_days,v_now,v_subscription.ends_at,p_billing_mode,'admin_grant',p_request_key
  )
  returning id into v_request_id;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,
    entity_type,entity_id,action,after_data
  )
  values(
    p_tenant_id,v_site_id,p_actor_user_id,v_actor_role,
    'tenant_addon_request',v_request_id::text,'grant_addon',
    jsonb_build_object(
      'featureKey',trim(p_feature_key),
      'addonCode',v_addon_code,
      'quantity',v_storage_quantity,
      'displayQuantity',v_display_quantity,
      'billingMode',p_billing_mode,
      'startsAt',v_now,
      'endsAt',v_subscription.ends_at,
      'note',p_note
    )
  );

  return query
  select true,v_request_id,p_tenant_id,trim(p_feature_key),
    v_addon_code,v_storage_quantity,v_display_quantity,
    p_billing_mode,v_now,v_subscription.ends_at,false;
end;
$function$;

revoke all on function public.powerhub_admin_grant_tenant_addon(
  bigint,bigint,text,integer,text,text,uuid
) from public,anon,authenticated;
grant execute on function public.powerhub_admin_grant_tenant_addon(
  bigint,bigint,text,integer,text,text,uuid
) to service_role;

-- All approvals, including SMS, are now aligned with the subscription end.
create or replace function public.powerhub_admin_review_tenant_addon_request(
 p_actor_user_id bigint,
 p_request_id bigint,
 p_decision text,
 p_note text default null,
 p_duration_days integer default null
)
returns table(success boolean,status text,ends_at timestamptz)
language plpgsql
security definer
set search_path=public,pg_temp
as $function$
declare
 r public.tenant_addon_requests%rowtype;
 v_actor_platform_role text;
 v_subscription_end timestamptz;
 v_start timestamptz;
 v_days integer;
begin
 select platform_role into v_actor_platform_role
 from public.users
 where id=p_actor_user_id
   and role='admin'
   and account_status='active'
   and platform_role in('platform_owner','platform_admin');

 if v_actor_platform_role is null then
   raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501';
 end if;

 if p_decision not in('approved','rejected') then
   raise exception 'INVALID_DECISION' using errcode='P0001';
 end if;

 select * into r
 from public.tenant_addon_requests
 where id=p_request_id
 for update;

 if not found then
   raise exception 'ADDON_REQUEST_NOT_FOUND' using errcode='P0001';
 end if;

 if r.status not in('pending','reviewing') then
   raise exception 'ADDON_REQUEST_NOT_PENDING' using errcode='P0001';
 end if;

 if p_decision='rejected' then
   update public.tenant_addon_requests
   set status='rejected',
       reviewed_at=now(),
       reviewed_by_user_id=p_actor_user_id,
       review_note=p_note
   where id=r.id;

   return query select true,'rejected',null::timestamptz;
   return;
 end if;

 select ts.ends_at into v_subscription_end
 from public.tenant_subscriptions ts
 where ts.tenant_id=r.tenant_id
   and ts.status in('trial','active')
   and (ts.ends_at is null or ts.ends_at>now())
 order by ts.created_at desc,ts.id desc
 limit 1;

 if v_subscription_end is null then
   raise exception 'SUBSCRIPTION_REQUIRED' using errcode='P0001';
 end if;

 v_start:=coalesce(r.starts_at,now());
 v_days:=greatest(
   1,
   ceil(extract(epoch from (v_subscription_end-v_start))/86400.0)::integer
 );

 update public.tenant_addon_requests
 set status='approved',
     duration_days=v_days,
     starts_at=v_start,
     ends_at=v_subscription_end,
     reviewed_at=now(),
     reviewed_by_user_id=p_actor_user_id,
     review_note=p_note
 where id=r.id;

 insert into public.audit_logs(
   tenant_id,site_id,user_id,actor_platform_role,
   entity_type,entity_id,action,after_data
 )
 values(
   r.tenant_id,r.site_id,p_actor_user_id,v_actor_platform_role,
   'tenant_addon_request',r.id::text,'approve_addon',
   jsonb_build_object(
     'addonCode',r.addon_code,
     'quantity',r.quantity,
     'billingMode',r.billing_mode,
     'startsAt',v_start,
     'endsAt',v_subscription_end
   )
 );

 return query select true,'approved',v_subscription_end;
end;
$function$;

revoke all on function public.powerhub_admin_review_tenant_addon_request(
 bigint,bigint,text,text,integer
) from public,anon,authenticated;
grant execute on function public.powerhub_admin_review_tenant_addon_request(
 bigint,bigint,text,text,integer
) to service_role;

-- Renewal keeps every selected add-on exactly co-terminous with the new subscription.
create or replace function public.powerhub_admin_renew_subscription_with_addons(
 p_actor_user_id bigint,
 p_subscription_id bigint,
 p_new_ends_at timestamptz,
 p_package_code text,
 p_addon_decisions jsonb,
 p_request_key uuid
)
returns table(
 success boolean,
 ends_at timestamptz,
 package_code text,
 renewed_addons integer,
 expired_addons integer
)
language plpgsql
security definer
set search_path=public,pg_temp
as $function$
declare
 s public.tenant_subscriptions%rowtype;
 a public.tenant_addon_requests%rowtype;
 d jsonb;
 v_existing public.subscription_renewal_operations%rowtype;
 v_fingerprint jsonb;
 v_tenant_status text;
 v_site_id bigint;
 v_actor_platform_role text;
 v_addon_id bigint;
 v_decision text;
 v_duration int;
 v_renewed int:=0;
 v_expired int:=0;
begin
 if p_request_key is null then
   raise exception 'RENEWAL_REQUEST_KEY_REQUIRED' using errcode='P0001';
 end if;

 v_fingerprint:=jsonb_build_object(
   'subscriptionId',p_subscription_id,
   'endsAt',p_new_ends_at,
   'packageCode',p_package_code,
   'addonDecisions',coalesce(p_addon_decisions,'[]'::jsonb)
 );

 select platform_role into v_actor_platform_role
 from public.users
 where id=p_actor_user_id
   and role='admin'
   and account_status='active'
   and platform_role in('platform_owner','platform_admin');

 if v_actor_platform_role is null then
   raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501';
 end if;

 if p_package_code is null or public.powerhub_catalog_package(p_package_code) is null then
   raise exception 'INVALID_RENEWAL_PACKAGE' using errcode='22023';
 end if;

 if not exists(
   select 1
   from jsonb_array_elements(
     coalesce(
       (select value->'packages'
        from public.platform_settings
        where setting_key='subscription_package_catalog'
          and is_enabled=true
        limit 1),
       '[]'::jsonb
     )
   ) package_row
   where lower(trim(package_row->>'code'))=lower(trim(p_package_code))
     and coalesce((package_row->>'active')::boolean,true)=true
 ) then
   raise exception 'RENEWAL_PACKAGE_NOT_ACTIVE' using errcode='P0001';
 end if;

 if jsonb_typeof(coalesce(p_addon_decisions,'[]'::jsonb))<>'array' then
   raise exception 'INVALID_ADDON_DECISIONS_PAYLOAD' using errcode='P0001';
 end if;

 select * into s
 from public.tenant_subscriptions
 where id=p_subscription_id
 for update;

 if not found then
   raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode='P0001';
 end if;

 select * into v_existing
 from public.subscription_renewal_operations
 where request_key=p_request_key
 for update;

 if found then
   if v_existing.subscription_id<>p_subscription_id
      or v_existing.request_fingerprint<>v_fingerprint then
     raise exception 'RENEWAL_REQUEST_KEY_REUSED' using errcode='P0001';
   end if;

   return query
   select true,v_existing.ends_at,
     coalesce(v_existing.package_code,v_existing.request_fingerprint->>'packageCode'),
     v_existing.renewed_addons,v_existing.expired_addons;
   return;
 end if;

 select status into v_tenant_status
 from public.tenants
 where id=s.tenant_id;

 if v_tenant_status='archived' or s.status='archived' then
   raise exception 'ARCHIVED_SUBSCRIPTION_RENEWAL_FORBIDDEN' using errcode='42501';
 end if;

 if p_new_ends_at<=now() then
   raise exception 'INVALID_RENEWAL_END_DATE' using errcode='P0001';
 end if;

 select site_id into v_site_id
 from public.tenant_addon_requests
 where tenant_id=s.tenant_id and site_id is not null
 order by created_at desc
 limit 1;

 if v_site_id is null then
   select id into v_site_id
   from public.sites
   where tenant_id=s.tenant_id and status<>'archived'
   order by id
   limit 1;
 end if;

 if v_site_id is null then
   raise exception 'TENANT_SITE_REQUIRED_FOR_AUDIT' using errcode='P0001';
 end if;

 if exists(
   select 1
   from (
     select (x->>'addonRequestId')::bigint addon_request_id,count(*) decision_count
     from jsonb_array_elements(coalesce(p_addon_decisions,'[]'::jsonb)) x
     where jsonb_typeof(x)='object'
       and (x->>'addonRequestId') ~ '^[0-9]+$'
     group by (x->>'addonRequestId')::bigint
     having count(*)>1
   ) duplicates
 ) then
   raise exception 'DUPLICATE_ADDON_DECISION' using errcode='P0001';
 end if;

 for d in select * from jsonb_array_elements(coalesce(p_addon_decisions,'[]'::jsonb))
 loop
   if jsonb_typeof(d)<>'object'
      or coalesce(d->>'addonRequestId','') !~ '^[0-9]+$' then
     raise exception 'INVALID_ADDON_REQUEST_ID' using errcode='P0001';
   end if;

   v_addon_id:=(d->>'addonRequestId')::bigint;
   v_decision:=d->>'decision';

   if v_decision not in('renew','expire') then
     raise exception 'INVALID_ADDON_DECISION' using errcode='P0001';
   end if;

   select * into a
   from public.tenant_addon_requests
   where id=v_addon_id and tenant_id=s.tenant_id
   for update;

   if not found then
     raise exception 'ADDON_NOT_FOUND_OR_TENANT_MISMATCH' using errcode='P0001';
   end if;

   if a.status<>'approved' then
     raise exception 'ADDON_NOT_APPROVED' using errcode='P0001';
   end if;

   if v_decision='renew' and a.ends_at is not null and a.ends_at<=now() then
     raise exception 'EXPIRED_ADDON_RENEWAL_FORBIDDEN' using errcode='P0001';
   end if;
 end loop;

 update public.tenant_subscriptions
 set ends_at=p_new_ends_at,
     package_code=p_package_code,
     status='active',
     renewal_count=renewal_count+1,
     last_renewed_at=now(),
     updated_at=now()
 where id=s.id;

 for d in select * from jsonb_array_elements(coalesce(p_addon_decisions,'[]'::jsonb))
 loop
   v_addon_id:=(d->>'addonRequestId')::bigint;
   v_decision:=d->>'decision';

   select * into a
   from public.tenant_addon_requests
   where id=v_addon_id and tenant_id=s.tenant_id
   for update;

   if v_decision='renew' then
     v_duration:=greatest(
       1,
       ceil(
         extract(epoch from (p_new_ends_at-coalesce(s.ends_at,now())))/86400.0
       )::integer
     );

     update public.tenant_addon_requests
     set starts_at=p_new_ends_at-(make_interval(days=>v_duration)),
         ends_at=p_new_ends_at,
         duration_days=v_duration,
         renewed_from_request_id=a.id
     where id=a.id;

     insert into public.tenant_addon_renewal_decisions(
       tenant_id,subscription_id,addon_request_id,decision,
       new_duration_days,created_by_user_id
     )
     values(
       s.tenant_id,s.id,a.id,'renew',v_duration,p_actor_user_id
     )
     on conflict(subscription_id,addon_request_id)
     do update set
       decision='renew',
       new_duration_days=excluded.new_duration_days,
       created_by_user_id=excluded.created_by_user_id,
       created_at=now();

     v_renewed:=v_renewed+1;
   else
     update public.tenant_addon_requests
     set ends_at=least(coalesce(ends_at,now()),now())
     where id=a.id;

     insert into public.tenant_addon_renewal_decisions(
       tenant_id,subscription_id,addon_request_id,decision,created_by_user_id
     )
     values(s.tenant_id,s.id,a.id,'expire',p_actor_user_id)
     on conflict(subscription_id,addon_request_id)
     do update set
       decision='expire',
       new_duration_days=null,
       created_by_user_id=excluded.created_by_user_id,
       created_at=now();

     v_expired:=v_expired+1;
   end if;
 end loop;

 insert into public.subscription_renewal_operations(
   request_key,subscription_id,request_fingerprint,ends_at,package_code,
   renewed_addons,expired_addons,created_by_user_id
 )
 values(
   p_request_key,s.id,v_fingerprint,p_new_ends_at,p_package_code,
   v_renewed,v_expired,p_actor_user_id
 );

 insert into public.audit_logs(
   tenant_id,site_id,user_id,actor_platform_role,
   entity_type,entity_id,action,after_data
 )
 values(
   s.tenant_id,v_site_id,p_actor_user_id,v_actor_platform_role,
   'tenant_subscription',s.id::text,'renew_subscription_with_addons',
   jsonb_build_object(
     'newEndsAt',p_new_ends_at,
     'packageCode',p_package_code,
     'renewedAddons',v_renewed,
     'expiredAddons',v_expired,
     'requestKey',p_request_key
   )
 );

 return query select true,p_new_ends_at,p_package_code,v_renewed,v_expired;
end;
$function$;

revoke all on function public.powerhub_admin_renew_subscription_with_addons(
 bigint,bigint,timestamptz,text,jsonb,uuid
) from public,anon,authenticated;
grant execute on function public.powerhub_admin_renew_subscription_with_addons(
 bigint,bigint,timestamptz,text,jsonb,uuid
) to service_role;

-- Numeric quota authority = package base + active add-ons.
-- Legacy manual/owner limit overrides are no longer quota sources.
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

 select coalesce(
   sum(
     quantity*case
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
   select v_delta+coalesce(sum(l.credited_messages),0)::integer
   into v_delta
   from public.tenant_sms_recharge_ledger l
   where l.tenant_id=p_tenant_id
     and l.status in('provider_confirmed','manual_confirmed')
     and l.confirmed_at is not null
     and (l.request_id is null or exists(
       select 1
       from public.sms_package_requests r
       join public.tenant_subscriptions ts on ts.id=r.subscription_id
       where r.id=l.request_id
         and ts.ends_at>p_at
     ));
 end if;

 return v_base+coalesce(v_delta,0);
end;
$function$;

revoke all on function public.powerhub_effective_tenant_quota(bigint,text,timestamptz)
 from public,anon,authenticated;
grant execute on function public.powerhub_effective_tenant_quota(bigint,text,timestamptz)
 to service_role;

-- Tenant feature control is now status-only for non-quantity features.
-- Numeric quota expansion is handled by add-ons, never manual/unlimited limits.
drop function if exists public.powerhub_admin_set_tenant_feature_control(
 bigint,bigint,text,text,text,integer,text
);

create or replace function public.powerhub_admin_set_tenant_feature_control(
 p_actor_user_id bigint,
 p_tenant_id bigint,
 p_feature_key text,
 p_status text,
 p_limit_mode text,
 p_manual_limit integer,
 p_reason text default null
)
returns table(
 tenant_id bigint,
 feature_key text,
 status text,
 limit_mode text,
 manual_limit integer,
 override_reason text,
 updated_by_user_id bigint,
 updated_at timestamptz
)
language plpgsql
security definer
set search_path=public,pg_temp
as $function$
declare
 v_before jsonb;
 v_now timestamptz:=now();
 v_policy text;
 v_feature_active boolean:=false;
 v_feature_type text;
begin
 if not exists(
   select 1 from public.users u
   where u.id=p_actor_user_id
     and u.role='admin'
     and u.platform_role in('platform_owner','platform_admin')
     and u.account_status='active'
 ) then
   raise exception 'PLATFORM_ADMIN_FORBIDDEN' using errcode='P0001';
 end if;

 if p_status not in('inherit','enabled','disabled') then
   raise exception 'INVALID_FEATURE_STATUS' using errcode='P0001';
 end if;

 if p_limit_mode<>'inherit' or p_manual_limit is not null then
   raise exception 'FEATURE_QUOTA_MANUAL_LIMITS_REMOVED' using errcode='P0001';
 end if;

 select fc.is_active,fc.feature_type
   into v_feature_active,v_feature_type
 from public.feature_catalog fc
 where fc.feature_key=p_feature_key
 limit 1;

 if not found then
   raise exception 'FEATURE_NOT_FOUND' using errcode='P0001';
 end if;

 if not v_feature_active then
   raise exception 'FEATURE_GLOBALLY_DISABLED' using errcode='P0001';
 end if;

 if v_feature_type='quota' and p_status<>'inherit' then
   raise exception 'FEATURE_QUOTA_STATUS_CONTROL_FORBIDDEN' using errcode='P0001';
 end if;

 if not exists(select 1 from public.tenants where id=p_tenant_id) then
   raise exception 'TENANT_NOT_FOUND' using errcode='P0001';
 end if;

 perform pg_advisory_xact_lock(
   hashtext('tenant-feature-control:'||p_tenant_id::text||':'||p_feature_key)::bigint
 );

 select to_jsonb(c)-'id'
 into v_before
 from public.tenant_feature_controls c
 where c.tenant_id=p_tenant_id
   and c.feature_key=p_feature_key
 for update;

 select ts.package_code into v_policy
 from public.tenant_subscriptions ts
 join public.package_feature_policies p on p.package_code=ts.package_code and p.feature_key=p_feature_key
 where ts.tenant_id=p_tenant_id
   and ts.status in('trial','active')
   and (ts.ends_at is null or ts.ends_at>now())
 order by ts.created_at desc,ts.id desc
 limit 1;

 if p_status in('enabled','disabled') and v_policy is null then
   raise exception 'FEATURE_NOT_AVAILABLE_IN_PACKAGE' using errcode='P0001';
 end if;

 update public.tenant_feature_controls c
 set status=p_status,
     limit_mode='inherit',
     manual_limit=null,
     override_reason=nullif(btrim(p_reason),''),
     updated_by_user_id=p_actor_user_id,
     updated_at=v_now
 where c.tenant_id=p_tenant_id
   and c.feature_key=p_feature_key;

 if not found then
   insert into public.tenant_feature_controls(
     tenant_id,feature_key,status,limit_mode,manual_limit,
     override_reason,updated_by_user_id,updated_at
   )
   values(
     p_tenant_id,p_feature_key,p_status,'inherit',null,
     nullif(btrim(p_reason),''),p_actor_user_id,v_now
   );
 end if;

 if p_feature_key in('subscriber_portal_logo','payment_documentation') then
   if p_status='inherit' then
     delete from public.tenant_feature_entitlements
     where tenant_id=p_tenant_id and feature_key=p_feature_key;
   else
     insert into public.tenant_feature_entitlements(
       tenant_id,feature_key,is_enabled,activated_by_user_id,
       activated_at,created_at,updated_at
     )
     values(
       p_tenant_id,p_feature_key,p_status='enabled',
       case when p_status='enabled' then p_actor_user_id else null end,
       case when p_status='enabled' then v_now else null end,
       v_now,v_now
     )
     on conflict(tenant_id,feature_key)
     do update set
       is_enabled=excluded.is_enabled,
       activated_by_user_id=excluded.activated_by_user_id,
       activated_at=excluded.activated_at,
       updated_at=excluded.updated_at;
   end if;
 end if;

 insert into public.tenant_feature_control_audit(
   tenant_id,feature_key,actor_user_id,action,before_data,after_data,reason
 )
 values(
   p_tenant_id,p_feature_key,p_actor_user_id,
   case when v_before is null then 'create' else 'update' end,
   v_before,
   (select to_jsonb(c)-'id'
    from public.tenant_feature_controls c
    where c.tenant_id=p_tenant_id and c.feature_key=p_feature_key),
   nullif(btrim(p_reason),'')
 );

 return query
 select c.tenant_id,c.feature_key,c.status,c.limit_mode,c.manual_limit,
   c.override_reason,c.updated_by_user_id,c.updated_at
 from public.tenant_feature_controls c
 where c.tenant_id=p_tenant_id and c.feature_key=p_feature_key;
end;
$function$;

revoke all on function public.powerhub_admin_set_tenant_feature_control(
 bigint,bigint,text,text,text,integer,text
) from public,anon,authenticated;
grant execute on function public.powerhub_admin_set_tenant_feature_control(
 bigint,bigint,text,text,text,integer,text
) to service_role;
