-- Reconcile Stage's legacy three-plan RPC contract with the five-package code contract used by Production and the app.
-- This is forward-only, preserves legacy plan mirrors, and backfills package_code
-- from the authoritative subscription and the already-installed package catalog.


-- Restore a single package-code source while retaining legacy plan mirrors for any old clients.
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS package_code text;
ALTER TABLE public.tenant_subscriptions ADD COLUMN IF NOT EXISTS package_code text;

DO $package_preflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.tenant_subscriptions s
    WHERE coalesce(nullif(btrim(s.package_code),''),nullif(btrim(to_jsonb(s)->>'plan'),'')) IS NOT NULL
      AND (CASE coalesce(nullif(btrim(s.package_code),''),nullif(btrim(to_jsonb(s)->>'plan'),''))
        WHEN 'starter' THEN 'basic'
        WHEN 'enterprise' THEN 'business'
        ELSE coalesce(nullif(btrim(s.package_code),''),nullif(btrim(to_jsonb(s)->>'plan'),''))
      END) NOT IN ('basic','advanced','professional','business','vip')
  ) THEN RAISE EXCEPTION 'PACKAGE_RECONCILE_UNSUPPORTED_SUBSCRIPTION_VALUE'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.subscription_upgrade_requests r
    WHERE (CASE coalesce(to_jsonb(r)->>'current_package_code',to_jsonb(r)->>'current_plan')
        WHEN 'starter' THEN 'basic' WHEN 'enterprise' THEN 'business'
        ELSE coalesce(to_jsonb(r)->>'current_package_code',to_jsonb(r)->>'current_plan') END)
        NOT IN ('basic','advanced','professional','business','vip')
       OR
       (CASE coalesce(to_jsonb(r)->>'requested_package_code',to_jsonb(r)->>'requested_plan')
        WHEN 'starter' THEN 'basic' WHEN 'enterprise' THEN 'business'
        ELSE coalesce(to_jsonb(r)->>'requested_package_code',to_jsonb(r)->>'requested_plan') END)
        NOT IN ('basic','advanced','professional','business','vip')
  ) THEN RAISE EXCEPTION 'PACKAGE_RECONCILE_UNSUPPORTED_REQUEST_VALUE'; END IF;
END
$package_preflight$;

-- Fill only empty package_code cells. "starter" and "enterprise" are the
-- only legacy plan names that require a deterministic mapping.
UPDATE public.tenant_subscriptions s
SET package_code = CASE coalesce(nullif(btrim(s.package_code),''),nullif(btrim(to_jsonb(s)->>'plan'),''))
  WHEN 'starter' THEN 'basic'
  WHEN 'enterprise' THEN 'business'
  ELSE coalesce(nullif(btrim(s.package_code),''),nullif(btrim(to_jsonb(s)->>'plan'),''))
END
WHERE nullif(btrim(s.package_code),'') IS NULL
  AND nullif(btrim(to_jsonb(s)->>'plan'),'') IS NOT NULL;

UPDATE public.tenants t
SET package_code = coalesce(
  nullif(btrim(t.package_code),''),
  (SELECT s.package_code FROM public.tenant_subscriptions s
   WHERE s.tenant_id=t.id
   ORDER BY CASE WHEN s.status IN ('active','trial') THEN 0 ELSE 1 END,
            s.ends_at DESC NULLS LAST,s.id DESC LIMIT 1),
  CASE to_jsonb(t)->>'plan'
    WHEN 'starter' THEN 'basic'
    WHEN 'enterprise' THEN 'business'
    ELSE nullif(btrim(to_jsonb(t)->>'plan'),'')
  END
)
WHERE nullif(btrim(t.package_code),'') IS NULL;

DO $package_assert$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tenant_subscriptions
             WHERE package_code IS NULL OR package_code NOT IN ('basic','advanced','professional','business','vip')) THEN
    RAISE EXCEPTION 'PACKAGE_RECONCILE_SUBSCRIPTION_CODE_NOT_RESOLVED';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tenants t
             WHERE EXISTS (SELECT 1 FROM public.tenant_subscriptions s WHERE s.tenant_id=t.id)
               AND (t.package_code IS NULL OR t.package_code NOT IN ('basic','advanced','professional','business','vip'))) THEN
    RAISE EXCEPTION 'PACKAGE_RECONCILE_TENANT_CODE_NOT_RESOLVED';
  END IF;
END
$package_assert$;

-- Normalize the legacy plan column names on Stage without removing legacy
-- plan mirrors. If both contracts exist, populate only empty package fields.
DO $upgrade_request_columns$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='subscription_upgrade_requests' AND column_name='current_plan')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='subscription_upgrade_requests' AND column_name='current_package_code') THEN
    ALTER TABLE public.subscription_upgrade_requests RENAME COLUMN current_plan TO current_package_code;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='subscription_upgrade_requests' AND column_name='requested_plan')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='subscription_upgrade_requests' AND column_name='requested_package_code') THEN
    ALTER TABLE public.subscription_upgrade_requests RENAME COLUMN requested_plan TO requested_package_code;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='subscription_upgrade_requests' AND column_name='current_package_code') THEN
    ALTER TABLE public.subscription_upgrade_requests ADD COLUMN current_package_code text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='subscription_upgrade_requests' AND column_name='requested_package_code') THEN
    ALTER TABLE public.subscription_upgrade_requests ADD COLUMN requested_package_code text;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='subscription_upgrade_requests' AND column_name='current_plan') THEN
    EXECUTE $sql$UPDATE public.subscription_upgrade_requests SET current_package_code=coalesce(current_package_code,
      CASE current_plan WHEN 'starter' THEN 'basic' WHEN 'enterprise' THEN 'business' ELSE current_plan END)$sql$;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='subscription_upgrade_requests' AND column_name='requested_plan') THEN
    EXECUTE $sql$UPDATE public.subscription_upgrade_requests SET requested_package_code=coalesce(requested_package_code,
      CASE requested_plan WHEN 'starter' THEN 'basic' WHEN 'enterprise' THEN 'business' ELSE requested_plan END)$sql$;
  END IF;
END
$upgrade_request_columns$;

UPDATE public.subscription_upgrade_requests
SET current_package_code = CASE current_package_code
      WHEN 'starter' THEN 'basic' WHEN 'enterprise' THEN 'business' ELSE current_package_code END,
    requested_package_code = CASE requested_package_code
      WHEN 'starter' THEN 'basic' WHEN 'enterprise' THEN 'business' ELSE requested_package_code END;

DO $upgrade_request_constraints$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
    WHERE conrelid='public.subscription_upgrade_requests'::regclass
      AND contype='c'
      AND (pg_get_constraintdef(oid) LIKE '%current_plan%' OR pg_get_constraintdef(oid) LIKE '%requested_plan%')
  LOOP
    EXECUTE format('ALTER TABLE public.subscription_upgrade_requests DROP CONSTRAINT %I',r.conname);
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.subscription_upgrade_requests WHERE current_package_code IS NULL OR requested_package_code IS NULL) THEN
    RAISE EXCEPTION 'PACKAGE_RECONCILE_UPGRADE_REQUEST_PACKAGE_CODE_NULL';
  END IF;
  ALTER TABLE public.subscription_upgrade_requests
    ALTER COLUMN current_package_code SET NOT NULL,
    ALTER COLUMN requested_package_code SET NOT NULL;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.subscription_upgrade_requests'::regclass AND conname='subscription_upgrade_requests_current_package_code_check') THEN
    ALTER TABLE public.subscription_upgrade_requests
      ADD CONSTRAINT subscription_upgrade_requests_current_package_code_check
      CHECK (current_package_code IN ('basic','advanced','professional','business','vip'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.subscription_upgrade_requests'::regclass AND conname='subscription_upgrade_requests_requested_package_code_check') THEN
    ALTER TABLE public.subscription_upgrade_requests
      ADD CONSTRAINT subscription_upgrade_requests_requested_package_code_check
      CHECK (requested_package_code IN ('basic','advanced','professional','business','vip'));
  END IF;
END
$upgrade_request_constraints$;

-- Stage's knowledge table is currently empty. Add the missing Production
-- projection fields with exact defaults used by its management RPC.
ALTER TABLE public.chat_knowledge_articles
  ADD COLUMN IF NOT EXISTS search_aliases text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'generator_owner',
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'powerhub';


-- Replace stale OUT-column and named-argument contracts before recreating the
-- Production functions. Existing data is not deleted or rewritten by these drops.
DROP FUNCTION IF EXISTS public.powerhub_admin_subscription_upgrade_requests();
DROP FUNCTION IF EXISTS public.powerhub_admin_review_subscription_upgrade_request(bigint,bigint,text,text);
DROP FUNCTION IF EXISTS public.powerhub_admin_quick_upgrade_owner_plan(bigint,bigint,text,text);
DROP FUNCTION IF EXISTS public.powerhub_admin_update_subscription(bigint,bigint,text,text,text,timestamptz,boolean,text,bigint);
DROP FUNCTION IF EXISTS public.powerhub_request_subscription_upgrade(bigint,bigint,bigint,text);

CREATE OR REPLACE FUNCTION public.powerhub_catalog_package(p_package_code text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select pkg
  from public.platform_settings ps
  cross join lateral jsonb_array_elements(coalesce(ps.value->'packages','[]'::jsonb)) pkg
  where ps.setting_key='subscription_package_catalog'
    and ps.is_enabled=true
    and lower(trim(pkg->>'code'))=lower(trim(p_package_code))
    and coalesce((pkg->>'active')::boolean,true)=true
  limit 1
$function$;
ALTER FUNCTION public.powerhub_catalog_package(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.powerhub_catalog_package(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_catalog_package(text) TO service_role;

CREATE OR REPLACE FUNCTION public.powerhub_validate_package_code(p_package_code text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if nullif(trim(p_package_code),'') is null or public.powerhub_catalog_package(p_package_code) is null then
    raise exception 'INVALID_PACKAGE_CODE' using errcode='22023';
  end if;
  return true;
end;
$function$;
ALTER FUNCTION public.powerhub_validate_package_code(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.powerhub_validate_package_code(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_validate_package_code(text) TO service_role;

CREATE OR REPLACE FUNCTION public.powerhub_admin_subscription_upgrade_requests()
 RETURNS TABLE(id bigint, tenant_id bigint, current_package_code text, requested_package_code text, status text, note text, created_at timestamp with time zone, reviewed_at timestamp with time zone, tenant_name text, owner_name text, owner_email text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select
    r.id,
    r.tenant_id,
    r.current_package_code::text,
    r.requested_package_code::text,
    r.status::text,
    r.note,
    r.created_at,
    r.reviewed_at,
    t.name::text,
    p.full_name::text,
    p.email::text
  from public.subscription_upgrade_requests r
  left join public.tenants t on t.id=r.tenant_id
  left join public.tenant_owner_profiles p on p.tenant_id=r.tenant_id
  order by r.created_at desc
  limit 300;
$function$;
ALTER FUNCTION public.powerhub_admin_subscription_upgrade_requests() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.powerhub_admin_subscription_upgrade_requests() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_admin_subscription_upgrade_requests() TO service_role;

CREATE OR REPLACE FUNCTION public.powerhub_admin_review_subscription_upgrade_request(p_actor_user_id bigint, p_request_id bigint, p_decision text, p_note text DEFAULT NULL::text)
 RETURNS TABLE(success boolean, package_code text, replayed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor_platform_role text;
  v_request public.subscription_upgrade_requests%rowtype;
  v_subscription public.tenant_subscriptions%rowtype;
  v_site_id bigint;
  v_current_rank integer;
  v_requested_rank integer;
begin
  select platform_role
    into v_actor_platform_role
  from public.users
  where id=p_actor_user_id
    and role='admin'
    and account_status='active'
    and platform_role in('platform_owner','platform_admin');

  if v_actor_platform_role is null then
    raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501';
  end if;

  if p_decision not in('approved','rejected') then
    raise exception 'INVALID_DECISION' using errcode='22023';
  end if;

  select *
    into v_request
  from public.subscription_upgrade_requests
  where id=p_request_id
  for update;

  if not found then
    raise exception 'REQUEST_NOT_FOUND' using errcode='P0002';
  end if;

  if v_request.status not in('pending','reviewing') then
    if (p_decision='approved' and v_request.status='approved')
       or (p_decision='rejected' and v_request.status='rejected')
    then
      return query
        select true,
          case when p_decision='approved' then v_request.requested_package_code else v_request.current_package_code end,
          true;
      return;
    end if;
    raise exception 'REQUEST_ALREADY_PROCESSED' using errcode='P0001';
  end if;

  select s.id
    into v_site_id
  from public.sites s
  where s.tenant_id=v_request.tenant_id
    and s.status<>'archived'
  order by s.id
  limit 1;

  if v_site_id is null then
    raise exception 'SITE_NOT_FOUND' using errcode='P0002';
  end if;

  select *
    into v_subscription
  from public.tenant_subscriptions
  where tenant_id=v_request.tenant_id
  order by
    case when status in('active','trial') then 0 else 1 end,
    ends_at desc nulls last,
    id desc
  limit 1
  for update;

  if not found then
    raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode='P0002';
  end if;

  if p_decision='approved' then
    perform public.powerhub_validate_package_code(v_subscription.package_code);
    perform public.powerhub_validate_package_code(v_request.requested_package_code);

    select ordinality
      into v_current_rank
    from public.platform_settings ps
    cross join lateral jsonb_array_elements(coalesce(ps.value->'packages','[]'::jsonb)) with ordinality pkg
    where ps.setting_key='subscription_package_catalog'
      and ps.is_enabled=true
      and lower(trim(pkg->>'code'))=lower(trim(v_subscription.package_code))
      and coalesce((pkg->>'active')::boolean,true)=true
    limit 1;

    select ordinality
      into v_requested_rank
    from public.platform_settings ps
    cross join lateral jsonb_array_elements(coalesce(ps.value->'packages','[]'::jsonb)) with ordinality pkg
    where ps.setting_key='subscription_package_catalog'
      and ps.is_enabled=true
      and lower(trim(pkg->>'code'))=lower(trim(v_request.requested_package_code))
      and coalesce((pkg->>'active')::boolean,true)=true
    limit 1;

    if v_requested_rank is null or v_current_rank is null or v_requested_rank<=v_current_rank then
      raise exception 'REQUESTED_PACKAGE_NO_LONGER_UPGRADE' using errcode='P0001';
    end if;
  end if;

  update public.subscription_upgrade_requests
  set status=p_decision,
      note=p_note,
      reviewed_by_user_id=p_actor_user_id,
      reviewed_at=now(),
      updated_at=now()
  where id=v_request.id;

  if p_decision='approved' then
    update public.tenant_subscriptions
    set package_code=v_request.requested_package_code,
        updated_at=now()
    where id=v_subscription.id;

    update public.tenants
    set package_code=v_request.requested_package_code,
        updated_at=now()
    where id=v_request.tenant_id;

    insert into public.audit_logs(
      tenant_id,site_id,user_id,actor_platform_role,
      entity_type,entity_id,action,before_data,after_data
    )
    values(
      v_request.tenant_id,v_site_id,p_actor_user_id,v_actor_platform_role,
      'tenant_subscription',v_subscription.id::text,
      'platform_admin_approved_subscription_upgrade',
      jsonb_build_object('packageCode',v_subscription.package_code),
      jsonb_build_object('packageCode',v_request.requested_package_code,'requestId',v_request.id)
    );
  else
    insert into public.audit_logs(
      tenant_id,site_id,user_id,actor_platform_role,
      entity_type,entity_id,action,before_data,after_data
    )
    values(
      v_request.tenant_id,v_site_id,p_actor_user_id,v_actor_platform_role,
      'subscription_upgrade_request',v_request.id::text,
      'platform_admin_rejected_subscription_upgrade',
      jsonb_build_object('requestedPackageCode',v_request.requested_package_code,'currentPackageCode',v_request.current_package_code),
      jsonb_build_object('decision','rejected','note',p_note)
    );
  end if;

  return query
    select true,
      case when p_decision='approved' then v_request.requested_package_code else v_request.current_package_code end,
      false;
end;
$function$;
ALTER FUNCTION public.powerhub_admin_review_subscription_upgrade_request(bigint,bigint,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.powerhub_admin_review_subscription_upgrade_request(bigint,bigint,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_admin_review_subscription_upgrade_request(bigint,bigint,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.powerhub_admin_quick_upgrade_owner_plan(p_actor_user_id bigint, p_tenant_id bigint, p_package_code text, p_note text DEFAULT NULL::text)
 RETURNS TABLE(success boolean, package_code text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor_platform_role text;
  v_tenant public.tenants%rowtype;
  v_subscription public.tenant_subscriptions%rowtype;
  v_site_id bigint;
  v_current_rank integer;
  v_requested_rank integer;
begin
  select u.platform_role
  into v_actor_platform_role
  from public.users as u
  where u.id = p_actor_user_id
    and u.role = 'admin'
    and u.account_status = 'active'
    and u.platform_role in ('platform_owner', 'platform_admin');

  if v_actor_platform_role is null then
    raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode = '42501';
  end if;

  perform public.powerhub_validate_package_code(p_package_code);

  select t.*
  into v_tenant
  from public.tenants as t
  where t.id = p_tenant_id
  for update;

  if not found then
    raise exception 'TENANT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select ts.*
  into v_subscription
  from public.tenant_subscriptions as ts
  where ts.tenant_id = p_tenant_id
  for update;

  if not found then
    raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode = 'P0002';
  end if;

  select s.id
  into v_site_id
  from public.sites as s
  where s.tenant_id = p_tenant_id
  order by s.id
  limit 1;

  if v_site_id is null then
    raise exception 'SITE_NOT_FOUND' using errcode = 'P0002';
  end if;

  select ordinality into v_current_rank
  from public.platform_settings ps
  cross join lateral jsonb_array_elements(coalesce(ps.value->'packages','[]'::jsonb)) with ordinality pkg
  where ps.setting_key='subscription_package_catalog'
    and ps.is_enabled=true
    and lower(trim(pkg->>'code'))=lower(trim(v_subscription.package_code))
    and coalesce((pkg->>'active')::boolean,true)=true
  limit 1;

  select ordinality into v_requested_rank
  from public.platform_settings ps
  cross join lateral jsonb_array_elements(coalesce(ps.value->'packages','[]'::jsonb)) with ordinality pkg
  where ps.setting_key='subscription_package_catalog'
    and ps.is_enabled=true
    and lower(trim(pkg->>'code'))=lower(trim(p_package_code))
    and coalesce((pkg->>'active')::boolean,true)=true
  limit 1;

  if v_current_rank is null then
    raise exception 'INVALID_CURRENT_PACKAGE' using errcode = '22023';
  end if;

  if v_requested_rank <= v_current_rank then
    raise exception 'PLAN_NOT_UPGRADE' using errcode = '22023';
  end if;

  update public.tenants
  set package_code = p_package_code,
      updated_at = now()
  where id = p_tenant_id;

  update public.tenant_subscriptions
  set package_code = p_package_code,
      updated_at = now()
  where id = v_subscription.id;

  insert into public.audit_logs (
    tenant_id, site_id, user_id, actor_platform_role,
    entity_type, entity_id, action, after_data
  ) values (
    p_tenant_id, v_site_id, p_actor_user_id, v_actor_platform_role,
    'tenant_subscription', p_tenant_id::text,
    'platform_admin_quick_upgrade_owner_plan',
    jsonb_build_object(
      'fromPackageCode', v_subscription.package_code,
      'toPackageCode', p_package_code,
      'note', p_note
    )
  );

  return query select true, p_package_code;
end;
$function$;
ALTER FUNCTION public.powerhub_admin_quick_upgrade_owner_plan(bigint,bigint,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.powerhub_admin_quick_upgrade_owner_plan(bigint,bigint,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_admin_quick_upgrade_owner_plan(bigint,bigint,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.powerhub_admin_quick_upgrade_owner_plan_idempotent(p_actor_user_id bigint, p_tenant_id bigint, p_package_code text, p_note text, p_client_operation_id text)
 RETURNS TABLE(success boolean, package_code text, replayed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor_platform_role text;
  v_subscription public.tenant_subscriptions%rowtype;
  v_package_code text;
  v_site_id bigint;
  v_current_rank int;
  v_requested_rank int;
  v_op public.offline_sync_operations%rowtype;
begin
  if nullif(trim(p_client_operation_id),'') is null then
    raise exception 'CLIENT_OPERATION_REQUIRED' using errcode='P0001';
  end if;

  select platform_role
    into v_actor_platform_role
  from public.users
  where id=p_actor_user_id
    and role='admin'
    and account_status='active'
    and platform_role in('platform_owner','platform_admin');

  if v_actor_platform_role is null then
    raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501';
  end if;

  v_package_code:=lower(nullif(btrim(p_package_code),''));
  perform public.powerhub_validate_package_code(v_package_code);

  perform pg_advisory_xact_lock(hashtext('subscription-quick-upgrade:'||p_tenant_id::text)::bigint);

  select * into v_op
  from public.offline_sync_operations
  where user_id=p_actor_user_id
    and client_operation_id=trim(p_client_operation_id)
  for update;

  if found then
    if v_op.operation_type<>'subscription_quick_upgrade'
       or v_op.tenant_id<>p_tenant_id
       or v_op.response->>'packageCode'<>v_package_code
       or coalesce(v_op.response->>'note','')<>coalesce(p_note,'')
    then
      raise exception 'SUBSCRIPTION_QUICK_UPGRADE_OPERATION_CONFLICT' using errcode='P0001';
    end if;

    return query select true,v_package_code,true;
    return;
  end if;

  select * into v_subscription
  from public.tenant_subscriptions
  where tenant_id=p_tenant_id
  order by created_at desc,id desc
  limit 1
  for update;

  if not found then
    raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode='P0002';
  end if;

  select s.id into v_site_id
  from public.sites s
  where s.tenant_id=p_tenant_id
  order by s.id
  limit 1;

  if v_site_id is null then
    raise exception 'SITE_NOT_FOUND' using errcode='P0002';
  end if;

  select ordinality
    into v_current_rank
  from public.platform_settings ps
  cross join lateral jsonb_array_elements(coalesce(ps.value->'packages','[]'::jsonb)) with ordinality pkg
  where ps.setting_key='subscription_package_catalog'
    and ps.is_enabled=true
    and lower(trim(pkg->>'code'))=lower(trim(v_subscription.package_code))
    and coalesce((pkg->>'active')::boolean,true)=true
  limit 1;

  select ordinality
    into v_requested_rank
  from public.platform_settings ps
  cross join lateral jsonb_array_elements(coalesce(ps.value->'packages','[]'::jsonb)) with ordinality pkg
  where ps.setting_key='subscription_package_catalog'
    and ps.is_enabled=true
    and lower(trim(pkg->>'code'))=lower(trim(v_package_code))
    and coalesce((pkg->>'active')::boolean,true)=true
  limit 1;

  if v_current_rank is null then
    raise exception 'SUBSCRIPTION_PACKAGE_INVALID' using errcode='P0001';
  end if;

  if v_requested_rank<=v_current_rank then
    raise exception 'PACKAGE_NOT_UPGRADE' using errcode='22023';
  end if;

  update public.tenant_subscriptions
  set package_code=v_package_code,
      updated_at=now()
  where id=v_subscription.id;

  update public.tenants
  set package_code=v_package_code,updated_at=now()
  where id=p_tenant_id;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,
    entity_type,entity_id,action,after_data
  )
  values(
    p_tenant_id,v_site_id,p_actor_user_id,v_actor_platform_role,
    'tenant_subscription',v_subscription.id::text,
    'platform_admin_quick_upgrade_owner_package',
    jsonb_build_object(
      'fromPackageCode',v_subscription.package_code,
      'toPackageCode',v_package_code,
      'note',p_note
    )
  );

  insert into public.offline_sync_operations(
    tenant_id,site_id,user_id,client_operation_id,
    operation_type,entity_type,entity_id,response
  )
  values(
    p_tenant_id,v_site_id,p_actor_user_id,trim(p_client_operation_id),
    'subscription_quick_upgrade','tenant_subscription',v_subscription.id,
    jsonb_build_object('packageCode',v_package_code,'note',coalesce(p_note,''))
  );

  return query select true,v_package_code,false;
end;
$function$;
ALTER FUNCTION public.powerhub_admin_quick_upgrade_owner_plan_idempotent(bigint,bigint,text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.powerhub_admin_quick_upgrade_owner_plan_idempotent(bigint,bigint,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_admin_quick_upgrade_owner_plan_idempotent(bigint,bigint,text,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.powerhub_admin_update_subscription(p_actor_user_id bigint, p_tenant_id bigint, p_package_code text, p_status text, p_billing_cycle text, p_ends_at timestamp with time zone, p_auto_renew boolean, p_notes text DEFAULT NULL::text, p_sms_plan_id bigint DEFAULT NULL::bigint)
 RETURNS TABLE(success boolean, subscription_id bigint, site_id bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_operation_id text; v_result record;
begin
  v_operation_id := 'admin-subscription-update:'||md5(concat_ws('|',
    p_actor_user_id::text,p_tenant_id::text,lower(nullif(btrim(p_package_code),'')),
    p_status,p_billing_cycle,p_ends_at::text,p_auto_renew::text,
    coalesce(p_notes,''),coalesce(p_sms_plan_id::text,'')));
  select * into v_result
  from public.powerhub_admin_update_subscription_idempotent(
    p_actor_user_id,p_tenant_id,p_package_code,p_status,p_billing_cycle,
    p_ends_at,p_auto_renew,p_notes,p_sms_plan_id,v_operation_id
  );
  return query select v_result.success,v_result.subscription_id,v_result.site_id;
end;
$function$;
ALTER FUNCTION public.powerhub_admin_update_subscription(bigint,bigint,text,text,text,timestamptz,boolean,text,bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.powerhub_admin_update_subscription(bigint,bigint,text,text,text,timestamptz,boolean,text,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_admin_update_subscription(bigint,bigint,text,text,text,timestamptz,boolean,text,bigint) TO service_role;

CREATE OR REPLACE FUNCTION public.powerhub_admin_update_subscription_idempotent(p_actor_user_id bigint, p_tenant_id bigint, p_package_code text, p_status text, p_billing_cycle text, p_ends_at timestamp with time zone, p_auto_renew boolean, p_notes text, p_sms_plan_id bigint, p_client_operation_id text)
 RETURNS TABLE(success boolean, subscription_id bigint, site_id bigint, replayed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_role text;
  v_sub public.tenant_subscriptions%rowtype;
  v_site_id bigint;
  v_sms_active boolean;
  v_op public.offline_sync_operations%rowtype;
  v_package_code text;
begin
  if nullif(trim(p_client_operation_id),'') is null then
    raise exception 'CLIENT_OPERATION_REQUIRED' using errcode='P0001';
  end if;

  select platform_role
    into v_role
  from public.users
  where id=p_actor_user_id
    and role='admin'
    and account_status='active'
    and platform_role in('platform_owner','platform_admin','finance_admin');

  if v_role is null then
    raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501';
  end if;

  v_package_code:=lower(nullif(btrim(p_package_code),''));
  perform public.powerhub_validate_package_code(v_package_code);

  if p_status not in('trial','active','overdue','suspended','cancelled') then
    raise exception 'INVALID_SUBSCRIPTION_STATUS' using errcode='22023';
  end if;

  if p_billing_cycle not in('monthly','yearly') then
    raise exception 'INVALID_BILLING_CYCLE' using errcode='22023';
  end if;

  if p_sms_plan_id is not null then
    select is_active
      into v_sms_active
    from public.platform_sms_plans
    where id=p_sms_plan_id;

    if not coalesce(v_sms_active,false) then
      raise exception 'SMS_PLAN_NOT_ACTIVE' using errcode='22023';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext('subscription-update:'||p_tenant_id::text)::bigint);

  select *
    into v_op
  from public.offline_sync_operations
  where user_id=p_actor_user_id
    and client_operation_id=trim(p_client_operation_id)
  for update;

  if found then
    if v_op.operation_type<>'subscription_update'
       or v_op.tenant_id<>p_tenant_id
       or v_op.response->>'packageCode'<>v_package_code
       or v_op.response->>'status'<>p_status
       or v_op.response->>'billingCycle'<>p_billing_cycle
       or (v_op.response->>'endsAt')::timestamptz is distinct from p_ends_at
       or (v_op.response->>'autoRenew')::boolean is distinct from p_auto_renew
       or coalesce(v_op.response->>'notes','')<>coalesce(p_notes,'')
       or (v_op.response->>'smsPlanId')::bigint is distinct from p_sms_plan_id
    then
      raise exception 'SUBSCRIPTION_UPDATE_OPERATION_CONFLICT' using errcode='P0001';
    end if;

    return query
      select true,
        (v_op.response->>'subscriptionId')::bigint,
        v_op.site_id,
        true;
    return;
  end if;

  select *
    into v_sub
  from public.tenant_subscriptions
  where tenant_id=p_tenant_id
  order by created_at desc,id desc
  limit 1
  for update;

  if not found then
    raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode='P0002';
  end if;

  select s.id
    into v_site_id
  from public.sites s
  where s.tenant_id=p_tenant_id
  order by s.id
  limit 1;

  if v_site_id is null then
    raise exception 'SITE_NOT_FOUND' using errcode='P0002';
  end if;

  update public.tenant_subscriptions
  set package_code=v_package_code,
      status=p_status,
      billing_cycle=p_billing_cycle,
      ends_at=p_ends_at,
      auto_renew=p_auto_renew,
      notes=p_notes,
      sms_plan_id=p_sms_plan_id,
      updated_at=now()
  where id=v_sub.id;

  update public.tenants
  set package_code=v_package_code,updated_at=now()
  where id=p_tenant_id;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,
    entity_type,entity_id,action,after_data
  )
  values(
    p_tenant_id,
    v_site_id,
    p_actor_user_id,
    v_role,
    'tenant_subscription',
    v_sub.id::text,
    'platform_admin_update_subscription',
    jsonb_build_object(
      'packageCode',v_package_code,
      'status',p_status,
      'billingCycle',p_billing_cycle,
      'endsAt',p_ends_at,
      'autoRenew',p_auto_renew,
      'smsPlanId',p_sms_plan_id
    )
  );

  insert into public.offline_sync_operations(
    tenant_id,site_id,user_id,client_operation_id,
    operation_type,entity_type,entity_id,response
  )
  values(
    p_tenant_id,v_site_id,p_actor_user_id,trim(p_client_operation_id),
    'subscription_update','tenant_subscription',v_sub.id,
    jsonb_build_object(
      'subscriptionId',v_sub.id,
      'packageCode',v_package_code,
      'status',p_status,
      'billingCycle',p_billing_cycle,
      'endsAt',p_ends_at,
      'autoRenew',p_auto_renew,
      'notes',coalesce(p_notes,''),
      'smsPlanId',p_sms_plan_id
    )
  );

  return query
    select true,v_sub.id,v_site_id,false;
end;
$function$;
ALTER FUNCTION public.powerhub_admin_update_subscription_idempotent(bigint,bigint,text,text,text,timestamptz,boolean,text,bigint,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.powerhub_admin_update_subscription_idempotent(bigint,bigint,text,text,text,timestamptz,boolean,text,bigint,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_admin_update_subscription_idempotent(bigint,bigint,text,text,text,timestamptz,boolean,text,bigint,text) TO service_role;

CREATE OR REPLACE FUNCTION public.powerhub_request_subscription_upgrade(p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_requested_package_code text)
 RETURNS TABLE(request_id bigint, requested_package_code text, already_requested boolean)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_current_package text;
  v_requested_package text;
  v_catalog jsonb;
  v_override jsonb;
  v_limit integer;
  v_count integer;
  v_existing_id bigint;
  v_existing_package text;
  v_role text;
  v_order int;
  v_current_order int;
begin
  v_requested_package := lower(nullif(btrim(p_requested_package_code),''));
  if public.powerhub_catalog_package(v_requested_package) is null then
    raise exception 'INVALID_REQUESTED_PACKAGE_CODE' using errcode='P0001';
  end if;

  perform pg_advisory_xact_lock(p_tenant_id,hashtext('subscription-upgrade'));

  perform 1
  from public.sites
  where id=p_site_id
    and tenant_id=p_tenant_id
    and status<>'archived'
  for share;

  if not found then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  select lower(nullif(btrim(ts.package_code),''))
    into v_current_package
  from public.tenant_subscriptions ts
  where ts.tenant_id=p_tenant_id
  order by ts.created_at desc,ts.id desc
  limit 1
  for share;

  if v_current_package is null then
    raise exception 'TENANT_PACKAGE_NOT_FOUND' using errcode='P0001';
  end if;

  select ordinality into v_current_order
  from public.platform_settings ps
  cross join lateral jsonb_array_elements(coalesce(ps.value->'packages','[]'::jsonb)) with ordinality pkg
  where ps.setting_key='subscription_package_catalog'
    and ps.is_enabled=true
    and lower(trim(pkg->>'code'))=lower(trim(v_current_package))
    and coalesce((pkg->>'active')::boolean,true)=true
  limit 1;

  select ordinality into v_order
  from public.platform_settings ps
  cross join lateral jsonb_array_elements(coalesce(ps.value->'packages','[]'::jsonb)) with ordinality pkg
  where ps.setting_key='subscription_package_catalog'
    and ps.is_enabled=true
    and lower(trim(pkg->>'code'))=lower(trim(v_requested_package))
    and coalesce((pkg->>'active')::boolean,true)=true
  limit 1;

  if v_order <= v_current_order then
    raise exception 'REQUESTED_PACKAGE_NOT_HIGHER' using errcode='P0001';
  end if;

  select value
    into v_catalog
  from public.platform_settings
  where setting_key='subscription_package_catalog'
    and is_enabled=true;

  select coalesce(
    (pkg->'features'->'subscribers'->>'limit')::integer,
    (pkg->>'includedSubscribers')::integer,
    0
  )
    into v_limit
  from jsonb_array_elements(coalesce(v_catalog->'packages','[]'::jsonb)) pkg
  where lower(trim(pkg->>'code'))=lower(trim(v_current_package))
    and coalesce((pkg->>'active')::boolean,true)=true
  limit 1;

  if v_current_order is null or v_order is null then
    raise exception 'PACKAGE_ORDER_NOT_CONFIGURED' using errcode='P0001';
  end if;

  select value
    into v_override
  from public.platform_settings
  where setting_key='owner_limit_overrides';

  if jsonb_typeof(v_override->'overrides')='object'
     and jsonb_typeof(v_override->'overrides'->p_tenant_id::text)='object'
     and (v_override->'overrides'->p_tenant_id::text->>'subscriberLimit') ~ '^[0-9]+$'
  then
    v_limit := least(
      (v_override->'overrides'->p_tenant_id::text->>'subscriberLimit')::integer,
      100000
    );
  end if;

  if v_limit is null or v_limit<0 then
    raise exception 'SUBSCRIBER_QUOTA_NOT_CONFIGURED' using errcode='P0001';
  end if;

  select count(*)::integer
    into v_count
  from public.subscribers
  where tenant_id=p_tenant_id;

  if v_count < v_limit then
    raise exception 'SUBSCRIBER_LIMIT_NOT_REACHED' using errcode='P0001';
  end if;

  select id,requested_package_code
    into v_existing_id,v_existing_package
  from public.subscription_upgrade_requests
  where tenant_id=p_tenant_id
    and status in ('pending','reviewing')
  order by created_at desc
  limit 1
  for share;

  if found then
    return query
      select v_existing_id,v_existing_package,true;
    return;
  end if;

  insert into public.subscription_upgrade_requests(
    tenant_id,
    requested_by_user_id,
    current_package_code,
    requested_package_code,
    reason,
    status
  )
  values(
    p_tenant_id,
    p_user_id,
    v_current_package,
    v_requested_package,
    'subscriber_limit_reached',
    'pending'
  )
  returning id into v_existing_id;

  select platform_role
    into v_role
  from public.users
  where id=p_user_id;

  insert into public.audit_logs(
    tenant_id,
    site_id,
    user_id,
    actor_platform_role,
    entity_type,
    entity_id,
    action,
    after_data
  )
  values(
    p_tenant_id,
    p_site_id,
    p_user_id,
    v_role,
    'subscription_upgrade_request',
    v_existing_id::text,
    'request_upgrade',
    jsonb_build_object(
      'currentPackageCode',v_current_package,
      'requestedPackageCode',v_requested_package,
      'subscriberCount',v_count,
      'subscriberLimit',v_limit
    )
  );

  return query
    select v_existing_id,v_requested_package,false;
end;
$function$;
ALTER FUNCTION public.powerhub_request_subscription_upgrade(bigint,bigint,bigint,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.powerhub_request_subscription_upgrade(bigint,bigint,bigint,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_request_subscription_upgrade(bigint,bigint,bigint,text) TO service_role;

CREATE INDEX IF NOT EXISTS tenants_package_code_idx
  ON public.tenants(package_code);

NOTIFY pgrst,'reload schema';
