-- Phase D4 isolated PostgreSQL 17 acceptance: real D3+C4 and D4 guards.
-- No Staging/Production writes.
\set ON_ERROR_STOP on
\ir financial_d3_source_guard_setup.sql

CREATE TABLE public.payroll_runs(
 id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint,
 period text NOT NULL,status text NOT NULL,
 total_gross numeric NOT NULL,total_deductions numeric NOT NULL,total_net numeric NOT NULL,
 paid_from_account_id bigint,approved_by_user_id bigint,paid_at timestamptz,
 created_by_user_id bigint NOT NULL, created_at timestamptz DEFAULT now(),
 updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.payroll_items(
 id bigint PRIMARY KEY,payroll_run_id bigint NOT NULL,employee_id bigint NOT NULL,
 base_amount numeric NOT NULL,extra_amount numeric NOT NULL,
 advance_deduction numeric NOT NULL,other_deduction numeric NOT NULL,
 net_amount numeric NOT NULL,notes text
);
CREATE TABLE public.supplier_purchases(
 id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint NOT NULL,
 supplier_id bigint NOT NULL,warehouse_id bigint NOT NULL,
 invoice_date date NOT NULL,status text NOT NULL,
 subtotal_amount numeric NOT NULL, discount_amount numeric NOT NULL,
 tax_amount numeric NOT NULL, other_charges_amount numeric NOT NULL,
 total_amount numeric, payment_mode text NOT NULL,
 received_at timestamptz,confirmed_at timestamptz,cancelled_at timestamptz,
 supplier_invoice_no text,notes text
);
CREATE TABLE public.inventory_stock_movements(
 id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint NOT NULL,
 item_id bigint NOT NULL,warehouse_id bigint NOT NULL,generator_id bigint,
 movement_type text NOT NULL,quantity numeric NOT NULL,
 unit_cost numeric NOT NULL,total_cost_amount numeric NOT NULL,
 occurred_at timestamptz NOT NULL,reversal_of_movement_id bigint,
 corrects_movement_id bigint,source_issue_movement_id bigint,
 purchase_id bigint,purchase_line_id bigint,operation_key text NOT NULL,notes text
);

-- Historical test rows before D4 triggers: mirrors already-existing source rows.
INSERT INTO public.inventory_stock_movements
 (id,tenant_id,site_id,item_id,warehouse_id,movement_type,quantity,
 unit_cost,total_cost_amount,occurred_at,operation_key)
VALUES(601,901,9101,7,2,'issue',2,4,8,'2026-06-10 12:00+03','D4-JUN-ISSUE');
INSERT INTO public.payroll_runs
 (id,tenant_id,site_id,period,status,total_gross,total_deductions,total_net,
 created_by_user_id)
VALUES
 (301,901,9101,'2026-06','approved',100,20,80,9901),
 (302,901,9101,'2026-07','draft',100,20,80,9901),
 (303,901,NULL,'2026-06','approved',50,10,40,9901);
INSERT INTO public.payroll_items
 (id,payroll_run_id,employee_id,base_amount,extra_amount,
 advance_deduction,other_deduction,net_amount,notes)
VALUES
 (401,301,200,100,0,10,10,80,'existing June item'),
 (402,302,201,100,0,10,10,80,'existing July item');
INSERT INTO public.supplier_purchases
 (id,tenant_id,site_id,supplier_id,warehouse_id,invoice_date,status,
 subtotal_amount,discount_amount,tax_amount,other_charges_amount,
 total_amount,payment_mode)
VALUES(501,901,9101,25,2,'2026-06-15','confirmed',100,0,0,0,100,'credit');

\ir ../migrations/20261114130000_powerhub_financial_d4_operational_source_period_guard.sql

DO $checks$
DECLARE rejected boolean; label text; observed bigint;
BEGIN
 IF (SELECT count(*) FROM pg_trigger
    WHERE NOT tgisinternal AND tgenabled='O'
      AND tgname IN('d4_accrual_payroll_runs_guard',
      'd4_accrual_payroll_items_guard',
      'd4_accrual_supplier_purchases_guard',
      'd4_accrual_inventory_movements_guard'))<>4
 OR has_function_privilege('anon','public.powerhub_financial_accrual_guard_d4_sources()','EXECUTE')
 OR has_function_privilege('authenticated','public.powerhub_financial_accrual_guard_d4_sources()','EXECUTE')
 OR NOT has_function_privilege('service_role','public.powerhub_financial_accrual_guard_d4_sources()','EXECUTE')
 THEN RAISE EXCEPTION 'D4_GUARD_INSTALL_OR_ACL_FAILURE';END IF;

 -- July is open and should stay writable. Pure notes updates must not be blocked.
 INSERT INTO public.payroll_runs
 (id,tenant_id,site_id,period,status,total_gross,total_deductions,total_net,
 created_by_user_id)
 VALUES(304,901,9101,'2026-07','draft',80,10,70,9901);
 UPDATE public.payroll_runs SET total_net=75 WHERE id=304;
 UPDATE public.payroll_runs SET updated_at=now() WHERE id=301;
 UPDATE public.payroll_items SET notes='description only' WHERE id=401;
 UPDATE public.supplier_purchases SET notes='description only' WHERE id=501;
 UPDATE public.inventory_stock_movements SET notes='description only' WHERE id=601;

 rejected:=false;
 BEGIN
  UPDATE public.payroll_runs SET total_gross=120 WHERE id=301;
 EXCEPTION WHEN OTHERS THEN
  rejected:=SQLERRM LIKE '%D4_ACCRUAL_SOURCE_PERIOD_LOCKED%';END;
 IF NOT rejected THEN RAISE EXCEPTION 'D4_LOCKED_PAYROLL_UPDATE_ALLOWED';END IF;
 rejected:=false;
 BEGIN
  INSERT INTO public.payroll_runs
    (id,tenant_id,site_id,period,status,total_gross,total_deductions,total_net,
     created_by_user_id)
  VALUES(305,901,9101,'2026-06','approved',80,0,80,9901);
 EXCEPTION WHEN OTHERS THEN
  rejected:=SQLERRM LIKE '%D4_ACCRUAL_SOURCE_PERIOD_LOCKED%';END;
 IF NOT rejected THEN RAISE EXCEPTION 'D4_LOCKED_PAYROLL_INSERT_ALLOWED';END IF;

 rejected:=false;
 BEGIN
  UPDATE public.payroll_items SET net_amount=90 WHERE id=401;
 EXCEPTION WHEN OTHERS THEN
  rejected:=SQLERRM LIKE '%D4_ACCRUAL_SOURCE_PERIOD_LOCKED%';END;
 IF NOT rejected THEN RAISE EXCEPTION 'D4_LOCKED_PAYROLL_ITEM_EDIT_ALLOWED';END IF;
 rejected:=false;
 BEGIN
  UPDATE public.payroll_items SET payroll_run_id=301 WHERE id=402;
 EXCEPTION WHEN OTHERS THEN
  rejected:=SQLERRM LIKE '%D4_ACCRUAL_SOURCE_PERIOD_LOCKED%';END;
 IF NOT rejected THEN RAISE EXCEPTION 'D4_PAYROLL_ITEM_MOVE_TO_CLOSED_RUN_ALLOWED';END IF;

 rejected:=false;
 BEGIN
  UPDATE public.supplier_purchases SET total_amount=101 WHERE id=501;
 EXCEPTION WHEN OTHERS THEN
  rejected:=SQLERRM LIKE '%D4_ACCRUAL_SOURCE_PERIOD_LOCKED%';END;
 IF NOT rejected THEN RAISE EXCEPTION 'D4_LOCKED_PURCHASE_EDIT_ALLOWED';END IF;
 rejected:=false;
 BEGIN
  INSERT INTO public.supplier_purchases
   (id,tenant_id,site_id,supplier_id,warehouse_id,invoice_date,status,
    subtotal_amount,discount_amount,tax_amount,other_charges_amount,
    total_amount,payment_mode)
  VALUES(502,901,9101,25,2,'2026-06-15','confirmed',100,0,0,0,100,'credit');
 EXCEPTION WHEN OTHERS THEN
  rejected:=SQLERRM LIKE '%D4_ACCRUAL_SOURCE_PERIOD_LOCKED%';END;
 IF NOT rejected THEN RAISE EXCEPTION 'D4_LOCKED_PURCHASE_INSERT_ALLOWED';END IF;

 rejected:=false;
 BEGIN
  UPDATE public.inventory_stock_movements SET total_cost_amount=10 WHERE id=601;
 EXCEPTION WHEN OTHERS THEN
  rejected:=SQLERRM LIKE '%D4_ACCRUAL_SOURCE_PERIOD_LOCKED%';END;
 IF NOT rejected THEN RAISE EXCEPTION 'D4_LOCKED_STOCK_EDIT_ALLOWED';END IF;
 rejected:=false;
 BEGIN
  INSERT INTO public.inventory_stock_movements
   (id,tenant_id,site_id,item_id,warehouse_id,movement_type,
    quantity,unit_cost,total_cost_amount,occurred_at,
    reversal_of_movement_id,operation_key)
  VALUES(602,901,9101,7,2,'reversal',2,4,8,
    '2026-07-15 12:00+03',601,'D4-CLOSED-JUNE-REVERSAL');
 EXCEPTION WHEN OTHERS THEN
  rejected:=SQLERRM LIKE '%D4_ACCRUAL_SOURCE_PERIOD_LOCKED%';END;
 IF NOT rejected THEN RAISE EXCEPTION 'D4_HISTORICAL_STOCK_REVERSAL_ALLOWED';END IF;
 rejected:=false;
 BEGIN
  INSERT INTO public.inventory_stock_movements
   (id,tenant_id,site_id,item_id,warehouse_id,movement_type,
    quantity,unit_cost,total_cost_amount,occurred_at,
    source_issue_movement_id,operation_key)
  VALUES(603,901,9101,7,2,'return_from_issue',2,4,8,
    '2026-07-15 12:00+03',601,'D4-CLOSED-JUNE-RETURN');
 EXCEPTION WHEN OTHERS THEN
  rejected:=SQLERRM LIKE '%D4_ACCRUAL_SOURCE_PERIOD_LOCKED%';END;
 IF NOT rejected THEN RAISE EXCEPTION 'D4_HISTORICAL_RETURN_FROM_ISSUE_ALLOWED';END IF;

 rejected:=false;
 BEGIN
  INSERT INTO public.inventory_stock_movements
   (id,tenant_id,site_id,item_id,warehouse_id,movement_type,
    quantity,unit_cost,total_cost_amount,occurred_at,
    reversal_of_movement_id,operation_key)
  VALUES(604,901,9101,7,2,'reversal',2,4,8,
    '2026-07-15 12:00+03',999999,'D4-MISSING-SOURCE-REF');
 EXCEPTION WHEN OTHERS THEN
  rejected:=SQLERRM LIKE '%D4_INVALID_CROSS_SCOPE_MOVEMENT_REFERENCE%';END;
 IF NOT rejected THEN RAISE EXCEPTION 'D4_UNVERIFIED_STOCK_SOURCE_ACCEPTED';END IF;

 IF (SELECT status FROM public.financial_accrual_period_reviews
    WHERE tenant_id=901 AND site_id=9101 AND period='2026-06')<>'locked'
 THEN RAISE EXCEPTION 'D4_DAMAGED_JUNE_LOCK';END IF;
 RAISE NOTICE 'D4_PAYROLL_PURCHASE_STOCK_CLOSED_MONTH_AND_REF_GUARDS_PASS';
END $checks$;

-- May can still be closed; an AFTER INSERT fixture marks the C4 source dirty
-- only when a guarded May payroll insert gets the period lock first.
INSERT INTO public.payroll_runs
 (id,tenant_id,site_id,period,status,total_gross,total_deductions,total_net,
 created_by_user_id)
VALUES (306,901,9101,'2026-07','draft',75,5,70,9901);

CREATE OR REPLACE FUNCTION public.d4_fixture_mark_payroll_dirty()
RETURNS trigger LANGUAGE plpgsql AS $fixture$
BEGIN
 IF NEW.tenant_id=901 AND NEW.site_id=9101 AND NEW.period='2026-05' THEN
  UPDATE public.d2_sources
  SET blockers='{"invalidPayrollCount":1}'::jsonb
  WHERE tenant_id=901 AND site_id=9101 AND period='2026-05';
 END IF;
 RETURN NEW;
END $fixture$;
CREATE TRIGGER d4_fixture_mark_payroll_dirty
AFTER INSERT ON public.payroll_runs
FOR EACH ROW EXECUTE FUNCTION public.d4_fixture_mark_payroll_dirty();
SELECT 'D4_ISOLATED_DIRECT_SOURCE_GUARDS_PASS' result;
