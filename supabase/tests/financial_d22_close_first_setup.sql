-- D22 close-first fixture; D21 must have completed on the disposable
-- PostgreSQL 17 database financial_d6_fingerprint_test.
-- New period 2026-03 remains clean until the four-backend race starts.
\set ON_ERROR_STOP on
DO $guard$
BEGIN
 IF current_database() <> 'financial_d6_fingerprint_test'
 OR to_regprocedure('public.powerhub_financial_accrual_detail_fingerprint_v3(bigint,bigint,text)') IS NULL
 OR NOT EXISTS(SELECT 1 FROM public.d2_sources
     WHERE tenant_id=901 AND site_id=9101 AND period='2026-04')
 OR NOT EXISTS(SELECT 1 FROM public.financial_accrual_period_reviews
     WHERE tenant_id=901 AND site_id=9101 AND period='2026-04'
       AND fingerprint_version='financial_v3')
 OR EXISTS(SELECT 1 FROM public.d2_sources WHERE tenant_id=901
     AND site_id=9101 AND period='2026-03')
 THEN RAISE EXCEPTION 'D22_DISPOSABLE_D21_PREREQUISITES_MISSING';END IF;
END $guard$;
INSERT INTO public.d2_sources(tenant_id,site_id,period,revision,blockers)
VALUES(901,9101,'2026-03',0,'{}'::jsonb);
INSERT INTO public.financial_accrual_period_reviews(
 tenant_id,site_id,period,evidence,prepared_by_user_id)
SELECT tenant_id,site_id,'2026-03',evidence,prepared_by_user_id
FROM public.financial_accrual_period_reviews
WHERE tenant_id=901 AND site_id=9101 AND period='2026-09';

DO $proof$
BEGIN
 IF (SELECT status FROM public.financial_accrual_period_reviews
     WHERE tenant_id=901 AND site_id=9101 AND period='2026-03') IS DISTINCT FROM 'draft'
 OR (SELECT fingerprint_version FROM public.financial_accrual_period_reviews
     WHERE tenant_id=901 AND site_id=9101 AND period='2026-03') IS DISTINCT FROM 'financial_v3'
 OR EXISTS(SELECT 1 FROM public.expenses WHERE id IN (89201,89202))
 OR EXISTS(SELECT 1 FROM public.payroll_runs WHERE id=89302)
 OR (SELECT blockers FROM public.d2_sources
     WHERE tenant_id=901 AND site_id=9101 AND period='2026-03') IS DISTINCT FROM '{}'::jsonb
 THEN RAISE EXCEPTION 'D22_MARCH_CLEAN_REVIEW_FIXTURE_INVALID';END IF;
END $proof$;
SELECT 'D22_DISPOSABLE_CLOSE_FIRST_FIXTURE_READY';
