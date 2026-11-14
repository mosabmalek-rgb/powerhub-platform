-- D3 source-write close protection test. Disposable PostgreSQL only.
\set ON_ERROR_STOP on
\ir financial_d2_close_setup.sql

CREATE TABLE public.expenses(
 id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint NOT NULL,
 category text NOT NULL,description text NOT NULL,amount numeric NOT NULL,
 occurred_at timestamptz NOT NULL,expense_classification text NOT NULL,
 company_account_id bigint,reference_no text
);
CREATE TABLE public.invoices(
 id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint NOT NULL,
 subscriber_id bigint NOT NULL,cycle_key text NOT NULL,
 cycle_start_at timestamptz,cycle_end_at timestamptz,issue_date timestamptz NOT NULL,
 total_amount numeric,tax_amount numeric,discount_amount numeric,fixed_fee numeric,
 price_per_kwh numeric,consumption_kwh numeric,status text NOT NULL,
 paid_amount numeric DEFAULT 0,description text
);
\ir ../migrations/20261114120000_powerhub_financial_d3_source_period_guard.sql

DO $security$
BEGIN
 IF to_regprocedure('public.powerhub_financial_accrual_guard_source_write()') IS NULL
 OR has_function_privilege('anon','public.powerhub_financial_accrual_guard_source_write()','EXECUTE')
 OR has_function_privilege('authenticated','public.powerhub_financial_accrual_guard_source_write()','EXECUTE')
 OR NOT has_function_privilege('service_role','public.powerhub_financial_accrual_guard_source_write()','EXECUTE')
 OR (SELECT count(*) FROM pg_trigger
     WHERE tgname IN('d3_accrual_invoice_source_guard','d3_accrual_expense_source_guard')
       AND NOT tgisinternal AND tgenabled='O')<>2
 THEN RAISE EXCEPTION 'D3_GUARD_ACL_OR_TRIGGER_NOT_INSTALLED'; END IF;
END $security$;

-- Financial updates in unclosed months must remain available.
INSERT INTO public.expenses VALUES
 (101,901,9101,'maintenance','Open July expense',3.25,'2026-07-16 10:00:00+03',
 'operating',NULL,'D3-JULY');
INSERT INTO public.invoices(id,tenant_id,site_id,subscriber_id,cycle_key,
 cycle_start_at,cycle_end_at,issue_date,total_amount,tax_amount,discount_amount,
 fixed_fee,price_per_kwh,consumption_kwh,status,paid_amount)
VALUES
 (201,901,9101,100,'2026-07','2026-07-01 00:00+03','2026-07-31 23:00+03',
  '2026-07-31 12:00+03',100,0,0,0,1,100,'issued',0),
 (202,901,9101,100,'2026-06','2026-06-01 00:00+03','2026-06-30 23:00+03',
  '2026-07-01 12:00+03',25,0,0,0,1,25,'draft',0);
UPDATE public.expenses SET amount=4.25 WHERE id=101;
UPDATE public.invoices SET paid_amount=1 WHERE id=201;

-- All these dates refer to a completed month. June has an actual C4 review.
SELECT public.powerhub_financial_accrual_period_lock(901,9101,'2026-06',9902);
DO $negative$
DECLARE rejected boolean; rec public.expenses%ROWTYPE;
BEGIN
 rejected:=false;
 BEGIN
  INSERT INTO public.expenses VALUES
  (102,901,9101,'maintenance','Should not enter closed June',1.23,
   '2026-06-16 12:00:00+03','operating',NULL,'D3-CLOSED');
 EXCEPTION WHEN OTHERS THEN
  rejected:=SQLERRM LIKE '%D3_ACCRUAL_SOURCE_PERIOD_LOCKED%';
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'D3_CLOSED_EXPENSE_INSERT_ALLOWED';END IF;

 rejected:=false;
 BEGIN
  UPDATE public.expenses SET occurred_at='2026-06-15 12:00:00+03' WHERE id=101;
 EXCEPTION WHEN OTHERS THEN
  rejected:=SQLERRM LIKE '%D3_ACCRUAL_SOURCE_PERIOD_LOCKED%';
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'D3_OLD_NEW_EXPENSE_MONTH_MOVE_ALLOWED';END IF;
 IF (SELECT amount FROM public.expenses WHERE id=101)<>4.25 THEN
  RAISE EXCEPTION 'D3_EXPENSE_PARTIAL_MUTATION';END IF;

 rejected:=false;
 BEGIN
  UPDATE public.invoices SET status='issued' WHERE id=202;
 EXCEPTION WHEN OTHERS THEN
  rejected:=SQLERRM LIKE '%D3_ACCRUAL_SOURCE_PERIOD_LOCKED%';
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'D3_DRAFT_TO_RECOGNIZED_INVOICE_ALLOWED';END IF;

 rejected:=false;
 BEGIN
  INSERT INTO public.invoices(id,tenant_id,site_id,subscriber_id,cycle_key,
    cycle_start_at,cycle_end_at,issue_date,total_amount,tax_amount,discount_amount,
    fixed_fee,price_per_kwh,consumption_kwh,status)
  VALUES(203,901,9101,100,'2026-06','2026-06-01 00:00+03',
    '2026-06-30 23:00+03','2026-07-01 12:00+03',20,0,0,0,1,20,'issued');
 EXCEPTION WHEN OTHERS THEN
  rejected:=SQLERRM LIKE '%D3_ACCRUAL_SOURCE_PERIOD_LOCKED%';
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'D3_ISSUED_CLOSED_CYCLE_ALLOWED';END IF;

 -- The invoice's settlement progress is independent of service recognition.
 UPDATE public.invoices SET paid_amount=5 WHERE id=201;
 IF (SELECT paid_amount FROM public.invoices WHERE id=201)<>5 THEN
   RAISE EXCEPTION 'D3_UNRELATED_COLLECTION_PROGRESS_BLOCKED';END IF;
 IF (SELECT count(*) FROM public.financial_accrual_period_reviews
     WHERE tenant_id=901 AND site_id=9101 AND period='2026-06' AND status='locked')<>1
 THEN RAISE EXCEPTION 'D3_LOCK_CHANGED';END IF;
END $negative$;

-- New May review for independent source vs C4 close race in the shell script.
INSERT INTO public.d2_sources (tenant_id,site_id,period)
VALUES(901,9101,'2026-05');
INSERT INTO public.financial_accrual_period_reviews(
 tenant_id,site_id,period,evidence,prepared_by_user_id)
SELECT tenant_id,site_id,'2026-05',evidence,prepared_by_user_id
FROM public.financial_accrual_period_reviews WHERE period='2026-09';

-- The separate source-aggregator fixture now sees a May expense as invalid
-- and blocks C4 if that expense wins the period lock first. This only models
-- source-aware C4 rejection, not all real operational-source writers.
CREATE FUNCTION public.d3_test_mark_source_change() RETURNS trigger
LANGUAGE plpgsql AS $fixture$
BEGIN
 IF NEW.tenant_id=901 AND NEW.site_id=9101 AND
    to_char((NEW.occurred_at AT TIME ZONE 'Asia/Gaza')::date,'YYYY-MM')='2026-05' THEN
   UPDATE public.d2_sources SET blockers='{"invalidExpenseCount":1}'::jsonb
   WHERE tenant_id=901 AND site_id=9101 AND period='2026-05';
 END IF;
 RETURN NEW;
END $fixture$;
CREATE TRIGGER d3_test_mark_source_after_insert
AFTER INSERT ON public.expenses FOR EACH ROW
EXECUTE FUNCTION public.d3_test_mark_source_change();

SELECT 'D3_SOURCE_GUARD_DIRECT_ACL_AND_CLOSED_PERIOD_PASS' AS result;
