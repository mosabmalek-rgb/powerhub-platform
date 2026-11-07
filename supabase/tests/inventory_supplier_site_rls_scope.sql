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

CREATE TABLE public.supplier_purchases(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint NOT NULL);
CREATE TABLE public.supplier_purchase_lines(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,purchase_id bigint NOT NULL);
CREATE TABLE public.supplier_purchase_receipts(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint NOT NULL,purchase_id bigint NOT NULL);
CREATE TABLE public.supplier_purchase_receipt_lines(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,receipt_id bigint NOT NULL,purchase_id bigint NOT NULL);
CREATE TABLE public.supplier_purchase_returns(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint NOT NULL,purchase_id bigint NOT NULL);
CREATE TABLE public.supplier_purchase_return_lines(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,return_id bigint NOT NULL,purchase_id bigint NOT NULL);
CREATE TABLE public.supplier_payments(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint NOT NULL);
CREATE TABLE public.supplier_payment_allocations(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,payment_id bigint NOT NULL,purchase_id bigint NOT NULL);
CREATE TABLE public.supplier_ledger_entries(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint NOT NULL);

INSERT INTO public.site_memberships VALUES
 (1,10,NULL,'owner',true),(2,10,100,'member',true),(3,10,200,'member',true),(4,20,300,'member',true);

INSERT INTO public.supplier_purchases VALUES (1,10,100),(2,10,200),(3,20,300);
INSERT INTO public.supplier_purchase_lines VALUES (11,10,1),(12,10,2),(13,20,3);
INSERT INTO public.supplier_purchase_receipts VALUES (21,10,100,1),(22,10,200,2),(23,20,300,3);
INSERT INTO public.supplier_purchase_receipt_lines VALUES (31,10,21,1),(32,10,22,2),(33,20,23,3);
INSERT INTO public.supplier_purchase_returns VALUES (41,10,100,1),(42,10,200,2),(43,20,300,3);
INSERT INTO public.supplier_purchase_return_lines VALUES (51,10,41,1),(52,10,42,2),(53,20,43,3);
INSERT INTO public.supplier_payments VALUES (61,10,100),(62,10,200),(63,20,300);
INSERT INTO public.supplier_payment_allocations VALUES (71,10,61,1),(72,10,62,2),(73,20,63,3);
INSERT INTO public.supplier_ledger_entries VALUES (81,10,100),(82,10,200),(83,20,300);

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
DECLARE target text; visible bigint;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'supplier_purchases','supplier_purchase_lines','supplier_purchase_receipts',
    'supplier_purchase_receipt_lines','supplier_payments',
    'supplier_payment_allocations','supplier_ledger_entries'
  ] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I',target) INTO visible;
    IF visible<>1 THEN RAISE EXCEPTION 'BRANCH_MEMBER_CROSS_SITE_OR_TENANT_READ: % count=%',target,visible; END IF;
  END LOOP;
END
$branch_member$;
RESET ROLE;

-- Tenant owner may see both of its branches, but not another tenant.
SELECT set_config('request.jwt.claim.user_id','1',false);
SET ROLE authenticated;
DO $tenant_owner$
DECLARE target text; visible bigint;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'supplier_purchases','supplier_purchase_lines','supplier_purchase_receipts',
    'supplier_purchase_receipt_lines','supplier_payments',
    'supplier_payment_allocations','supplier_ledger_entries'
  ] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I',target) INTO visible;
    IF visible<>2 THEN RAISE EXCEPTION 'TENANT_OWNER_BRANCH_VISIBILITY_FAILED: % count=%',target,visible; END IF;
  END LOOP;
END
$tenant_owner$;
RESET ROLE;

-- Another tenant member remains confined to their own tenant and branch.
SELECT set_config('request.jwt.claim.user_id','4',false);
SET ROLE authenticated;
DO $other_tenant$
DECLARE target text; visible bigint;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'supplier_purchases','supplier_purchase_lines','supplier_purchase_receipts',
    'supplier_purchase_receipt_lines','supplier_payments',
    'supplier_payment_allocations','supplier_ledger_entries'
  ] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I',target) INTO visible;
    IF visible<>1 THEN RAISE EXCEPTION 'OTHER_TENANT_SCOPE_FAILED: % count=%',target,visible; END IF;
  END LOOP;
END
$other_tenant$;
RESET ROLE;

SELECT 'INVENTORY_SUPPLIER_SITE_RLS_SCOPE_OK' AS result;
