\set ON_ERROR_STOP on

DO $role_anon$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $role_anon$;
DO $role_authenticated$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $role_authenticated$;
DO $role_service$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $role_service$;
CREATE SCHEMA IF NOT EXISTS private;
CREATE TABLE public.site_memberships(
  user_id bigint NOT NULL, tenant_id bigint NOT NULL, site_id bigint,
  role text NOT NULL, is_active boolean NOT NULL DEFAULT true
);
CREATE OR REPLACE FUNCTION private.powerhub_has_site_access(target_tenant_id bigint,target_site_id bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,private
AS $fn$
  SELECT EXISTS(
    SELECT 1 FROM public.site_memberships m
    WHERE m.user_id=nullif(current_setting('request.jwt.claim.user_id',true),'')::bigint
      AND m.tenant_id=target_tenant_id AND m.is_active
      AND (m.role='owner' OR m.site_id=target_site_id)
  );
$fn$;

-- Model the existing permissive tenant-level read policy without granting
-- browser roles direct access to the membership table in this isolated fixture.
CREATE OR REPLACE FUNCTION private.powerhub_has_tenant_access(target_tenant_id bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,private
AS $fn$
  SELECT EXISTS(
    SELECT 1 FROM public.site_memberships m
    WHERE m.user_id=nullif(current_setting('request.jwt.claim.user_id',true),'')::bigint
      AND m.tenant_id=target_tenant_id AND m.is_active
  );
$fn$;

CREATE TABLE public.supplier_purchases(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint NOT NULL,supplier_id bigint NOT NULL);
CREATE TABLE public.supplier_purchase_lines(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,purchase_id bigint NOT NULL);
CREATE TABLE public.supplier_purchase_receipts(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint NOT NULL,purchase_id bigint NOT NULL);
CREATE TABLE public.supplier_purchase_receipt_lines(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,receipt_id bigint NOT NULL,purchase_id bigint NOT NULL);
CREATE TABLE public.supplier_purchase_returns(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint NOT NULL,purchase_id bigint NOT NULL);
CREATE TABLE public.supplier_purchase_return_lines(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,return_id bigint NOT NULL,purchase_id bigint NOT NULL);
CREATE TABLE public.supplier_payments(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint NOT NULL,supplier_id bigint NOT NULL);
CREATE TABLE public.supplier_payment_allocations(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,payment_id bigint NOT NULL,purchase_id bigint,supplier_ledger_entry_id bigint);
CREATE TABLE public.supplier_ledger_entries(
  id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint NOT NULL,
  supplier_id bigint NOT NULL,entry_type text NOT NULL,purchase_id bigint,supplier_payment_id bigint
);

CREATE TABLE public.suppliers(
  id bigint PRIMARY KEY,tenant_id bigint NOT NULL,supplier_code text NOT NULL,name text NOT NULL
);

INSERT INTO public.site_memberships VALUES
 (1,10,NULL,'owner',true),(2,10,100,'member',true),(3,10,200,'member',true),(4,20,300,'member',true);

INSERT INTO public.supplier_purchases VALUES (1,10,100,1000),(2,10,200,2000),(3,20,300,3000);
INSERT INTO public.supplier_purchase_lines VALUES (11,10,1),(12,10,2),(13,20,3);
INSERT INTO public.supplier_purchase_receipts VALUES (21,10,100,1),(22,10,200,2),(23,20,300,3);
INSERT INTO public.supplier_purchase_receipt_lines VALUES (31,10,21,1),(32,10,22,2),(33,20,23,3);
INSERT INTO public.supplier_purchase_returns VALUES (41,10,100,1),(42,10,200,2),(43,20,300,3);
INSERT INTO public.supplier_purchase_return_lines VALUES (51,10,41,1),(52,10,42,2),(53,20,43,3);
INSERT INTO public.supplier_payments VALUES (61,10,100,1000),(62,10,200,2000),(63,20,300,3000);
INSERT INTO public.supplier_payment_allocations VALUES
 (71,10,61,1,null),(72,10,62,2,null),(73,20,63,3,null),
 (74,10,61,null,81),(75,10,62,null,82),(76,20,63,null,83),
 -- Deliberately invalid cross-document links must remain invisible even to a tenant owner.
 (77,10,61,null,82),(78,10,61,null,84),(79,10,61,null,85),(80,10,61,2,null);
INSERT INTO public.supplier_ledger_entries VALUES
 (81,10,100,1000,'opening_balance',null,null),
 (82,10,200,2000,'opening_balance',null,null),
 (83,20,300,3000,'opening_balance',null,null),
 (84,10,100,9999,'opening_balance',null,null),
 (85,10,100,1000,'adjustment',null,null);
INSERT INTO public.suppliers VALUES
 (1000,10,'SUP-1000','Tenant 10 - Branch 100 Supplier'),
 (2000,10,'SUP-2000','Tenant 10 - Branch 200 Supplier'),
 (3000,20,'SUP-3000','Tenant 20 - Branch 300 Supplier');

DO $setup$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'supplier_purchases','supplier_purchase_lines','supplier_purchase_receipts',
    'supplier_purchase_receipt_lines','supplier_payments',
    'supplier_payment_allocations','supplier_ledger_entries'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',target);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (private.powerhub_has_tenant_access(tenant_id))',target||'_tenant_read',target);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated',target);
    EXECUTE format('GRANT ALL ON public.%I TO service_role',target);
  END LOOP;
  ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;
  CREATE POLICY suppliers_tenant_read ON public.suppliers
    FOR SELECT TO authenticated USING (private.powerhub_has_tenant_access(tenant_id));
  GRANT SELECT ON public.suppliers TO authenticated;
  GRANT ALL ON public.suppliers TO service_role;
  -- Supplier return rows contain refunds and account details; browser roles
  -- must continue to use the scoped server RPC rather than direct table reads.
  ALTER TABLE public.supplier_purchase_returns ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.supplier_purchase_return_lines ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.supplier_purchase_returns,public.supplier_purchase_return_lines FROM PUBLIC,anon,authenticated;
  GRANT ALL ON public.supplier_purchase_returns,public.supplier_purchase_return_lines TO service_role;
END
$setup$;
GRANT USAGE ON SCHEMA public,private TO authenticated;
GRANT EXECUTE ON FUNCTION private.powerhub_has_site_access(bigint,bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION private.powerhub_has_tenant_access(bigint) TO authenticated;

\ir ../migrations/20261107120000_powerhub_inventory_supplier_site_rls_scope.sql

-- Return tables intentionally remain unreadable to browser roles.
DO $return_acl$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.supplier_purchase_returns'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.supplier_purchase_return_lines'::regclass) THEN
    RAISE EXCEPTION 'SUPPLIER_RETURN_RLS_DISABLED';
  END IF;
  IF has_table_privilege('authenticated','public.supplier_purchase_returns','SELECT')
     OR has_table_privilege('authenticated','public.supplier_purchase_return_lines','SELECT')
     OR has_table_privilege('anon','public.supplier_purchase_returns','SELECT')
     OR has_table_privilege('anon','public.supplier_purchase_return_lines','SELECT') THEN
    RAISE EXCEPTION 'SUPPLIER_RETURN_BROWSER_READ_GRANT_PRESENT';
  END IF;
  IF NOT has_table_privilege('service_role','public.supplier_purchase_returns','SELECT')
     OR NOT has_table_privilege('service_role','public.supplier_purchase_return_lines','SELECT') THEN
    RAISE EXCEPTION 'SUPPLIER_RETURN_SERVICE_READ_GRANT_MISSING';
  END IF;
END
$return_acl$;


-- A branch member must not see same-tenant records from another branch, or
-- any records from a different tenant, including child rows reached by direct API.
SELECT set_config('request.jwt.claim.user_id','2',false);
SET ROLE authenticated;
DO $branch_member$
DECLARE target text; visible bigint; expected_visible bigint;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'supplier_purchases','supplier_purchase_lines','supplier_purchase_receipts',
    'supplier_purchase_receipt_lines','supplier_payments',
    'supplier_payment_allocations','supplier_ledger_entries'
  ] LOOP
    expected_visible := CASE
      WHEN target='supplier_payment_allocations' THEN 2
      WHEN target='supplier_ledger_entries' THEN 3
      ELSE 1
    END;
    EXECUTE format('SELECT count(*) FROM public.%I',target) INTO visible;
    IF visible<>expected_visible THEN
      RAISE EXCEPTION 'BRANCH_MEMBER_CROSS_SITE_OR_TENANT_READ: % expected=% actual=%',target,expected_visible,visible;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.suppliers)<>2 THEN
    RAISE EXCEPTION 'BRANCH_MEMBER_SUPPLIER_CATALOG_TENANT_SCOPE_FAILED';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.supplier_payment_allocations
    WHERE id=74 AND purchase_id IS NULL AND supplier_ledger_entry_id=81
  ) OR EXISTS (
    SELECT 1 FROM public.supplier_payment_allocations WHERE id IN (72,73,75,76,77,78,79,80)
  ) THEN
    RAISE EXCEPTION 'BRANCH_MEMBER_OPENING_BALANCE_ALLOCATION_SCOPE_FAILED';
  END IF;
END
$branch_member$;
RESET ROLE;

-- Tenant owner may see both of its branches, but not another tenant.
SELECT set_config('request.jwt.claim.user_id','1',false);
SET ROLE authenticated;
DO $tenant_owner$
DECLARE target text; visible bigint; expected_visible bigint;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'supplier_purchases','supplier_purchase_lines','supplier_purchase_receipts',
    'supplier_purchase_receipt_lines','supplier_payments',
    'supplier_payment_allocations','supplier_ledger_entries'
  ] LOOP
    expected_visible := CASE
      WHEN target='supplier_payment_allocations' THEN 4
      WHEN target='supplier_ledger_entries' THEN 4
      ELSE 2
    END;
    EXECUTE format('SELECT count(*) FROM public.%I',target) INTO visible;
    IF visible<>expected_visible THEN
      RAISE EXCEPTION 'TENANT_OWNER_BRANCH_VISIBILITY_FAILED: % expected=% actual=%',target,expected_visible,visible;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.suppliers)<>2 THEN
    RAISE EXCEPTION 'TENANT_OWNER_SUPPLIER_CATALOG_SCOPE_FAILED';
  END IF;
  IF (SELECT count(*) FROM public.supplier_payment_allocations
      WHERE id IN (74,75) AND purchase_id IS NULL AND supplier_ledger_entry_id IN (81,82))<>2
     OR EXISTS (
       SELECT 1 FROM public.supplier_payment_allocations WHERE id IN (73,76,77,78,79,80)
     ) THEN
    RAISE EXCEPTION 'TENANT_OWNER_OPENING_BALANCE_ALLOCATION_SCOPE_FAILED';
  END IF;
END
$tenant_owner$;
RESET ROLE;

-- Another tenant member remains confined to their own tenant and branch.
SELECT set_config('request.jwt.claim.user_id','4',false);
SET ROLE authenticated;
DO $other_tenant$
DECLARE target text; visible bigint; expected_visible bigint;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'supplier_purchases','supplier_purchase_lines','supplier_purchase_receipts',
    'supplier_purchase_receipt_lines','supplier_payments',
    'supplier_payment_allocations','supplier_ledger_entries'
  ] LOOP
    expected_visible := CASE
      WHEN target='supplier_payment_allocations' THEN 2
      ELSE 1
    END;
    EXECUTE format('SELECT count(*) FROM public.%I',target) INTO visible;
    IF visible<>expected_visible THEN
      RAISE EXCEPTION 'OTHER_TENANT_SCOPE_FAILED: % expected=% actual=%',target,expected_visible,visible;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.suppliers)<>1 THEN
    RAISE EXCEPTION 'OTHER_TENANT_SUPPLIER_CATALOG_SCOPE_FAILED';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.supplier_payment_allocations
    WHERE id=76 AND purchase_id IS NULL AND supplier_ledger_entry_id=83
  ) OR EXISTS (
    SELECT 1 FROM public.supplier_payment_allocations WHERE id IN (71,72,74,75,77,78,79,80)
  ) THEN
    RAISE EXCEPTION 'OTHER_TENANT_OPENING_BALANCE_ALLOCATION_SCOPE_FAILED';
  END IF;
END
$other_tenant$;
RESET ROLE;

-- Simulate historical column-level browser grants that a table-level REVOKE
-- alone cannot clear. The security migration must remove both grants without
-- disturbing the authorized service_role route.
GRANT SELECT (name) ON TABLE public.suppliers TO authenticated;
GRANT SELECT (purchase_id) ON TABLE public.supplier_purchase_lines TO anon;

DO $column_grant_preflight$
BEGIN
  IF NOT has_column_privilege('authenticated','public.suppliers','name','SELECT')
     OR NOT has_column_privilege('anon','public.supplier_purchase_lines','purchase_id','SELECT') THEN
    RAISE EXCEPTION 'SUPPLIER_COLUMN_GRANT_FIXTURE_NOT_ESTABLISHED';
  END IF;
END
$column_grant_preflight$;

\ir ../migrations/20261107150000_powerhub_supplier_browser_read_acl_revoke.sql

-- All supplier-domain reads are mediated by capability-checked server routes.
-- No table-level or column-level browser grant may expose supplier records via
-- PostgREST; the service-role server path must remain intact.
DO $server_only_acl$
DECLARE
  target text;
  target_oid oid;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'suppliers',
    'supplier_purchases',
    'supplier_purchase_lines',
    'supplier_purchase_receipts',
    'supplier_purchase_receipt_lines',
    'supplier_payments',
    'supplier_payment_allocations',
    'supplier_ledger_entries',
    'supplier_purchase_returns',
    'supplier_purchase_return_lines'
  ] LOOP
    target_oid := to_regclass(format('public.%I', target));
    IF has_table_privilege('anon', target_oid, 'SELECT')
       OR has_any_column_privilege('anon', target_oid, 'SELECT')
       OR has_table_privilege('authenticated', target_oid, 'SELECT')
       OR has_any_column_privilege('authenticated', target_oid, 'SELECT') THEN
      RAISE EXCEPTION 'SUPPLIER_BROWSER_DIRECT_READ_ALLOWED: %', target;
    END IF;

    IF has_table_privilege('anon', target_oid, 'INSERT')
       OR has_table_privilege('anon', target_oid, 'UPDATE')
       OR has_table_privilege('anon', target_oid, 'DELETE')
       OR has_table_privilege('authenticated', target_oid, 'INSERT')
       OR has_table_privilege('authenticated', target_oid, 'UPDATE')
       OR has_table_privilege('authenticated', target_oid, 'DELETE') THEN
      RAISE EXCEPTION 'SUPPLIER_BROWSER_DIRECT_WRITE_ALLOWED: %', target;
    END IF;

    IF NOT has_table_privilege('service_role', target_oid, 'SELECT') THEN
      RAISE EXCEPTION 'SUPPLIER_SERVER_READ_NOT_PRESERVED: %', target;
    END IF;
  END LOOP;
END
$server_only_acl$;

-- Reapplying the final ACL phase must remain safe. Do not replay the earlier
-- pre-revocation phase here: it explicitly requires the historical SELECT grant.
\ir ../migrations/20261107150000_powerhub_supplier_browser_read_acl_revoke.sql

GRANT USAGE ON SCHEMA public TO anon,service_role;
SET ROLE anon;
DO $anonymous_runtime_denial$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'suppliers','supplier_purchases','supplier_purchase_lines',
    'supplier_purchase_receipts','supplier_purchase_receipt_lines',
    'supplier_payments','supplier_payment_allocations','supplier_ledger_entries',
    'supplier_purchase_returns','supplier_purchase_return_lines'
  ] LOOP
    BEGIN
      EXECUTE format('SELECT count(*) FROM public.%I',target);
      RAISE EXCEPTION 'SUPPLIER_ANON_QUERY_WAS_NOT_DENIED: %',target;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;
END
$anonymous_runtime_denial$;
RESET ROLE;

-- Even an owner with a valid tenant identity must go through server capability
-- checks once the final ACL phase has run.
SELECT set_config('request.jwt.claim.user_id','1',false);
SET ROLE authenticated;
DO $authenticated_runtime_denial$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'suppliers','supplier_purchases','supplier_purchase_lines',
    'supplier_purchase_receipts','supplier_purchase_receipt_lines',
    'supplier_payments','supplier_payment_allocations','supplier_ledger_entries',
    'supplier_purchase_returns','supplier_purchase_return_lines'
  ] LOOP
    BEGIN
      EXECUTE format('SELECT count(*) FROM public.%I',target);
      RAISE EXCEPTION 'SUPPLIER_AUTHENTICATED_QUERY_WAS_NOT_DENIED: %',target;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;
END
$authenticated_runtime_denial$;
RESET ROLE;

SET ROLE service_role;
DO $service_runtime_positive_control$
DECLARE target text; visible bigint;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'suppliers','supplier_purchases','supplier_purchase_lines',
    'supplier_purchase_receipts','supplier_purchase_receipt_lines',
    'supplier_payments','supplier_payment_allocations','supplier_ledger_entries',
    'supplier_purchase_returns','supplier_purchase_return_lines'
  ] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I',target) INTO visible;
    IF visible=0 THEN
      RAISE EXCEPTION 'SUPPLIER_SERVICE_QUERY_POSITIVE_CONTROL_EMPTY: %',target;
    END IF;
  END LOOP;
END
$service_runtime_positive_control$;
RESET ROLE;

SELECT 'INVENTORY_SUPPLIER_SITE_RLS_AND_SERVER_ONLY_READ_OK' AS result;
