\set ON_ERROR_STOP on
-- Disposable PostgreSQL regression: official payroll approval SQL on a
-- minimal faithful schema. Every test is rolled back; no external payments.
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE public.users(
 id bigint PRIMARY KEY,account_status text NOT NULL,platform_role text
);
CREATE TABLE public.tenant_members(
 tenant_id bigint NOT NULL,user_id bigint NOT NULL,
 is_active boolean NOT NULL,membership_status text NOT NULL,
 PRIMARY KEY(tenant_id,user_id)
);
CREATE TABLE public.payroll_runs(
 id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint,
 period text NOT NULL,status text NOT NULL,
 created_by_user_id bigint NOT NULL,approved_by_user_id bigint,
 updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.financial_settlements(
 tenant_id bigint,site_id bigint,status text,
 period_start timestamptz,period_end timestamptz
);
CREATE TABLE public.audit_logs(
 tenant_id bigint,site_id bigint,user_id bigint,actor_platform_role text,
 entity_type text,entity_id text,action text,after_data jsonb
);
\ir ../migrations/20261110023000_powerhub_payroll_approval_integrity.sql
BEGIN;
INSERT INTO public.users VALUES
 (9901,'active',NULL),(9902,'active',NULL),(9903,'active',NULL),
 (9904,'suspended',NULL),(9910,'active',NULL);
INSERT INTO public.tenant_members VALUES
 (901,9901,true,'active'),(901,9902,true,'active'),
 (901,9903,true,'active'),(901,9904,true,'active'),
 (902,9910,true,'active');
INSERT INTO public.payroll_runs(
 id,tenant_id,site_id,period,status,created_by_user_id)
VALUES (1401,901,9101,'2026-10','draft',9901),
 (1402,901,9101,'2026-10','draft',9901);

DO $assert$
DECLARE rejected boolean; old_audit bigint; new_audit bigint;
BEGIN
 -- Maker may not approve own draft, even as an owner.
 rejected:=false;
 BEGIN PERFORM public.powerhub_approve_payroll(901,9101,9901,1401);
 EXCEPTION WHEN SQLSTATE '22023' THEN rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'PAYROLL_CI_SELF_APPROVAL_ALLOWED'; END IF;
 IF (SELECT status FROM public.payroll_runs WHERE id=1401)<>'draft'
 THEN RAISE EXCEPTION 'PAYROLL_CI_SELF_APPROVAL_MUTATED_SOURCE'; END IF;

 -- Non-members and disabled members cannot claim someone else's approval.
 rejected:=false;
 BEGIN PERFORM public.powerhub_approve_payroll(901,9101,9910,1401);
 EXCEPTION WHEN SQLSTATE '22023' THEN rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'PAYROLL_CI_CROSS_TENANT_APPROVER_ALLOWED'; END IF;
 rejected:=false;
 BEGIN PERFORM public.powerhub_approve_payroll(901,9101,9904,1401);
 EXCEPTION WHEN SQLSTATE '22023' THEN rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'PAYROLL_CI_SUSPENDED_APPROVER_ALLOWED'; END IF;

 SELECT count(*) INTO old_audit FROM public.audit_logs;
 PERFORM public.powerhub_approve_payroll(901,9101,9902,1401);
 PERFORM public.powerhub_approve_payroll(901,9101,9902,1401);
 SELECT count(*) INTO new_audit FROM public.audit_logs;
 IF new_audit-old_audit<>1 THEN
   RAISE EXCEPTION 'PAYROLL_CI_APPROVAL_AUDIT_NOT_EXACTLY_ONCE'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.payroll_runs
   WHERE id=1401 AND status='approved' AND created_by_user_id=9901
     AND approved_by_user_id=9902)
 THEN RAISE EXCEPTION 'PAYROLL_CI_INDEPENDENT_APPROVAL_NOT_PERSISTED'; END IF;

 rejected:=false;
 BEGIN PERFORM public.powerhub_approve_payroll(901,9101,9903,1401);
 EXCEPTION WHEN SQLSTATE '23505' THEN rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'PAYROLL_CI_APPROVER_REPLAY_CONFLICT_ALLOWED';END IF;
 rejected:=false;
 BEGIN PERFORM public.powerhub_approve_payroll(901,9102,9902,1401);
 EXCEPTION WHEN SQLSTATE 'P0001' THEN rejected:=true;END;
 IF NOT rejected THEN RAISE EXCEPTION 'PAYROLL_CI_CROSS_SITE_APPROVAL_ALLOWED'; END IF;

 -- Closed period blocks NEW approval, not identical replay of old approval.
 INSERT INTO public.financial_settlements VALUES
 (901,9101,'locked','2026-10-01T00:00:00Z','2026-10-31T23:59:59Z');
 rejected:=false;
 BEGIN PERFORM public.powerhub_approve_payroll(901,9101,9902,1402);
 EXCEPTION WHEN SQLSTATE 'P0001' THEN rejected:=true;END;
 IF NOT rejected THEN RAISE EXCEPTION 'PAYROLL_CI_CLOSED_PERIOD_APPROVAL_ALLOWED';END IF;
 PERFORM public.powerhub_approve_payroll(901,9101,9902,1401);

 IF has_function_privilege('anon','public.powerhub_approve_payroll(bigint,bigint,bigint,bigint)','EXECUTE')
    OR has_function_privilege('authenticated','public.powerhub_approve_payroll(bigint,bigint,bigint,bigint)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.powerhub_approve_payroll(bigint,bigint,bigint,bigint)','EXECUTE')
 THEN RAISE EXCEPTION 'PAYROLL_CI_FUNCTION_EXECUTE_ACL_WRONG'; END IF;
END $assert$;
ROLLBACK;
SELECT 'PASS: payroll maker/checker, tenant/site, exactly-once audit and closed-period approval' AS acceptance;
