\set ON_ERROR_STOP on
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS private;
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;

CREATE TABLE public.users(id bigint PRIMARY KEY,auth_user_id uuid NOT NULL UNIQUE,role text NOT NULL DEFAULT 'user',platform_role text,account_status text NOT NULL DEFAULT 'active');
CREATE TABLE public.tenant_members(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,user_id bigint NOT NULL,role text NOT NULL,is_active boolean NOT NULL DEFAULT true,membership_status text NOT NULL DEFAULT 'active',expires_at timestamptz);
CREATE TABLE public.sites(id bigint PRIMARY KEY,tenant_id bigint NOT NULL);
CREATE TABLE public.custom_permission_roles(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,permissions jsonb,is_active boolean NOT NULL DEFAULT true);
CREATE TABLE public.staff_profiles(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,user_id bigint NOT NULL,site_id bigint,role text NOT NULL,custom_role_id bigint,permissions jsonb,is_active boolean NOT NULL DEFAULT true,archived_at timestamptz,suspension_started_at timestamptz,suspension_ends_at timestamptz);
CREATE TABLE public.staff_profile_capability_overrides(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,profile_id bigint NOT NULL,capability text NOT NULL,is_allowed boolean NOT NULL);
CREATE TABLE public.tenant_member_capability_overrides(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,user_id bigint NOT NULL,capability text NOT NULL,is_allowed boolean NOT NULL);
CREATE TABLE public.platform_role_policies(id bigint PRIMARY KEY,role text NOT NULL,capability text NOT NULL,is_allowed boolean NOT NULL);

CREATE TABLE public.employees(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint);
CREATE TABLE public.employee_attendance(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,employee_id bigint NOT NULL,site_id bigint NOT NULL);
CREATE TABLE public.employee_adjustments(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,employee_id bigint NOT NULL,site_id bigint,adjustment_type text NOT NULL);
CREATE TABLE public.payroll_runs(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint);
CREATE TABLE public.payroll_items(id bigint PRIMARY KEY,payroll_run_id bigint NOT NULL,employee_id bigint NOT NULL);
CREATE TABLE public.payroll_adjustment_allocations(id bigint PRIMARY KEY,payroll_run_id bigint NOT NULL,adjustment_id bigint NOT NULL);
CREATE TABLE public.employee_adjustment_repayments(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint,adjustment_id bigint);

INSERT INTO public.users(id,auth_user_id,role,platform_role,account_status) VALUES
(1,'00000000-0000-0000-0000-000000000001','user',NULL,'active'),
(2,'00000000-0000-0000-0000-000000000002','user',NULL,'active'),
(3,'00000000-0000-0000-0000-000000000003','user',NULL,'active'),
(4,'00000000-0000-0000-0000-000000000004','user',NULL,'active'),
(5,'00000000-0000-0000-0000-000000000005','user',NULL,'active'),
(6,'00000000-0000-0000-0000-000000000006','user',NULL,'active'),
(7,'00000000-0000-0000-0000-000000000007','admin','platform_support','active'),
(8,'00000000-0000-0000-0000-000000000008','admin','platform_admin','active'),
(9,'00000000-0000-0000-0000-000000000009','user',NULL,'disabled'),
(10,'00000000-0000-0000-0000-000000000010','user',NULL,'active'),
(11,'00000000-0000-0000-0000-000000000011','user',NULL,'active'),
(12,'00000000-0000-0000-0000-000000000012','user',NULL,'active'),
(13,'00000000-0000-0000-0000-000000000013','user',NULL,'active');
INSERT INTO public.sites VALUES(10,1),(11,1),(20,2);
INSERT INTO public.tenant_members(id,tenant_id,user_id,role,expires_at) VALUES
(1,1,1,'owner',NULL),(2,1,2,'member',NULL),(3,1,3,'member',NULL),(4,1,4,'member',NULL),
(5,1,5,'owner',now()-interval '1 day'),(6,1,6,'member',NULL),(7,1,7,'member',NULL),
(8,1,11,'member',NULL),(9,1,12,'member',NULL),(10,1,13,'member',NULL),
(11,2,10,'member',NULL),(12,1,9,'member',NULL);
INSERT INTO public.custom_permission_roles VALUES(1,1,'["managePayroll"]'::jsonb,true);
INSERT INTO public.staff_profiles(id,tenant_id,user_id,site_id,role,custom_role_id,permissions,is_active,archived_at,suspension_started_at,suspension_ends_at) VALUES
(1,1,2,10,'manager',NULL,NULL,true,NULL,NULL,NULL),
(2,1,3,11,'accountant',NULL,NULL,true,NULL,NULL,NULL),
(3,1,4,10,'manager',NULL,NULL,true,NULL,now()-interval '1 hour',now()+interval '1 hour'),
(4,1,6,NULL,'accountant',NULL,NULL,true,NULL,NULL,NULL),
(5,2,10,20,'manager',NULL,NULL,true,NULL,NULL,NULL),
(6,1,9,10,'accountant',NULL,NULL,true,NULL,NULL,NULL),
(7,1,11,10,'accountant',NULL,'[]'::jsonb,true,NULL,NULL,NULL),
(8,1,12,10,'manager',1,NULL,true,NULL,NULL,NULL),
(9,1,13,10,'accountant',NULL,NULL,true,NULL,NULL,NULL);
INSERT INTO public.staff_profile_capability_overrides VALUES
(1,1,1,'managePayroll',true),(2,1,9,'managePayroll',false);

INSERT INTO public.employees VALUES(1,1,10),(2,1,11),(3,2,20);
INSERT INTO public.employee_attendance VALUES(1,1,1,10),(2,1,2,11),(3,2,3,20);
INSERT INTO public.employee_adjustments VALUES(1,1,1,10,'advance'),(2,1,2,11,'deduction'),(3,2,3,20,'advance');
INSERT INTO public.payroll_runs VALUES(1,1,10),(2,1,11),(3,2,20);
INSERT INTO public.payroll_items VALUES(1,1,1),(2,2,2),(3,3,3);
INSERT INTO public.payroll_adjustment_allocations VALUES(1,1,1),(2,2,2),(3,3,3);
INSERT INTO public.employee_adjustment_repayments VALUES(1,1,10,1);

ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_adjustment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_adjustment_repayments ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.employees,public.employee_attendance,public.employee_adjustments,public.payroll_runs,public.payroll_items,public.payroll_adjustment_allocations TO authenticated;

CREATE OR REPLACE FUNCTION private.powerhub_current_user_id()
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$ SELECT account.id FROM public.users account WHERE account.auth_user_id=(SELECT auth.uid()) LIMIT 1 $$;
CREATE OR REPLACE FUNCTION private.powerhub_is_platform_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
SELECT EXISTS(SELECT 1 FROM public.users account WHERE account.auth_user_id=(SELECT auth.uid())
AND account.account_status='active' AND account.role='admin'
AND account.platform_role IN ('platform_owner','platform_admin','finance_admin'))
$$;
GRANT USAGE ON SCHEMA private TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION private.powerhub_current_user_id() TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION private.powerhub_is_platform_admin() TO authenticated,service_role;

\ir ../migrations/20261104220000_powerhub_payroll_read_capability_rls.sql

DO $acl$
BEGIN
 IF has_function_privilege('anon','private.powerhub_has_site_capability(bigint,bigint,text)','EXECUTE')
 OR NOT has_function_privilege('authenticated','private.powerhub_has_site_capability(bigint,bigint,text)','EXECUTE') THEN
  RAISE EXCEPTION 'PAYROLL_CAPABILITY_HELPER_ACL_FAILED';
 END IF;
 IF has_table_privilege('authenticated','public.employee_adjustment_repayments','SELECT') THEN
  RAISE EXCEPTION 'EMPLOYEE_ADJUSTMENT_REPAYMENTS_MUST_REMAIN_SERVER_ONLY';
 END IF;
END
$acl$;

-- Manager without managePayroll is denied; manageExpenses allows adjustment reads.
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
SET ROLE authenticated;
DO $manager_default$
BEGIN
 IF (SELECT count(*) FROM public.employees)<>0 OR (SELECT count(*) FROM public.employee_attendance)<>0 OR (SELECT count(*) FROM public.payroll_runs)<>0 THEN RAISE EXCEPTION 'MANAGER_WITHOUT_PAYROLL_CAPABILITY_READS_PAYROLL_DATA'; END IF;
 IF (SELECT count(*) FROM public.employee_adjustments)<>1 THEN RAISE EXCEPTION 'MANAGE_EXPENSES_ADJUSTMENT_SCOPE_FAILED'; END IF;
END
$manager_default$;
RESET ROLE;

-- Explicit capability grant bypasses route role list consistently with the server resolver.
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
SET ROLE authenticated;
DO $manager_override$
BEGIN
 IF (SELECT count(*) FROM public.employees)<>1 OR (SELECT count(*) FROM public.employee_attendance)<>1 OR (SELECT count(*) FROM public.payroll_runs)<>1 THEN RAISE EXCEPTION 'MANAGER_EXPLICIT_PAYROLL_GRANT_FAILED'; END IF;
END
$manager_override$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000012',false);
SET ROLE authenticated;
DO $custom_role$
BEGIN
 IF (SELECT count(*) FROM public.employees)<>1 OR (SELECT count(*) FROM public.payroll_runs)<>1 THEN RAISE EXCEPTION 'CUSTOM_ROLE_PAYROLL_PERMISSION_FAILED'; END IF;
END
$custom_role$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000011',false);
SET ROLE authenticated;
DO $explicit_deny$
BEGIN
 IF (SELECT count(*) FROM public.employees)<>0 OR (SELECT count(*) FROM public.employee_adjustments)<>0 THEN RAISE EXCEPTION 'EXPLICIT_EMPTY_PERMISSIONS_DID_NOT_DENY'; END IF;
END
$explicit_deny$;
RESET ROLE;

-- Accountant is limited to the assigned site, unlike the tenant owner.
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',false);
SET ROLE authenticated;
DO $accountant$
BEGIN
 IF (SELECT count(*) FROM public.employees)<>1 OR NOT EXISTS(SELECT 1 FROM public.employees WHERE id=2)
 OR (SELECT count(*) FROM public.employee_attendance)<>1 OR (SELECT count(*) FROM public.employee_adjustments)<>1
 OR (SELECT count(*) FROM public.payroll_runs)<>1 OR (SELECT count(*) FROM public.payroll_items)<>1
 OR (SELECT count(*) FROM public.payroll_adjustment_allocations)<>1 THEN RAISE EXCEPTION 'ACCOUNTANT_PAYROLL_BRANCH_SCOPE_FAILED'; END IF;
END
$accountant$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000013',false);
SET ROLE authenticated;
DO $profile_deny$
BEGIN
 IF (SELECT count(*) FROM public.employees)<>0 OR (SELECT count(*) FROM public.employee_attendance)<>0 OR (SELECT count(*) FROM public.payroll_runs)<>0 THEN RAISE EXCEPTION 'PROFILE_CAPABILITY_DENY_NOT_ENFORCED'; END IF;
END
$profile_deny$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
SET ROLE authenticated;
DO $owner$
BEGIN
 IF (SELECT count(*) FROM public.employees)<>2 OR (SELECT count(*) FROM public.employee_attendance)<>2 OR (SELECT count(*) FROM public.payroll_runs)<>2
 OR (SELECT count(*) FROM public.payroll_items)<>2 OR (SELECT count(*) FROM public.payroll_adjustment_allocations)<>2 THEN RAISE EXCEPTION 'OWNER_PAYROLL_SCOPE_FAILED'; END IF;
END
$owner$;
RESET ROLE;

INSERT INTO public.tenant_member_capability_overrides VALUES(1,1,1,'managePayroll',false);
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
SET ROLE authenticated;
DO $owner_override$
BEGIN
 IF (SELECT count(*) FROM public.payroll_runs)<>0 OR (SELECT count(*) FROM public.employees)<>0 THEN RAISE EXCEPTION 'OWNER_MEMBER_OVERRIDE_DENY_FAILED'; END IF;
 IF (SELECT count(*) FROM public.employee_adjustments)<>2 THEN RAISE EXCEPTION 'OWNER_EXPENSE_CAPABILITY_SHOULD_REMAIN'; END IF;
END
$owner_override$;
RESET ROLE;

INSERT INTO public.platform_role_policies VALUES(1,'manager','managePayroll',false);
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
SET ROLE authenticated;
DO $platform_deny$
BEGIN
 IF (SELECT count(*) FROM public.employee_attendance)<>0 THEN RAISE EXCEPTION 'PLATFORM_ROLE_DENY_NOT_ENFORCED'; END IF;
 IF (SELECT count(*) FROM public.employee_adjustments)<>1 THEN RAISE EXCEPTION 'EXPENSE_PERMISSION_SHOULD_REMAIN'; END IF;
END
$platform_deny$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000006',false);
SET ROLE authenticated;
DO $global_profile$
BEGIN
 IF (SELECT count(*) FROM public.employees)<>2 OR (SELECT count(*) FROM public.payroll_runs)<>2 THEN RAISE EXCEPTION 'GLOBAL_ACCOUNTANT_SCOPE_FAILED'; END IF;
END
$global_profile$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000004',false);
SET ROLE authenticated;
DO $suspended$
BEGIN
 IF (SELECT count(*) FROM public.employees)<>0 OR (SELECT count(*) FROM public.employee_attendance)<>0 THEN RAISE EXCEPTION 'SUSPENDED_PROFILE_NOT_DENIED'; END IF;
END
$suspended$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000005',false);
SET ROLE authenticated;
DO $expired$
BEGIN
 IF (SELECT count(*) FROM public.employees)<>0 THEN RAISE EXCEPTION 'EXPIRED_OWNER_NOT_DENIED'; END IF;
END
$expired$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000007',false);
SET ROLE authenticated;
DO $support$
BEGIN
 IF (SELECT count(*) FROM public.employees)<>0 THEN RAISE EXCEPTION 'PLATFORM_SUPPORT_MUST_NOT_BYPASS'; END IF;
END
$support$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000009',false);
SET ROLE authenticated;
DO $disabled$
BEGIN
 IF (SELECT count(*) FROM public.employees)<>0 THEN RAISE EXCEPTION 'DISABLED_ACCOUNT_NOT_DENIED'; END IF;
END
$disabled$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000010',false);
SET ROLE authenticated;
DO $tenant_two$
BEGIN
 IF (SELECT count(*) FROM public.employees)<>0 OR (SELECT count(*) FROM public.payroll_runs)<>0 THEN RAISE EXCEPTION 'TENANT_TWO_MANAGER_PAYROLL_LEAK'; END IF;
 IF (SELECT count(*) FROM public.employee_adjustments)<>1 THEN RAISE EXCEPTION 'TENANT_TWO_EXPENSE_SCOPE_FAILED'; END IF;
END
$tenant_two$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000008',false);
SET ROLE authenticated;
DO $platform_admin$
BEGIN
 IF (SELECT count(*) FROM public.employees)<>3 OR (SELECT count(*) FROM public.payroll_runs)<>3 THEN RAISE EXCEPTION 'PLATFORM_ADMIN_PAYROLL_ACCESS_FAILED'; END IF;
END
$platform_admin$;
RESET ROLE;

SELECT 'HR_PAYROLL_CAPABILITY_RLS_OK' AS result;
