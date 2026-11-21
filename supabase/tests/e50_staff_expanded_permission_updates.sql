\set ON_ERROR_STOP on
-- E50 runs against disposable PostgreSQL 17 only. Reuse E47's actual SQL
-- bootstrap and positive/negative atomic assignment assertions.
\ir e47_staff_custom_permissions_atomic.sql

ALTER TABLE public.staff_profiles ADD COLUMN archived_at timestamptz;
CREATE TABLE public.users (
  id bigint PRIMARY KEY,
  account_status text NOT NULL
);
INSERT INTO public.users(id,account_status) VALUES(1,'active'),(2,'active'),(3,'disabled');
CREATE TABLE public.sites (id bigint PRIMARY KEY,tenant_id bigint NOT NULL);
INSERT INTO public.sites(id,tenant_id) VALUES(101,10),(102,10),(201,20);
CREATE TABLE public.custom_permission_roles (
 id bigint PRIMARY KEY, tenant_id bigint NOT NULL, is_active boolean NOT NULL DEFAULT true
);
INSERT INTO public.custom_permission_roles(id,tenant_id,is_active) VALUES(70,10,true),(71,20,true);
GRANT SELECT ON public.users,public.sites,public.custom_permission_roles TO service_role;

\ir ../migrations/20261116192000_powerhub_e50_expanded_staff_permission_updates.sql

DO $acl$
DECLARE f regprocedure := 'public.powerhub_update_staff_profile_permissions_e50(bigint,bigint,bigint,bigint,bigint,jsonb,timestamptz)'::regprocedure;
BEGIN
 IF f IS NULL OR has_function_privilege('anon',f,'EXECUTE')
   OR has_function_privilege('authenticated',f,'EXECUTE')
   OR NOT has_function_privilege('service_role',f,'EXECUTE') THEN
   RAISE EXCEPTION 'E50_ACL_DRIFT';
 END IF;
END $acl$;

SET ROLE service_role;
DO $cases$
DECLARE
  p bigint;
  old_version timestamptz;
  current_version timestamptz;
  before_audit bigint;
  r record;
  old_count bigint;
BEGIN
 SELECT id,updated_at INTO p,old_version FROM public.staff_profiles
 WHERE tenant_id=10 AND user_id=30;
 IF p IS NULL THEN RAISE EXCEPTION 'E50_MISSING_E47_PROFILE'; END IF;
 SELECT count(*) INTO before_audit FROM public.audit_logs WHERE entity_id=p::text AND action='update_permissions';

 -- Expanded operations are saved atomically as exact explicit rights.
 SELECT * INTO r FROM public.powerhub_update_staff_profile_permissions_e50(
   10,101,1,p,NULL,'["viewInventoryReports","approvePaymentDocumentation"]'::jsonb,old_version
 );
 IF r.profile_id<>p OR r.replayed THEN RAISE EXCEPTION 'E50_CREATE_RIGHTS_FAILED'; END IF;
 SELECT updated_at INTO current_version FROM public.staff_profiles WHERE id=p;
 IF current_version <= old_version OR
    (SELECT permissions FROM public.staff_profiles WHERE id=p)
       <> '["approvePaymentDocumentation","viewInventoryReports"]'::jsonb THEN
   RAISE EXCEPTION 'E50_RIGHTS_OR_VERSION_FAILED';
 END IF;
 IF (SELECT count(*) FROM public.audit_logs WHERE entity_id=p::text AND action='update_permissions')<>before_audit+1 THEN
   RAISE EXCEPTION 'E50_AUDIT_MISSING';
 END IF;

 -- Safe retry: the old version may replay only an already committed identical state.
 SELECT * INTO r FROM public.powerhub_update_staff_profile_permissions_e50(
   10,101,1,p,NULL,'["viewInventoryReports","approvePaymentDocumentation"]'::jsonb,old_version
 );
 IF NOT r.replayed THEN RAISE EXCEPTION 'E50_REPLAY_NOT_IDEMPOTENT'; END IF;
 IF (SELECT count(*) FROM public.audit_logs WHERE entity_id=p::text AND action='update_permissions')<>before_audit+1 THEN
   RAISE EXCEPTION 'E50_REPLAY_CREATED_EXTRA_AUDIT';
 END IF;

 BEGIN
   PERFORM public.powerhub_update_staff_profile_permissions_e50(
     10,101,1,p,NULL,'["recordReadings"]'::jsonb,old_version);
   RAISE EXCEPTION 'E50_STALE_UPDATE_ALLOWED';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
   IF SQLERRM<>'STAFF_PERMISSION_VERSION_CONFLICT' THEN RAISE; END IF;
 END;

 -- Exact current revision can intentionally remove every operational right.
 PERFORM public.powerhub_update_staff_profile_permissions_e50(
   10,101,1,p,NULL,'[]'::jsonb,current_version);
 IF (SELECT permissions FROM public.staff_profiles WHERE id=p)<>'[]'::jsonb THEN
    RAISE EXCEPTION 'E50_EMPTY_RIGHTS_DENIED';
 END IF;
 SELECT updated_at INTO current_version FROM public.staff_profiles WHERE id=p;

 -- No reserved, duplicated, unknown, non-string or outside-owner grants.
 BEGIN
   PERFORM public.powerhub_update_staff_profile_permissions_e50(
     10,101,1,p,NULL,'["manageTeam"]'::jsonb,current_version);
   RAISE EXCEPTION 'E50_RESERVED_ACCEPTED';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
   IF SQLERRM<>'INVALID_STAFF_PERMISSION_CAPABILITY' THEN RAISE; END IF;
 END;
 BEGIN
   PERFORM public.powerhub_update_staff_profile_permissions_e50(
     10,101,1,p,NULL,'["recordReadings","recordReadings"]'::jsonb,current_version);
   RAISE EXCEPTION 'E50_DUPLICATE_ACCEPTED';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
   IF SQLERRM<>'INVALID_STAFF_PERMISSIONS' THEN RAISE; END IF;
 END;
 BEGIN
   PERFORM public.powerhub_update_staff_profile_permissions_e50(
     10,101,1,p,NULL,'[null]'::jsonb,current_version);
   RAISE EXCEPTION 'E50_NONSTRING_ACCEPTED';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
   IF SQLERRM<>'INVALID_STAFF_PERMISSIONS' THEN RAISE; END IF;
 END;
 BEGIN
   PERFORM public.powerhub_update_staff_profile_permissions_e50(
     10,101,1,p,NULL,'["managePayroll"]'::jsonb,current_version);
   RAISE EXCEPTION 'E50_OWNER_DENY_ACCEPTED';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
   IF SQLERRM<>'STAFF_PERMISSION_OUTSIDE_OWNER_SCOPE' THEN RAISE; END IF;
 END;
 BEGIN
   PERFORM public.powerhub_update_staff_profile_permissions_e50(
     10,101,1,p,NULL,'["reverseSupplierPayments"]'::jsonb,current_version);
   RAISE EXCEPTION 'E50_POLICY_DENY_ACCEPTED';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
   IF SQLERRM<>'STAFF_PERMISSION_OUTSIDE_OWNER_SCOPE' THEN RAISE; END IF;
 END;
 BEGIN
   PERFORM public.powerhub_update_staff_profile_permissions_e50(
     10,101,2,p,NULL,'["recordReadings"]'::jsonb,current_version);
   RAISE EXCEPTION 'E50_FOREIGN_ACTOR_ACCEPTED';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
   IF SQLERRM<>'STAFF_PERMISSION_MANAGEMENT_FORBIDDEN' THEN RAISE; END IF;
 END;
 BEGIN
   PERFORM public.powerhub_update_staff_profile_permissions_e50(
     10,201,1,p,NULL,'["recordReadings"]'::jsonb,current_version);
   RAISE EXCEPTION 'E50_FOREIGN_SITE_ACCEPTED';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
   IF SQLERRM<>'SITE_OUT_OF_SCOPE' THEN RAISE; END IF;
 END;
 BEGIN
   PERFORM public.powerhub_update_staff_profile_permissions_e50(
     10,101,1,p,71,'["recordReadings"]'::jsonb,current_version);
   RAISE EXCEPTION 'E50_FOREIGN_CUSTOM_ROLE_ACCEPTED';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
   IF SQLERRM<>'CUSTOM_ROLE_NOT_FOUND' THEN RAISE; END IF;
 END;

 SELECT count(*) INTO old_count FROM public.audit_logs WHERE entity_id=p::text AND action='update_permissions';
 IF old_count<>before_audit+2 OR
    (SELECT permissions FROM public.staff_profiles WHERE id=p)<>'[]'::jsonb THEN
   RAISE EXCEPTION 'E50_REJECTION_MUTATED_DATA';
 END IF;

 -- The E47 tenant-wide employee can be updated from a site in the same tenant.
 SELECT id,updated_at INTO p,old_version FROM public.staff_profiles WHERE tenant_id=10 AND user_id=31;
 PERFORM public.powerhub_update_staff_profile_permissions_e50(
   10,102,1,p,NULL,'["approvePaymentDocumentation"]'::jsonb,old_version);
 IF (SELECT permissions FROM public.staff_profiles WHERE id=p)
   <> '["approvePaymentDocumentation"]'::jsonb THEN
   RAISE EXCEPTION 'E50_TENANT_WIDE_PROFILE_FAILED';
 END IF;
END $cases$;
RESET ROLE;
SELECT 'E50_EXPANDED_PERMISSION_UPDATE_ATOMIC_CONCURRENCY_AUDIT_PASS' AS result;
