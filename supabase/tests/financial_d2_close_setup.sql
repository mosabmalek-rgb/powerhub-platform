-- D2 isolated source aggregator fixture. ACTUAL C4 lock, journal functions, trigger from production migrations.
-- No Staging/Production changes. The stub source aggregate is not proof of production-source writer coverage.
-- D2: disposable PostgreSQL only; never run against Staging/Production.
-- Minimal source fixture + the ACTUAL C4 migration as the tested lock writer.
\set ON_ERROR_STOP on
DO $roles$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $roles$;
CREATE TABLE public.tenants(id bigint PRIMARY KEY);
CREATE TABLE public.users(id bigint PRIMARY KEY);
CREATE TABLE public.sites(id bigint PRIMARY KEY, tenant_id bigint NOT NULL REFERENCES public.tenants(id), status text NOT NULL);
INSERT INTO public.tenants VALUES (901),(902);
INSERT INTO public.users VALUES (9901),(9902),(9903);
INSERT INTO public.sites VALUES (9101,901,'active'),(9201,902,'active');

\ir ../migrations/20261109190000_powerhub_financial_accrual_adjustment_journal.sql
\ir ../migrations/20261110001000_powerhub_financial_accrual_journal_serialization.sql
CREATE TABLE public.financial_accrual_period_reviews(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tenant_id bigint NOT NULL REFERENCES public.tenants(id),
 site_id bigint NOT NULL REFERENCES public.sites(id),
 period text NOT NULL,
 evidence jsonb NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','locked')),
 prepared_by_user_id bigint NOT NULL REFERENCES public.users(id),
 locked_by_user_id bigint REFERENCES public.users(id),
 prepared_at timestamptz NOT NULL DEFAULT now(),
 locked_at timestamptz,
 locked_snapshot jsonb,
 source_fingerprint text,
 CONSTRAINT d2_review_unique UNIQUE(tenant_id,site_id,period)
);
CREATE TABLE public.d2_sources (
 tenant_id bigint NOT NULL, site_id bigint NOT NULL, period text NOT NULL,
 revision integer NOT NULL DEFAULT 0,
 blockers jsonb NOT NULL DEFAULT '{}'::jsonb,
 PRIMARY KEY(tenant_id,site_id,period)
);
INSERT INTO public.d2_sources(tenant_id,site_id,period) VALUES (901,9101,'2026-09'),(901,9101,'2026-08'),(901,9101,'2026-10'),(901,9101,'2026-07'),(901,9101,'2026-06');

-- This minimal fixture does NOT claim production source-writer coverage.
-- The lock RPC itself is loaded from the exact versioned production migration.
CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_review_evidence_valid(p jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $f$
SELECT p IS NOT NULL AND jsonb_typeof(p)='object' AND
 (SELECT count(*)=8 FROM jsonb_each_text(p) AS kv(k,v)
  WHERE k IN ('unbilled_service','invoice_cutoff','supplier_reconciliation',
    'inventory_reconciliation','payroll_reconciliation','depreciation_register',
    'provision_assessment','tax_reconciliation') AND length(trim(v))>=8);
$f$;
CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_month_statement(
 p_tenant_id bigint,p_site_id bigint,p_period text,p_as_of timestamptz
) RETURNS jsonb LANGUAGE sql STABLE AS $f$
SELECT jsonb_build_object(
 'scopeTenantId',p_tenant_id,'scopeSiteId',p_site_id,'period',p_period,
 'asOf',p_as_of,'isFinalProfit',false,'isCompleteAccrualStatement',false,
 'syntheticRevision',s.revision,
 'missingCycleCount',0,'uncompletedInvoiceCount',0,
 'unclassifiedInventoryIssueCount',0,'draftPayrollCount',0,
 'unreconciledPayrollPayoutCount',0,'invalidInvoiceCount',0,
 'invalidExpenseCount',0,'invalidPayrollCount',0,'invalidInventoryCount',0,
 'crossPeriodInvoiceCount',0,'issuedOutsideServiceMonthCount',0,
 'journalAdjustments',jsonb_build_object(
   'draftCount',(SELECT count(*) FROM public.financial_accrual_journals j WHERE j.tenant_id=p_tenant_id AND j.site_id=p_site_id AND j.period=p_period AND j.status='draft'),
   'postedCount',(SELECT count(*) FROM public.financial_accrual_journals j WHERE j.tenant_id=p_tenant_id AND j.site_id=p_site_id AND j.period=p_period AND j.status='posted'),
   'balancedDebits',0,'balancedCredits',0)
) || s.blockers
FROM public.d2_sources s WHERE s.tenant_id=p_tenant_id
AND s.site_id=p_site_id AND s.period=p_period;
$f$;
CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_detail_fingerprint(
 p_tenant_id bigint,p_site_id bigint,p_period text
) RETURNS text LANGUAGE sql STABLE AS $f$
SELECT 'synthetic-revision-'||s.revision::text FROM public.d2_sources s
 WHERE s.tenant_id=p_tenant_id AND s.site_id=p_site_id AND s.period=p_period;
$f$;

\ir ../migrations/20261113203000_powerhub_financial_c4_period_close_integrity_guard.sql
CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_no_locked_journal_change()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $guard$
DECLARE v_closed boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(
   'powerhub:accrual-period:'||NEW.tenant_id||':'||NEW.site_id||':'||NEW.period,0));
 SELECT EXISTS(SELECT 1 FROM public.financial_accrual_period_reviews r
   WHERE r.tenant_id=NEW.tenant_id AND r.site_id=NEW.site_id
    AND r.period=NEW.period AND r.status='locked') INTO v_closed;
 IF v_closed THEN RAISE EXCEPTION 'ACCRUAL_PERIOD_LOCKED' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END;
$guard$;

DROP TRIGGER IF EXISTS financial_accrual_block_locked_journal_changes ON public.financial_accrual_journals;
CREATE TRIGGER financial_accrual_block_locked_journal_changes
BEFORE INSERT OR UPDATE ON public.financial_accrual_journals
FOR EACH ROW EXECUTE FUNCTION public.powerhub_financial_accrual_no_locked_journal_change();


-- Same exact review-status function body as 20261110003000 source-fingerprint migration.
CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_period_review_status(
 p_tenant_id bigint,p_site_id bigint,p_period text
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $status$
DECLARE
 v_review public.financial_accrual_period_reviews%ROWTYPE;
 v_current jsonb; v_changed boolean;
BEGIN
 SELECT * INTO v_review FROM public.financial_accrual_period_reviews
 WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND period=p_period;
 IF NOT FOUND THEN
  RETURN jsonb_build_object('status','unprepared','isCertifiedProfit',false);
 END IF;
 IF v_review.status='draft' THEN
  RETURN jsonb_build_object('status','draft','evidence',v_review.evidence,
    'preparedByUserId',v_review.prepared_by_user_id,'isCertifiedProfit',false);
 END IF;
 v_current:=public.powerhub_financial_accrual_month_statement(
  p_tenant_id,p_site_id,p_period,now()
 );
 v_changed:=md5((v_current-'asOf')::text || ':' ||
    public.powerhub_financial_accrual_detail_fingerprint(p_tenant_id,p_site_id,p_period))
    <>v_review.source_fingerprint;
 RETURN jsonb_build_object('status','locked','driftDetected',v_changed,
   'lockedByUserId',v_review.locked_by_user_id,'lockedAt',v_review.locked_at,
   'sourceFingerprint',v_review.source_fingerprint,
   'isCertifiedProfit',false,'lockedSnapshot',v_review.locked_snapshot);
END;
$status$;
-- Source-integrity negative fixture in a DIFFERENT completed month.
UPDATE public.d2_sources SET blockers='{"invalidInvoiceCount":1}'::jsonb
 WHERE tenant_id=901 AND site_id=9101 AND period='2026-08';
INSERT INTO public.financial_accrual_period_reviews(
 tenant_id,site_id,period,evidence,prepared_by_user_id
) VALUES (
 901,9101,'2026-09',jsonb_build_object(
 'unbilled_service','fixture-reference-01',
 'invoice_cutoff','fixture-reference-02',
 'supplier_reconciliation','fixture-reference-03',
 'inventory_reconciliation','fixture-reference-04',
 'payroll_reconciliation','fixture-reference-05',
 'depreciation_register','fixture-reference-06',
 'provision_assessment','fixture-reference-07',
 'tax_reconciliation','fixture-reference-08'),9901
);
INSERT INTO public.financial_accrual_period_reviews(
 tenant_id,site_id,period,evidence,prepared_by_user_id
)
SELECT tenant_id,site_id,period_name,evidence,prepared_by_user_id
FROM public.financial_accrual_period_reviews CROSS JOIN
 (VALUES ('2026-08'),('2026-10'),('2026-06')) AS months(period_name)
WHERE period='2026-09';

DO $checks$
BEGIN
 IF has_function_privilege('anon','public.powerhub_financial_accrual_period_lock(bigint,bigint,text,bigint)','EXECUTE')
 OR has_function_privilege('authenticated','public.powerhub_financial_accrual_period_lock(bigint,bigint,text,bigint)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.powerhub_financial_accrual_period_lock(bigint,bigint,text,bigint)','EXECUTE')
 THEN RAISE EXCEPTION 'D2_FUNCTION_ACL_NOT_SERVER_ONLY'; END IF;
END;$checks$;
