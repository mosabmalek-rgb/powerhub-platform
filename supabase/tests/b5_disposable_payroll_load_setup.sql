\set ON_ERROR_STOP on
-- Disposable B5 payroll maker/checker load only; no external payroll funds.
DO $id$ BEGIN IF current_database()<>'powerhub_b5_synthetic_payroll_test'
THEN RAISE EXCEPTION 'B5_PAYROLL_REQUIRES_DISPOSABLE_DB'; END IF; END $id$;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE public.users(id bigint PRIMARY KEY,account_status text NOT NULL,platform_role text);
CREATE TABLE public.tenant_members(
 tenant_id bigint NOT NULL,user_id bigint NOT NULL,
 is_active boolean NOT NULL,membership_status text NOT NULL,
 PRIMARY KEY(tenant_id,user_id));
CREATE TABLE public.payroll_runs(
 id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint,
 period text NOT NULL,status text NOT NULL,
 created_by_user_id bigint NOT NULL,approved_by_user_id bigint,
 updated_at timestamptz DEFAULT now());
CREATE TABLE public.financial_settlements(
 tenant_id bigint,site_id bigint,status text,
 period_start timestamptz,period_end timestamptz);
CREATE TABLE public.audit_logs(
 tenant_id bigint,site_id bigint,user_id bigint,actor_platform_role text,
 entity_type text,entity_id text,action text,after_data jsonb);
\ir ../migrations/20261110023000_powerhub_payroll_approval_integrity.sql
GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO service_role;
INSERT INTO public.users VALUES
 (9901,'active',NULL),(9902,'active',NULL),(9903,'active',NULL),
 (9904,'suspended',NULL),(9910,'active',NULL);
INSERT INTO public.tenant_members VALUES
 (901,9901,true,'active'),(901,9902,true,'active'),
 (901,9903,true,'active'),(901,9904,true,'active'),(902,9910,true,'active');
INSERT INTO public.payroll_runs(id,tenant_id,site_id,period,status,created_by_user_id)
SELECT 10000+n,901,9101,'2026-11','draft',9901 FROM generate_series(1,400) AS n;
INSERT INTO public.payroll_runs(id,tenant_id,site_id,period,status,created_by_user_id)
VALUES (10401,901,9101,'2026-11','draft',9901);

CREATE TABLE public.b5_payroll_samples(
 worker integer NOT NULL CHECK(worker BETWEEN 1 AND 4),
 iteration integer NOT NULL CHECK(iteration BETWEEN 1 AND 100),
 replay boolean NOT NULL,backend_pid integer NOT NULL,
 elapsed_ms numeric(14,3) NOT NULL CHECK(elapsed_ms>=0),
 PRIMARY KEY(worker,iteration,replay));
GRANT INSERT,SELECT ON public.b5_payroll_samples TO service_role;
CREATE OR REPLACE FUNCTION public.b5_payroll_approval_sample(
 p_worker integer,p_iteration integer,p_replay boolean)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp
AS $fn$
DECLARE ts timestamptz; v_id bigint; v_run bigint;
BEGIN
 IF current_database()<>'powerhub_b5_synthetic_payroll_test' OR
  p_worker NOT BETWEEN 1 AND 4 OR p_iteration NOT BETWEEN 1 AND 100
 THEN RAISE EXCEPTION 'B5_PAYROLL_INVALID_SCOPE'; END IF;
 v_run:=10000+(p_worker-1)*100+p_iteration;
 ts:=clock_timestamp();
 SELECT payroll_run_id INTO v_id FROM public.powerhub_approve_payroll(
  901,9101,9902,v_run);
 IF v_id IS DISTINCT FROM v_run THEN RAISE EXCEPTION 'B5_PAYROLL_RESULT_DRIFT'; END IF;
 INSERT INTO public.b5_payroll_samples(worker,iteration,replay,backend_pid,elapsed_ms)
 VALUES (p_worker,p_iteration,p_replay,pg_backend_pid(),
  round(extract(epoch FROM clock_timestamp()-ts)::numeric*1000,3));
 RETURN 'PAYROLL_OK';
END $fn$;
REVOKE ALL ON FUNCTION public.b5_payroll_approval_sample(integer,integer,boolean)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.b5_payroll_approval_sample(integer,integer,boolean)
 TO service_role;
SELECT 'B5_PAYROLL_DISPOSABLE_FIXTURE_READY' AS result;
