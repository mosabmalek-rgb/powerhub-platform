-- E47: Atomic staff role + selected permissions. PostgreSQL transaction
-- calls the existing audited owner/tenant/branch/quota assignment RPC and only
-- then updates exactly its newly assigned profile within the same transaction.
-- On any invalid permission, all role/association changes roll back.
-- Explicit empty permission arrays DENY every optional capability.
-- No service-role privileges are granted to public client roles.
CREATE OR REPLACE FUNCTION public.powerhub_assign_existing_staff_with_permissions(
  p_tenant_id bigint,
  p_site_id bigint,
  p_actor_user_id bigint,
  p_target_user_id bigint,
  p_role text,
  p_all_branches boolean,
  p_permissions jsonb
)
RETURNS TABLE(profile_id bigint, target_user_id bigint)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $e47$
DECLARE
  v_profile_id bigint;
  v_target_user_id bigint;
  v_actor_membership_role text;
  v_requested_capability text;
  v_actor_is_owner boolean;
  v_before jsonb;
BEGIN
  IF p_permissions IS NULL OR jsonb_typeof(p_permissions) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_STAFF_PERMISSIONS' USING errcode='P0001';
  END IF;
  IF jsonb_array_length(p_permissions) > 41 THEN
    RAISE EXCEPTION 'INVALID_STAFF_PERMISSIONS' USING errcode='P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_permissions) item(value)
    WHERE jsonb_typeof(item.value) <> 'string'
  ) OR (
    SELECT count(*) <> count(DISTINCT value)
    FROM jsonb_array_elements_text(p_permissions) AS selections(value)
  ) THEN
    RAISE EXCEPTION 'INVALID_STAFF_PERMISSIONS' USING errcode='P0001';
  END IF;
  -- Reject non-delegable operations even if they are part of the owner's
  -- own capability set. The API never offers these selections.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(p_permissions) AS selected(capability)
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

  SELECT m.role INTO v_actor_membership_role
  FROM public.tenant_members m
  WHERE m.tenant_id=p_tenant_id AND m.user_id=p_actor_user_id
    AND m.role='owner' AND m.is_active=true
    AND m.membership_status='active'
    AND (m.expires_at IS NULL OR m.expires_at>now());
  v_actor_is_owner := FOUND;
  IF NOT v_actor_is_owner THEN
    RAISE EXCEPTION 'STAFF_PERMISSION_MANAGEMENT_FORBIDDEN' USING errcode='P0001';
  END IF;

  -- Effective owner capability: explicit membership DENY and global owner
  -- policy DENY take precedence; do not derive access from client-supplied
  -- actor permissions. This also rejects capabilities outside owner scope.
  FOR v_requested_capability IN
    SELECT selections.value FROM jsonb_array_elements_text(p_permissions) AS selections(value)
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.tenant_member_capability_overrides o
      WHERE o.tenant_id=p_tenant_id
        AND o.user_id=p_actor_user_id
        AND o.capability=v_requested_capability AND o.is_allowed=false
    ) OR EXISTS (
      SELECT 1 FROM public.platform_role_policies policy
      WHERE policy.role='owner'
        AND policy.capability=v_requested_capability AND policy.is_allowed=false
    ) THEN
      RAISE EXCEPTION 'STAFF_PERMISSION_OUTSIDE_OWNER_SCOPE' USING errcode='P0001';
    END IF;
  END LOOP;

  SELECT a.profile_id,a.target_user_id INTO STRICT v_profile_id,v_target_user_id
  FROM public.powerhub_assign_existing_staff(
    p_tenant_id,p_site_id,p_actor_user_id,p_target_user_id,p_role,p_all_branches
  ) a;
  SELECT to_jsonb(profile) INTO STRICT v_before
  FROM public.staff_profiles profile
  WHERE profile.id=v_profile_id AND profile.tenant_id=p_tenant_id
    AND profile.user_id=v_target_user_id
    AND (profile.site_id=p_site_id OR (p_all_branches AND profile.site_id IS NULL))
    AND profile.is_active=true
  FOR UPDATE;
  UPDATE public.staff_profiles
  SET permissions=p_permissions, custom_role_id=NULL, updated_at=now()
  WHERE id=v_profile_id AND tenant_id=p_tenant_id AND user_id=v_target_user_id;

  INSERT INTO public.audit_logs (
    tenant_id,site_id,user_id,actor_tenant_role,entity_type,entity_id,
    action,before_data,after_data
  ) VALUES (
    p_tenant_id,p_site_id,p_actor_user_id,v_actor_membership_role,
    'staff_profile',v_profile_id::text,'update_permissions',v_before,
    jsonb_build_object('targetUserId',v_target_user_id,
      'permissions',p_permissions,'duringAssignment',true)
  );
  RETURN QUERY SELECT v_profile_id,v_target_user_id;
END;
$e47$;

REVOKE ALL ON FUNCTION public.powerhub_assign_existing_staff_with_permissions(
 bigint,bigint,bigint,bigint,text,boolean,jsonb
) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_assign_existing_staff_with_permissions(
 bigint,bigint,bigint,bigint,text,boolean,jsonb
) TO service_role;

DO $verify$
BEGIN
  IF has_function_privilege('anon',
    'public.powerhub_assign_existing_staff_with_permissions(bigint,bigint,bigint,bigint,text,boolean,jsonb)',
    'EXECUTE')
    OR has_function_privilege('authenticated',
    'public.powerhub_assign_existing_staff_with_permissions(bigint,bigint,bigint,bigint,text,boolean,jsonb)',
    'EXECUTE')
    OR NOT has_function_privilege('service_role',
    'public.powerhub_assign_existing_staff_with_permissions(bigint,bigint,bigint,bigint,text,boolean,jsonb)',
    'EXECUTE')
  THEN RAISE EXCEPTION 'E47_STAFF_ASSIGNMENT_RPC_ACL_DRIFT'; END IF;
END $verify$;
