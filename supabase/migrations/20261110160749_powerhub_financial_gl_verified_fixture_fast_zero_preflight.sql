-- A43 verified fixture fast preflight, applied in Staging as 20261110160749.
-- SHA verified at A35 and rechecked once here, with immutable guards ensuring
-- source rows cannot change afterwards. Never substitute an unverified marker.
DO $validate$
BEGIN
 IF EXISTS(SELECT 1 FROM public.financial_gl_staging_technical_exclusions
   WHERE tenant_id=1 AND site_id=1 AND cohort_key='STG-PERF-20261105')
 AND public.powerhub_financial_gl_verify_staging_fixture(1,1)->>'verified' IS DISTINCT FROM 'true'
 THEN RAISE EXCEPTION 'A43_STAGING_FIXTURE_SHA_MISMATCH' USING ERRCODE='23514'; END IF;
END;
$validate$;

CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_fixture_cohort_freeze()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE v_scope boolean:=false;
BEGIN
 IF TG_OP='TRUNCATE' THEN
   IF EXISTS(SELECT 1 FROM public.financial_gl_staging_technical_exclusions
     WHERE tenant_id=1 AND site_id=1 AND cohort_key='STG-PERF-20261105')
   THEN RAISE EXCEPTION 'GL_VERIFIED_FIXTURE_COHORT_IMMUTABLE' USING ERRCODE='23514';END IF;
   RETURN NULL;
 END IF;
 IF TG_OP='INSERT' THEN
   v_scope:=NEW.tenant_id=1 AND NEW.site_id=1 AND NEW.reference_no LIKE 'STG-PERF-%';
 ELSIF TG_OP='UPDATE' THEN
   v_scope:=(OLD.tenant_id=1 AND OLD.site_id=1 AND OLD.reference_no LIKE 'STG-PERF-%')
     OR (NEW.tenant_id=1 AND NEW.site_id=1 AND NEW.reference_no LIKE 'STG-PERF-%');
 ELSE
   v_scope:=OLD.tenant_id=1 AND OLD.site_id=1 AND OLD.reference_no LIKE 'STG-PERF-%';
 END IF;
 IF v_scope AND EXISTS(SELECT 1 FROM public.financial_gl_staging_technical_exclusions
   WHERE tenant_id=1 AND site_id=1 AND cohort_key='STG-PERF-20261105'
     AND row_count=250000
     AND sha256='f1b25e8562328a0f6e916beb4d54b2ee88366e78b4459c5d0ebc444616997df9')
 THEN RAISE EXCEPTION 'GL_VERIFIED_FIXTURE_COHORT_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$function$
;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_fixture_cohort_freeze()
 FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER powerhub_financial_gl_fixture_freeze_write
 BEFORE INSERT OR UPDATE OR DELETE ON public.account_transactions
 FOR EACH ROW EXECUTE FUNCTION public.powerhub_financial_gl_fixture_cohort_freeze();
CREATE TRIGGER powerhub_financial_gl_fixture_freeze_truncate
 BEFORE TRUNCATE ON public.account_transactions
 FOR EACH STATEMENT EXECUTE FUNCTION public.powerhub_financial_gl_fixture_cohort_freeze();
CREATE INDEX account_transactions_nonfixture_opening_idx
 ON public.account_transactions(tenant_id,site_id,occurred_at)
 WHERE (reference_no IS NULL OR reference_no NOT LIKE 'STG-PERF-%');

CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_zero_opening_preflight(p_tenant_id bigint, p_site_id bigint, p_as_of_date date)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE v_fixture boolean:=false;v_cutoff timestamptz;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0 OR p_site_id IS NULL OR p_site_id<=0
  OR p_as_of_date IS NULL OR p_as_of_date>current_date
  OR NOT EXISTS(SELECT 1 FROM public.sites WHERE tenant_id=p_tenant_id AND id=p_site_id AND status<>'archived')
 THEN RETURN false;END IF;
 v_cutoff:=(p_as_of_date+1)::timestamp AT TIME ZONE 'Asia/Gaza';
 IF p_tenant_id=1 AND p_site_id=1 THEN
  SELECT EXISTS(SELECT 1 FROM public.financial_gl_staging_technical_exclusions x
    WHERE x.tenant_id=1 AND x.site_id=1 AND x.cohort_key='STG-PERF-20261105'
    AND x.row_count=250000 AND x.sha256='f1b25e8562328a0f6e916beb4d54b2ee88366e78b4459c5d0ebc444616997df9')
  INTO v_fixture;
 END IF;
 IF v_fixture THEN
   IF EXISTS(SELECT 1 FROM public.account_transactions t
     WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id
       AND t.occurred_at<v_cutoff
       AND (t.reference_no IS NULL OR t.reference_no NOT LIKE 'STG-PERF-%'))
   THEN RETURN false; END IF;
 ELSE
   IF EXISTS(SELECT 1 FROM public.account_transactions t
     WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id
       AND t.occurred_at<v_cutoff)
   THEN RETURN false; END IF;
 END IF;
 RETURN NOT EXISTS(SELECT 1 FROM public.company_accounts t
  WHERE t.tenant_id=p_tenant_id AND t.created_at<v_cutoff AND t.opening_balance<>0)

 AND NOT EXISTS(SELECT 1 FROM public.invoices t WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id AND t.issue_date<=p_as_of_date)
 AND NOT EXISTS(SELECT 1 FROM public.payments t WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id AND t.paid_at<v_cutoff)
 AND NOT EXISTS(SELECT 1 FROM public.expenses t WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id AND t.occurred_at<v_cutoff)
 AND NOT EXISTS(SELECT 1 FROM public.inventory_stock_movements t WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id AND t.occurred_at<v_cutoff)
 AND NOT EXISTS(SELECT 1 FROM public.supplier_ledger_entries t WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id AND t.occurred_at<v_cutoff)
 AND NOT EXISTS(SELECT 1 FROM public.supplier_purchases t WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id AND t.invoice_date<=p_as_of_date)
 AND NOT EXISTS(SELECT 1 FROM public.payroll_runs t WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id AND t.period<=to_char(p_as_of_date,'YYYY-MM'))
 AND NOT EXISTS(SELECT 1 FROM public.financial_accrual_journals t WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id AND t.period<=to_char(p_as_of_date,'YYYY-MM'))
 AND NOT EXISTS(SELECT 1 FROM public.employee_adjustments t WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id AND t.disbursed_at<v_cutoff)
 AND NOT EXISTS(SELECT 1 FROM public.financial_gl_entries t WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id AND t.period<=to_char(p_as_of_date,'YYYY-MM'));
END;$function$
;
