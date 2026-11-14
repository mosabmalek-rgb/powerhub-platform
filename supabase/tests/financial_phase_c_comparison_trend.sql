\set ON_ERROR_STOP on
-- An independent disposable PostgreSQL acceptance sandbox for the new C read-only RPCs.
-- No database outside this CI disposable DB is touched.
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END$$;
CREATE TABLE public.tenants(id bigint PRIMARY KEY,name text NOT NULL);
CREATE TABLE public.sites(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,name text NOT NULL,status text NOT NULL);
CREATE TABLE public.financial_gl_accounts(
 tenant_id bigint NOT NULL,code text NOT NULL,account_class text NOT NULL,
 PRIMARY KEY(tenant_id,code)
);
CREATE TABLE public.financial_gl_entries(
 id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint NOT NULL,
 period text NOT NULL,source_type text NOT NULL,source_id text,
 source_revision integer,source_fingerprint text,
 accounting_policy_version text,reverses_entry_id bigint
);
CREATE TABLE public.financial_gl_lines(
 id bigint PRIMARY KEY,entry_id bigint NOT NULL,tenant_id bigint NOT NULL,
 site_id bigint NOT NULL,account_code text NOT NULL,side text NOT NULL,amount numeric NOT NULL
);
CREATE TABLE public.financial_accrual_period_reviews(
 id bigint PRIMARY KEY,tenant_id bigint,site_id bigint,period text,status text
);
INSERT INTO public.tenants VALUES(1,'Tenant One'),(2,'Tenant Two');
INSERT INTO public.sites VALUES
 (1,1,'Site One','active'),(2,1,'Site Two','active'),(3,2,'Other Tenant','active');
INSERT INTO public.financial_gl_accounts VALUES
 (1,'4100','revenue'),(1,'1200','asset'),(2,'4100','revenue'),(2,'1200','asset');
INSERT INTO public.financial_gl_entries VALUES
 (1,1,1,'2026-09','service_recognition','SEP',1,'shaSep','gaza-invoice-service-calendar-days-v1',NULL),
 (2,1,1,'2026-10','service_recognition','OCT',1,'shaOct','gaza-invoice-service-calendar-days-v1',NULL),
 (3,1,2,'2026-10','service_recognition','OCT2',1,'shaOct2','gaza-invoice-service-calendar-days-v1',NULL);
INSERT INTO public.financial_gl_lines VALUES
 (1,1,1,1,'1200','debit',100),(2,1,1,1,'4100','credit',100),
 (3,2,1,1,'1200','debit',120),(4,2,1,1,'4100','credit',120),
 (5,3,1,2,'1200','debit',200),(6,3,1,2,'4100','credit',200);
-- Minimal stub isolates C migration contract. B1's actual full source is tested separately.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_site_statements(
 p_tenant_id bigint,p_site_id bigint,p_period text
) RETURNS jsonb LANGUAGE sql STABLE AS $fn$
 SELECT jsonb_build_object(
  'siteId',p_site_id,'tenantId',p_tenant_id,'period',p_period,
  'periodStart',p_period||'-01',
  'periodEnd',to_char(((p_period||'-01')::date+interval '1 month'-interval '1 day')::date,'YYYY-MM-DD'),
  'hasPostedData',EXISTS(SELECT 1 FROM public.financial_gl_entries
   WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND period=p_period),
  'isSourceCoverageComplete',true,'unreconciledSourceCount',0,
  'incomeStatement',jsonb_build_object('serviceRevenue',0),
  'accounts','[]'::jsonb
 );
$fn$;
\i supabase/migrations/20261113204500_powerhub_financial_gl_monthly_comparison_c.sql
\i supabase/migrations/20261114090000_powerhub_financial_c_comparison_postgrest_transaction_mode.sql
DO $checks$
DECLARE v jsonb;v2 jsonb;old_fingerprint text;missing bigint;
BEGIN
 IF (SELECT provolatile FROM pg_proc WHERE oid='public.powerhub_financial_gl_monthly_comparison(bigint,bigint,text,text)'::regprocedure)<>'v'
 THEN RAISE EXCEPTION 'C_COMPARISON_POSTGREST_READONLY_TRANSACTION_REGRESSION';END IF;
 IF has_function_privilege('anon','public.powerhub_financial_gl_monthly_comparison(bigint,bigint,text,text)','EXECUTE')
 OR has_function_privilege('authenticated','public.powerhub_financial_gl_monthly_comparison(bigint,bigint,text,text)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.powerhub_financial_gl_monthly_comparison(bigint,bigint,text,text)','EXECUTE')
 OR has_function_privilege('anon','public.powerhub_financial_gl_monthly_trend(bigint,bigint[],text,integer)','EXECUTE')
 OR has_function_privilege('authenticated','public.powerhub_financial_gl_monthly_trend(bigint,bigint[],text,integer)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.powerhub_financial_gl_monthly_trend(bigint,bigint[],text,integer)','EXECUTE')
 THEN RAISE EXCEPTION 'C_DISPOSABLE_ACL_FAIL';END IF;
 v:=public.powerhub_financial_gl_monthly_comparison(1,1,'2026-10','2026-09');
 IF v->>'status'<>'COMPARABLE_PRELIMINARY'
 OR (v->>'canExport')::boolean IS DISTINCT FROM true
 OR v->>'accountingCertification'<>'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'C_DISPOSABLE_MATCHED_POLICY_FAIL: %',v;END IF;
 old_fingerprint:=v->>'snapshotFingerprint';
 UPDATE public.financial_gl_entries SET source_fingerprint='shaOctModified' WHERE id=2;
 v2:=public.powerhub_financial_gl_monthly_comparison(1,1,'2026-10','2026-09');
 IF v2->>'snapshotFingerprint'=old_fingerprint THEN
 RAISE EXCEPTION 'C_DISPOSABLE_FINGERPRINT_DID_NOT_CHANGE';END IF;
 UPDATE public.financial_gl_entries SET accounting_policy_version='policy-v2' WHERE id=2;
 v:=public.powerhub_financial_gl_monthly_comparison(1,1,'2026-10','2026-09');
 IF v->>'status'<>'BLOCKED'
 OR NOT(v->'blockers'?'RECOGNITION_POLICY_MISMATCH')
 OR (v->>'canExport')::boolean IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'C_DISPOSABLE_POLICY_MISMATCH_FAIL';END IF;
 v:=public.powerhub_financial_gl_monthly_trend(1,ARRAY[1,2]::bigint[],'2026-10',2);
 IF v->>'accountingCertification'<>'NOT_CERTIFIED'
 OR (v->>'siteCount')::integer<>2 OR jsonb_array_length(v->'rows')<>4
 OR v->>'status'<>'PRELIMINARY_GL_TREND_UNVERIFIED_SOURCES'
 THEN RAISE EXCEPTION 'C_DISPOSABLE_TREND_CUBE_FAIL: %',v;END IF;
 SELECT count(*) INTO missing FROM jsonb_array_elements(v->'rows') r
 WHERE (r->>'siteId')::bigint=2 AND r->>'period'='2026-09'
 AND (r->>'hasPostedData')::boolean IS FALSE;
 IF missing<>1 THEN RAISE EXCEPTION 'C_DISPOSABLE_MISSING_PERIOD_SILENT_ZERO';END IF;
 BEGIN
  PERFORM public.powerhub_financial_gl_monthly_trend(1,ARRAY[1,3]::bigint[],'2026-10',2);
  RAISE EXCEPTION 'C_DISPOSABLE_CROSS_TENANT_ACCEPTED';
 EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 BEGIN
  PERFORM public.powerhub_financial_gl_monthly_trend(1,ARRAY[1,1]::bigint[],'2026-10',2);
  RAISE EXCEPTION 'C_DISPOSABLE_DUPLICATE_ACCEPTED';
 EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 BEGIN
  PERFORM public.powerhub_financial_gl_monthly_trend(1,ARRAY[1]::bigint[],'2026-10',13);
  RAISE EXCEPTION 'C_DISPOSABLE_UNBOUNDED_ACCEPTED';
 EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
 UPDATE public.financial_gl_lines SET amount=121 WHERE id=3;
 BEGIN
  PERFORM public.powerhub_financial_gl_monthly_trend(1,ARRAY[1]::bigint[],'2026-10',2);
  RAISE EXCEPTION 'C_DISPOSABLE_UNBALANCED_ACCEPTED';
 EXCEPTION WHEN check_violation THEN NULL;END;
 RAISE NOTICE 'C_GL_DISPOSABLE_SQL_ACL_POLICY_FINGERPRINT_SITE_CUBE_PASS';
END
$checks$;
