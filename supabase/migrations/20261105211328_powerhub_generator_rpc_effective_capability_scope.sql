-- Resolve generator access using the same NULL/inherit, []/deny-all,
-- custom-role, and per-profile override semantics as the server RBAC resolver.
-- Platform identities still require tenant membership for these tenant mutations.
CREATE OR REPLACE FUNCTION private.powerhub_has_generator_management_access(
  target_tenant_id bigint,
  target_site_id bigint
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id bigint;
  v_membership_role text;
  v_effective_role text;
  v_profile public.staff_profiles%ROWTYPE;
  v_custom_permissions jsonb;
  v_has_capability boolean := false;
  v_override boolean;
BEGIN
  IF target_tenant_id IS NULL OR target_site_id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.sites site
       WHERE site.id=target_site_id AND site.tenant_id=target_tenant_id
     ) THEN
    RETURN false;
  END IF;

  SELECT account.id INTO v_user_id
  FROM public.users account
  WHERE account.auth_user_id=(SELECT auth.uid())
    AND account.account_status='active'
  LIMIT 1;
  IF v_user_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT membership.role INTO v_membership_role
  FROM public.tenant_members membership
  WHERE membership.tenant_id=target_tenant_id
    AND membership.user_id=v_user_id
    AND membership.is_active=true
    AND membership.membership_status='active'
    AND (membership.expires_at IS NULL OR membership.expires_at>now())
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_membership_role='owner' THEN
    v_effective_role := 'owner';
    v_has_capability := true;

    SELECT member_override.is_allowed INTO v_override
    FROM public.tenant_member_capability_overrides member_override
    WHERE member_override.tenant_id=target_tenant_id
      AND member_override.user_id=v_user_id
      AND member_override.capability='manageGenerators';
    IF FOUND THEN
      v_has_capability := v_override;
    END IF;
  ELSE
    SELECT profile.* INTO v_profile
    FROM public.staff_profiles profile
    WHERE profile.tenant_id=target_tenant_id
      AND profile.user_id=v_user_id
      AND profile.is_active=true
      AND profile.archived_at IS NULL
      AND (profile.site_id=target_site_id OR profile.site_id IS NULL)
    ORDER BY
      CASE WHEN profile.site_id=target_site_id THEN 0 ELSE 1 END,
      profile.id
    LIMIT 1;

    IF NOT FOUND THEN
      RETURN false;
    END IF;

    -- An exact-site suspended profile must not fall back to a global profile.
    IF v_profile.suspension_started_at IS NOT NULL
       AND v_profile.suspension_ends_at IS NOT NULL
       AND now()>=v_profile.suspension_started_at
       AND now()<v_profile.suspension_ends_at THEN
      RETURN false;
    END IF;

    v_effective_role := v_profile.role;

    -- Explicit profile permissions (including []) take precedence over role defaults.
    IF v_profile.permissions IS NOT NULL THEN
      v_has_capability := v_profile.permissions @> pg_catalog.jsonb_build_array('manageGenerators');
    ELSIF v_profile.custom_role_id IS NOT NULL THEN
      SELECT custom_role.permissions INTO v_custom_permissions
      FROM public.custom_permission_roles custom_role
      WHERE custom_role.id=v_profile.custom_role_id
        AND custom_role.tenant_id=target_tenant_id
        AND custom_role.is_active=true;
      v_has_capability := FOUND
        AND COALESCE(v_custom_permissions @> pg_catalog.jsonb_build_array('manageGenerators'),false);
    ELSE
      -- Must remain aligned with shared/powerhub-rbac.ts capabilityRoles.
      v_has_capability := v_effective_role IN ('owner','manager','technician');
    END IF;

    -- Individual profile exceptions override inherited/custom/explicit permissions.
    SELECT capability_override.is_allowed INTO v_override
    FROM public.staff_profile_capability_overrides capability_override
    WHERE capability_override.tenant_id=target_tenant_id
      AND capability_override.profile_id=v_profile.id
      AND capability_override.capability='manageGenerators';
    IF FOUND THEN
      v_has_capability := v_override;
    END IF;
  END IF;

  IF NOT v_has_capability THEN
    RETURN false;
  END IF;

  -- Platform role policies are additional deny-only restrictions.
  IF EXISTS (
    SELECT 1 FROM public.platform_role_policies policy
    WHERE policy.role=v_effective_role
      AND policy.capability='manageGenerators'
      AND policy.is_allowed=false
  ) THEN
    RETURN false;
  END IF;

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION private.powerhub_has_generator_management_access(bigint,bigint)
  FROM PUBLIC, anon, authenticated, service_role;

-- Offline generator mutation RPCs are authenticated browser entry points.
-- They must enforce the same membership-expiry rule as tenant RLS helpers.
-- Preserve the live function bodies and grants, changing only owner-membership eligibility.
CREATE OR REPLACE FUNCTION public.powerhub_sync_generator_create(p_site_id bigint, p_code text, p_name text, p_serial_number text, p_rated_capacity_kw numeric, p_fuel_type text, p_client_operation_id text)
 RETURNS TABLE(id bigint, name text, replayed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_user_id bigint; v_tenant_id bigint; v_generator public.generators%rowtype; v_operation public.offline_sync_operations%rowtype;
begin
 select u.id into v_user_id from public.users u where u.auth_user_id=auth.uid() and u.account_status='active' limit 1; if v_user_id is null then raise exception 'AUTH_USER_NOT_FOUND'; end if;
 select s.tenant_id into v_tenant_id from public.sites s where s.id=p_site_id and s.status <> 'archived'; if v_tenant_id is null then raise exception 'SITE_OUT_OF_SCOPE'; end if;
  IF NOT private.powerhub_has_generator_management_access(v_tenant_id,p_site_id) THEN
    RAISE EXCEPTION 'GENERATOR_MANAGEMENT_FORBIDDEN';
  END IF;
 if p_client_operation_id is null then raise exception 'CLIENT_OPERATION_REQUIRED'; end if;
 select * into v_operation from public.offline_sync_operations o where o.user_id=v_user_id and o.client_operation_id=p_client_operation_id limit 1;
 if found then if v_operation.operation_type <> 'generator_create' then raise exception 'GENERATOR_OPERATION_TYPE_CONFLICT'; end if; return query select (v_operation.response->>'id')::bigint,coalesce(v_operation.response->>'name',''),true; return; end if;
 insert into public.generators(tenant_id,site_id,code,name,serial_number,rated_capacity_kw,fuel_type,client_operation_id) values(v_tenant_id,p_site_id,upper(trim(p_code)),trim(p_name),nullif(trim(coalesce(p_serial_number,'')),''),p_rated_capacity_kw,p_fuel_type,p_client_operation_id) returning * into v_generator;
 insert into public.offline_sync_operations(tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response) values(v_tenant_id,p_site_id,v_user_id,p_client_operation_id,'generator_create','generator',v_generator.id,jsonb_build_object('id',v_generator.id,'name',v_generator.name));
 return query select v_generator.id,v_generator.name,false;
exception when unique_violation then
 select * into v_operation from public.offline_sync_operations o where o.user_id=v_user_id and o.client_operation_id=p_client_operation_id limit 1;
 if found and v_operation.operation_type='generator_create' then return query select (v_operation.response->>'id')::bigint,coalesce(v_operation.response->>'name',''),true; return; end if;
 select * into v_generator from public.generators g where g.client_operation_id=p_client_operation_id and g.tenant_id=v_tenant_id and g.site_id=p_site_id limit 1;
 if found then return query select v_generator.id,v_generator.name,true; return; end if; raise;
end;$function$;

CREATE OR REPLACE FUNCTION public.powerhub_sync_generator_update(p_site_id bigint, p_generator_id bigint, p_name text, p_rated_capacity_kw numeric, p_fuel_level_liters numeric, p_operating_hours numeric, p_status text, p_expected_updated_at timestamp with time zone, p_client_operation_id text)
 RETURNS TABLE(id bigint, name text, updated_at timestamp with time zone, replayed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user_id bigint;
  v_tenant_id bigint;
  v_current public.generators%rowtype;
  v_updated public.generators%rowtype;
  v_operation public.offline_sync_operations%rowtype;
begin
  select u.id into v_user_id
  from public.users u
  where u.auth_user_id=auth.uid() and u.account_status='active'
  limit 1;
  if v_user_id is null then raise exception 'AUTH_USER_NOT_FOUND'; end if;

  select s.tenant_id into v_tenant_id
  from public.sites s
  where s.id=p_site_id and s.status <> 'archived';
  if v_tenant_id is null then raise exception 'SITE_OUT_OF_SCOPE'; end if;
  IF NOT private.powerhub_has_generator_management_access(v_tenant_id,p_site_id) THEN
    RAISE EXCEPTION 'GENERATOR_MANAGEMENT_FORBIDDEN';
  END IF;

  if p_client_operation_id is null then raise exception 'CLIENT_OPERATION_REQUIRED'; end if;

  select * into v_operation
  from public.offline_sync_operations o
  where o.user_id=v_user_id and o.client_operation_id=p_client_operation_id
  limit 1;

  if found then
    if v_operation.operation_type <> 'generator_update' then
      raise exception 'GENERATOR_OPERATION_TYPE_CONFLICT';
    end if;
    return query
      select (v_operation.response->>'id')::bigint,
             coalesce(v_operation.response->>'name',''),
             (v_operation.response->>'updatedAt')::timestamptz,
             true;
    return;
  end if;

  select * into v_current
  from public.generators g
  where g.id=p_generator_id
    and g.tenant_id=v_tenant_id
    and g.site_id=p_site_id
  limit 1;

  if not found then raise exception 'GENERATOR_OUT_OF_SCOPE'; end if;

  if p_expected_updated_at is null or v_current.updated_at<>p_expected_updated_at then
    raise exception 'GENERATOR_VERSION_CONFLICT';
  end if;

  update public.generators as g
  set name=trim(p_name),
      rated_capacity_kw=p_rated_capacity_kw,
      fuel_level_liters=p_fuel_level_liters,
      operating_hours=p_operating_hours,
      status=p_status,
      updated_at=clock_timestamp()
  where g.id=p_generator_id
    and g.tenant_id=v_tenant_id
    and g.site_id=p_site_id
    and g.updated_at=p_expected_updated_at
  returning g.* into v_updated;

  if not found then raise exception 'GENERATOR_VERSION_CONFLICT'; end if;

  insert into public.offline_sync_operations(
    tenant_id,site_id,user_id,client_operation_id,operation_type,
    entity_type,entity_id,response
  )
  values(
    v_tenant_id,p_site_id,v_user_id,p_client_operation_id,'generator_update',
    'generator',v_updated.id,
    jsonb_build_object('id',v_updated.id,'name',v_updated.name,'updatedAt',v_updated.updated_at)
  );

  return query select v_updated.id,v_updated.name,v_updated.updated_at,false;

exception when unique_violation then
  select * into v_operation
  from public.offline_sync_operations o
  where o.user_id=v_user_id and o.client_operation_id=p_client_operation_id
  limit 1;

  if found and v_operation.operation_type='generator_update' then
    return query
      select (v_operation.response->>'id')::bigint,
             coalesce(v_operation.response->>'name',v_updated.name),
             (v_operation.response->>'updatedAt')::timestamptz,
             true;
    return;
  end if;
  raise;
end;
$function$;
