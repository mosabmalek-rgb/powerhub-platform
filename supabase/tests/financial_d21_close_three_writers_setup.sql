-- D21 fixtures ONLY in the disposable financial_d6_fingerprint_test database.
-- Uses actual installed D3/D4 source-write triggers + actual C4/D6 close logic;
-- only the source statement aggregator is synthetic (same D2 fixture as older races).
\set ON_ERROR_STOP on
DO $guard$
BEGIN
 IF current_database()<>'financial_d6_fingerprint_test'
 OR to_regprocedure('public.powerhub_financial_accrual_detail_fingerprint_v3(bigint,bigint,text)') IS NULL
 OR to_regclass('public.d2_sources') IS NULL
 OR EXISTS(SELECT 1 FROM public.financial_accrual_period_reviews
           WHERE tenant_id=901 AND site_id=9101 AND period='2026-04')
 THEN RAISE EXCEPTION 'D21_NOT_DISPOSABLE_D6_READY';END IF;
END $guard$;

INSERT INTO public.d2_sources(tenant_id,site_id,period,revision,blockers)
VALUES(901,9101,'2026-04',0,'{}'::jsonb);

INSERT INTO public.financial_accrual_period_reviews(
 tenant_id,site_id,period,evidence,prepared_by_user_id)
SELECT tenant_id,site_id,'2026-04',evidence,prepared_by_user_id
FROM public.financial_accrual_period_reviews
WHERE tenant_id=901 AND site_id=9101 AND period='2026-09';

CREATE FUNCTION public.d21_mark_april_source_change()
RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE v_kind text;
BEGIN
 -- PostgreSQL does not guarantee PL/pgSQL boolean short-circuiting.
 -- Access only columns belonging to the trigger's actual source table.
 IF TG_TABLE_NAME='expenses' THEN
   IF NEW.tenant_id<>901 OR NEW.site_id<>9101 OR
      to_char(NEW.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM')<>'2026-04'
   THEN RETURN NEW; END IF;
   v_kind:='invalidExpenseCount';
 ELSIF TG_TABLE_NAME='payroll_runs' THEN
   IF NEW.tenant_id<>901 OR NEW.site_id<>9101 OR NEW.period<>'2026-04'
   THEN RETURN NEW; END IF;
   v_kind:='invalidPayrollCount';
 ELSE
   RAISE EXCEPTION 'D21_UNEXPECTED_TRIGGER_TABLE_%',TG_TABLE_NAME;
 END IF;
 IF v_kind IS NOT NULL THEN
   UPDATE public.d2_sources
   SET blockers=blockers||jsonb_build_object(v_kind,1),revision=revision+1
   WHERE tenant_id=901 AND site_id=9101 AND period='2026-04';
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.d21_mark_april_source_change() FROM PUBLIC,anon,authenticated;

CREATE TRIGGER d21_aggregate_april_expense
AFTER INSERT ON public.expenses FOR EACH ROW
EXECUTE FUNCTION public.d21_mark_april_source_change();
CREATE TRIGGER d21_aggregate_april_payroll
AFTER INSERT ON public.payroll_runs FOR EACH ROW
EXECUTE FUNCTION public.d21_mark_april_source_change();

DO $checks$
DECLARE v jsonb;
BEGIN
 SELECT public.powerhub_financial_accrual_period_review_status(901,9101,'2026-04') INTO v;
 IF v->>'status' IS DISTINCT FROM 'draft'
 OR (SELECT fingerprint_version FROM public.financial_accrual_period_reviews
     WHERE tenant_id=901 AND site_id=9101 AND period='2026-04')<>'financial_v3'
 OR (SELECT count(*) FROM public.expenses WHERE id IN(89101,89102))<>0
 OR (SELECT count(*) FROM public.payroll_runs WHERE id=89301)<>0
 OR (SELECT count(*) FROM pg_trigger
     WHERE NOT tgisinternal AND tgenabled='O'
     AND tgname IN('d21_aggregate_april_expense','d21_aggregate_april_payroll'))<>2
 THEN RAISE EXCEPTION 'D21_SOURCE_AGGREGATOR_FIXTURE_INVALID';END IF;
END $checks$;
SELECT 'D21_DISPOSABLE_THREE_SOURCE_WRITERS_V3_CLOSE_READY' AS fixture;
