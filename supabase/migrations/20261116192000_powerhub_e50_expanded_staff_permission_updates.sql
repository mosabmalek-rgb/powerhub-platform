-- E50: complete E47 permission updates with optimistic concurrency and audit.
-- Source only until the protected staging migration runner applies this exact version.
-- Never allow direct client EXECUTE; this is an audited service_role-only API.
CREATE OR REPLACE FUNCTION public.powerhub_update_staff_profile_permissions_e50(
  p_tenant_id bigint,
  p_site_id bigint,
  p_actor_user_id bigint,
  p_profile_id bigint,
  p_custom_role_id bigint,
  p_permissions jsonb,
  p_expected_updated_at timestamptz
)
RETURNS TABLE(profile_id bigint, target_user_id bigint, replayed boolean)
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $e50$
DECLARE
  v_profile public.staff_profiles%rowtype;
  v_actor_role text;
  v_capability text;
  v_permissions jsonb;
  v_existing jsonb;
BEGIN
  IF p_permissions IS NULL OR jsonb_typeof(p_permissions) <> 'array'
    OR jsonb_array_length(p_permissions) > 41 OR p_expected_updated_at IS NULL THEN
    RAISE EXCEPTION 'INVALID_STAFF_PERMISSIONS' USING errcode='P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_permissions) v(item)
             WHERE jsonb_typeof(v.item) <> 'string')
    OR (SELECT count(*) <> count(DISTINCT item)
        FROM jsonb_array_elements_text(p_permissions) v(item)) THEN
    RAISE EXCEPTION 'INVALID_STAFF_PERMISSIONS' USING errcode='P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(p_permissions) selected(capability)
    WHERE selected.capability NOT IN (
      'manageSubscribers',
            'manageGenerators',
            'recordReadings',
            'accessFieldApp',
            'approveReadings',
            'manageTariffs',
            'issueInvoices',
            'collectPayments',
            'viewFinancialReports',
            'approvePaymentDocumentation',
            'manageExpenses',
            'managePayroll',
            'viewAudit',
            'viewInventory',
            'viewSuppliers',
            'viewPurchases',
            'manageInventoryItems',
            'manageSuppliers',
            'createInventoryItems',
            'editInventoryItems',
            'deactivateInventoryItems',
            'createSuppliers',
            'editSuppliers',
            'deactivateSuppliers',
            'createWarehouses',
            'editWarehouses',
            'deactivateWarehouses',
            'createPurchases',
            'approvePurchases',
            'receiveInventory',
            'manageSupplierPayments',
            'reverseSupplierPayments',
            'viewSupplierLedger',
            'issueInventory',
            'adjustInventory',
            'manageFuelAndConsumption',
            'manageMaintenance',
            'viewInventoryReports',
            'viewStocktakes',
            'manageStocktakes',
            'approveStocktakes'
    )
  ) THEN
    RAISE EXCEPTION 'INVALID_STAFF_PERMISSION_CAPABILITY' USING errcode='P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sites
                 WHERE id=p_site_id AND tenant_id=p_tenant_id) THEN
    RAISE EXCEPTION 'SITE_OUT_OF_SCOPE' USING errcode='P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users
                 WHERE id=p_actor_user_id AND account_status='active') THEN
    RAISE EXCEPTION 'STAFF_PERMISSION_MANAGEMENT_FORBIDDEN' USING errcode='P0001';
  END IF;
  SELECT m.role INTO v_actor_role
  FROM public.tenant_members m
  WHERE m.tenant_id=p_tenant_id AND m.user_id=p_actor_user_id
    AND m.role='owner' AND m.is_active=true
    AND m.membership_status='active'
    AND (m.expires_at IS NULL OR m.expires_at>now())
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'STAFF_PERMISSION_MANAGEMENT_FORBIDDEN' USING errcode='P0001';
  END IF;
  -- Validate owner ceiling inside the same transaction, not the UI catalog.
  FOR v_capability IN SELECT item FROM jsonb_array_elements_text(p_permissions) s(item) LOOP
    IF EXISTS (
      SELECT 1 FROM public.tenant_member_capability_overrides o
      WHERE o.tenant_id=p_tenant_id AND o.user_id=p_actor_user_id
        AND o.capability=v_capability AND o.is_allowed=false
    ) OR EXISTS (
      SELECT 1 FROM public.platform_role_policies policy
      WHERE policy.role='owner' AND policy.capability=v_capability
        AND policy.is_allowed=false
    ) THEN
      RAISE EXCEPTION 'STAFF_PERMISSION_OUTSIDE_OWNER_SCOPE' USING errcode='P0001';
    END IF;
  END LOOP;
  IF p_custom_role_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.custom_permission_roles
    WHERE id=p_custom_role_id AND tenant_id=p_tenant_id AND is_active=true
  ) THEN
    RAISE EXCEPTION 'CUSTOM_ROLE_NOT_FOUND' USING errcode='P0001';
  END IF;
  SELECT p.* INTO v_profile FROM public.staff_profiles p
  WHERE p.id=p_profile_id AND p.tenant_id=p_tenant_id
    AND (p.site_id=p_site_id OR p.site_id IS NULL)
    AND p.role<>'owner' AND p.is_active=true AND p.archived_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'STAFF_PROFILE_OUT_OF_SCOPE' USING errcode='P0001';
  END IF;
  v_permissions:=coalesce((
    SELECT jsonb_agg(item ORDER BY item)
    FROM jsonb_array_elements_text(p_permissions) v(item)
  ),'[]'::jsonb);
  v_existing:=coalesce((
    SELECT jsonb_agg(item ORDER BY item)
    FROM jsonb_array_elements_text(coalesce(v_profile.permissions,'[]'::jsonb)) v(item)
  ),'[]'::jsonb);
  -- A retry after successful commit is harmless when the exact desired state
  -- already exists; a stale competing change is otherwise rejected.
  IF v_profile.permissions IS NOT NULL AND v_existing=v_permissions
    AND v_profile.custom_role_id IS NOT DISTINCT FROM p_custom_role_id THEN
    RETURN QUERY SELECT v_profile.id,v_profile.user_id,true;
    RETURN;
  END IF;
  IF v_profile.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'STAFF_PERMISSION_VERSION_CONFLICT' USING errcode='P0001';
  END IF;
  UPDATE public.staff_profiles
    SET permissions=v_permissions,custom_role_id=p_custom_role_id,
      updated_at=greatest(clock_timestamp(),v_profile.updated_at+interval '1 microsecond')
    WHERE id=v_profile.id AND tenant_id=p_tenant_id;
  INSERT INTO public.audit_logs(
    tenant_id,site_id,user_id,actor_tenant_role,entity_type,
    entity_id,action,before_data,after_data
  ) VALUES (
    p_tenant_id,p_site_id,p_actor_user_id,v_actor_role,'staff_profile',
    v_profile.id::text,'update_permissions',to_jsonb(v_profile),
    jsonb_build_object('targetUserId',v_profile.user_id,
      'permissions',v_permissions,'customRoleId',p_custom_role_id,'source','e50')
  );
  RETURN QUERY SELECT v_profile.id,v_profile.user_id,false;
END
$e50$;

REVOKE ALL ON FUNCTION public.powerhub_update_staff_profile_permissions_e50(
  bigint,bigint,bigint,bigint,bigint,jsonb,timestamptz
) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_update_staff_profile_permissions_e50(
  bigint,bigint,bigint,bigint,bigint,jsonb,timestamptz
) TO service_role;

DO $verify$
DECLARE f regprocedure :=
  'public.powerhub_update_staff_profile_permissions_e50(bigint,bigint,bigint,bigint,bigint,jsonb,timestamptz)'::regprocedure;
BEGIN
  IF has_function_privilege('anon',f,'EXECUTE') OR
     has_function_privilege('authenticated',f,'EXECUTE') OR
     NOT has_function_privilege('service_role',f,'EXECUTE') THEN
    RAISE EXCEPTION 'E50_PERMISSION_UPDATE_ACL_DRIFT';
  END IF;
END $verify$;
