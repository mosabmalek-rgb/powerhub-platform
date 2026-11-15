-- D10 isolated PostgreSQL 17 integration. Source posting + cash refund + variance.
-- Bootstrap an existing A3 GL fixture; its own BEGIN/ROLLBACK leaves schema, not data.
\set ON_ERROR_STOP on
\ir financial_gl_operational_sources_integration.sql
ALTER TABLE public.supplier_ledger_entries
 ADD COLUMN supplier_id bigint, ADD COLUMN entry_key text;
ALTER TABLE public.supplier_payments
 ADD COLUMN reversed_by_user_id bigint, ADD COLUMN reversal_reason text;
CREATE TABLE public.supplier_purchase_returns(
 id bigint PRIMARY KEY,tenant_id bigint,site_id bigint,purchase_id bigint,
 supplier_id bigint,return_number text,return_date date,status text,
 total_credit_amount numeric,stock_cost_amount numeric,refund_amount numeric,
 refund_company_account_id bigint);
CREATE TABLE public.supplier_purchase_return_lines(
 id bigint PRIMARY KEY,tenant_id bigint,return_id bigint,purchase_id bigint,
 stock_movement_id bigint,supplier_credit_amount numeric,stock_cost_amount numeric);
CREATE TABLE public.financial_supplier_payment_corrections(
 id bigint PRIMARY KEY,tenant_id bigint,site_id bigint,payment_id bigint,
 status text,original_supplier_ledger_id bigint,original_gl_entry_id bigint,
 refund_transaction_id bigint,amount numeric,approved_at timestamptz,
 requested_by_user_id bigint,approved_by_user_id bigint,reason text,
 original_gl_fingerprint text,reversal_supplier_ledger_entry_id bigint);
CREATE TABLE public.company_account_movement_operations(
 tenant_id bigint,site_id bigint,operation_type text,primary_transaction_id bigint,
 counterpart_transaction_id bigint,payload_hash text,operation_key text,created_by_user_id bigint);
\ir ../migrations/20261115110000_powerhub_financial_d10_supplier_return_cash_and_valuation.sql
BEGIN;
INSERT INTO public.financial_gl_accounts(tenant_id,code,name,account_class,normal_side) VALUES
(901,'1010','Cash','asset','debit'),(901,'1300','Inventory','asset','debit'),
(901,'2300','Supplier payable','liability','credit'),(901,'5100','Operating cost','expense','debit');
INSERT INTO public.company_accounts VALUES(601,901,'cash');
INSERT INTO public.inventory_items VALUES(801,901,'expense_on_issue');
INSERT INTO public.supplier_purchases VALUES(901,901,9101,'received',100);
INSERT INTO public.inventory_stock_movements(
 id,tenant_id,site_id,occurred_at,reference_no,quantity,unit_cost,
 total_cost_amount,movement_type,purchase_id,item_id
) VALUES
(1001,901,9101,'2026-10-20T12:00:00Z','PUR-D10',10,10,100,'purchase_receipt',901,801),
(1002,901,9101,'2026-10-22T00:00:00Z','RET-D10-1',3,8,24,'supplier_return',901,801),
(1003,901,9101,'2026-10-23T00:00:00Z','RET-D10-2',2,13,26,'supplier_return',901,801),
(1004,901,9101,'2026-10-24T00:00:00Z','RET-D10-3',1,10,10,'supplier_return',901,801);
INSERT INTO public.supplier_purchase_returns
(id,tenant_id,site_id,purchase_id,supplier_id,return_number,return_date,
 status,total_credit_amount,stock_cost_amount,refund_amount,refund_company_account_id)
VALUES
(1201,901,9101,901,55,'RET-D10-1','2026-10-22','posted',30,24,12,601),
(1202,901,9101,901,55,'RET-D10-2','2026-10-23','posted',20,26,0,NULL),
(1203,901,9101,901,55,'RET-D10-3','2026-10-24','posted',10,10,0,NULL);
INSERT INTO public.supplier_purchase_return_lines VALUES
(1251,901,1201,901,1002,30,24),
(1252,901,1202,901,1003,20,26),
(1253,901,1203,901,1004,10,10);
INSERT INTO public.supplier_ledger_entries
(id,tenant_id,site_id,occurred_at,entry_type,credit_amount,debit_amount,
 purchase_id,supplier_return_id,supplier_payment_id,reference_no,supplier_id,entry_key)
VALUES
(1101,901,9101,'2026-10-20T12:00:00Z','purchase',100,0,901,NULL,NULL,'PUR-D10',55,'supplier-purchase:901'),
(1102,901,9101,'2026-10-22T00:00:00Z','supplier_return',0,30,901,1201,NULL,'RET-D10-1',55,'supplier-return:1201'),
(1103,901,9101,'2026-10-22T00:00:00Z','credit_note',12,0,901,1201,NULL,'RET-D10-1',55,'supplier-return-refund:1201'),
(1104,901,9101,'2026-10-23T00:00:00Z','supplier_return',0,20,901,1202,NULL,'RET-D10-2',55,'supplier-return:1202'),
(1105,901,9101,'2026-10-24T00:00:00Z','supplier_return',0,10,901,1203,NULL,'RET-D10-3',55,'supplier-return:1203');
INSERT INTO public.account_transactions(
id,tenant_id,site_id,occurred_at,reference_no,related_supplier_return_id,
account_id,amount,transaction_type)
VALUES(1501,901,9101,'2026-10-22T00:00:00Z','RET-D10-1',1201,601,12,'deposit');
-- The real GL posting gate requires a documented, independently posted opening.
-- Do not bypass that invariant in the test fixture.
DO $d10_opening$
DECLARE v_open jsonb;v_post jsonb;
BEGIN
 v_open:=public.powerhub_financial_gl_opening_create(
  901,9101,9901,'2026-01-01',
  'D10-DISPOSABLE-OPENING-901',
  'Disposable documented test opening for supplier returns',
  'd10-disposable-opening-901',
  '[{"accountCode":"1010","side":"debit","amount":500,"evidenceReference":"D10-CASH"},
    {"accountCode":"3100","side":"credit","amount":500,"evidenceReference":"D10-EQUITY"}]'::jsonb);
 v_post:=public.powerhub_financial_gl_opening_post(
   901,9101,(v_open->>'openingId')::bigint,9902);
 IF v_post->>'status'<>'posted' THEN
   RAISE EXCEPTION 'D10_DISPOSABLE_OPENING_NOT_POSTED: %',v_post;
 END IF;
END;
$d10_opening$;
DO $d10$
DECLARE p jsonb; ret jsonb; refund jsonb; low jsonb; legacy jsonb;
  v_cash_audit jsonb;
  twice jsonb; e_id bigint; v_lines jsonb; reject boolean; c bigint;
BEGIN
  IF has_function_privilege('authenticated',
      'public.powerhub_financial_gl_source_plan(bigint,bigint,text,bigint)','EXECUTE')
  THEN RAISE EXCEPTION 'D10_UNSAFE_BROWSER_RPC';END IF;
  p:=public.powerhub_financial_gl_post_source(901,9101,'supplier_ledger',1101,9902);
  IF p->>'status'<>'posted' THEN RAISE EXCEPTION 'D10_PURCHASE_POST_FAILED %',p;END IF;
  ret:=public.powerhub_financial_gl_source_plan(901,9101,'supplier_ledger',1102);
  IF ret->>'policyVersion'<>'supplier-return-price-variance-5100-v1'
    OR (ret->'lines'->0->>'amount')::numeric<>30
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(ret->'lines') x
      WHERE x->>'code'='1300' AND x->>'side'='credit'
        AND (x->>'amount')::numeric=24)
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(ret->'lines') x
      WHERE x->>'code'='5100' AND x->>'side'='credit'
        AND (x->>'amount')::numeric=6)
  THEN RAISE EXCEPTION 'D10_POSITIVE_VARIANCE_PLAN_WRONG %',ret;END IF;
  p:=public.powerhub_financial_gl_post_source(901,9101,'supplier_ledger',1102,9902);
  twice:=public.powerhub_financial_gl_post_source(901,9101,'supplier_ledger',1102,9902);
  IF p->>'status'<>'posted' OR (twice->>'alreadyPosted')::boolean IS DISTINCT FROM true
    OR twice->>'entryId' IS DISTINCT FROM p->>'entryId'
  THEN RAISE EXCEPTION 'D10_VARIANCE_IDEMPOTENCY_FAIL % %',p,twice;END IF;
  low:=public.powerhub_financial_gl_source_plan(901,9101,'supplier_ledger',1104);
  IF low->>'policyVersion'<>'supplier-return-price-variance-5100-v1'
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(low->'lines') x
      WHERE x->>'code'='5100' AND x->>'side'='debit'
        AND (x->>'amount')::numeric=6)
  THEN RAISE EXCEPTION 'D10_NEGATIVE_VARIANCE_PLAN_WRONG %',low;END IF;
  PERFORM public.powerhub_financial_gl_post_source(901,9101,'supplier_ledger',1104,9902);
  legacy:=public.powerhub_financial_gl_source_plan(901,9101,'supplier_ledger',1105);
  IF legacy->>'policyVersion'<>'supplier-event-no-stock-duplication-v1'
    OR jsonb_array_length(legacy->'lines')<>2
  THEN RAISE EXCEPTION 'D10_EQUAL_COST_LEGACY_POLICY_CHANGED %',legacy;END IF;
  PERFORM public.powerhub_financial_gl_post_source(901,9101,'supplier_ledger',1105,9902);
  refund:=public.powerhub_financial_gl_source_plan(901,9101,'supplier_ledger',1103);
  IF refund->>'policyVersion'<>'supplier-return-cash-refund-v1'
    OR jsonb_array_length(refund->'lines')<>2
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(refund->'lines') x
      WHERE x->>'code'='1010' AND x->>'side'='debit'
        AND (x->>'amount')::numeric=12)
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(refund->'lines') x
      WHERE x->>'code'='2300' AND x->>'side'='credit'
        AND (x->>'amount')::numeric=12)
  THEN RAISE EXCEPTION 'D10_REFUND_GL_LINES_BAD %',refund;END IF;
  p:=public.powerhub_financial_gl_post_source(901,9101,'supplier_ledger',1103,9902);
  twice:=public.powerhub_financial_gl_post_source(901,9101,'supplier_ledger',1103,9902);
  IF p->>'status'<>'posted' OR (twice->>'alreadyPosted')::boolean IS DISTINCT FROM true
    OR twice->>'entryId' IS DISTINCT FROM p->>'entryId'
  THEN RAISE EXCEPTION 'D10_REFUND_REPLAY_NOT_EXACTLY_ONCE';END IF;
  SELECT count(*) INTO c FROM public.financial_gl_entries e
    WHERE e.tenant_id=901 AND e.site_id=9101 AND e.source_type='supplier_ledger';
  IF c<>5 THEN RAISE EXCEPTION 'D10_GL_ENTRY_COUNT_%',c;END IF;
  IF EXISTS(SELECT 1 FROM public.financial_gl_entries e
    JOIN public.financial_gl_lines l ON l.entry_id=e.id
    WHERE e.tenant_id=901 AND e.site_id=9101 GROUP BY e.id
    HAVING sum(CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END)<>0)
  THEN RAISE EXCEPTION 'D10_UNBALANCED_GL';END IF;

  -- The live cash audit must retain the newer B5.18 keyset index path after D10.
  IF position('SELECT x.id FROM public.account_transactions x' IN
      pg_get_functiondef('public.powerhub_financial_gl_company_movement_audit(bigint,bigint,text)'::regprocedure))=0
     OR position(') cash_keys' IN
      pg_get_functiondef('public.powerhub_financial_gl_company_movement_audit(bigint,bigint,text)'::regprocedure))=0
  THEN RAISE EXCEPTION 'D10_B518_CASH_KEYSET_PERFORMANCE_REGRESSION';END IF;
  -- The refund must be visible in the company movement audit, not merely the GL.
  v_cash_audit:=public.powerhub_financial_gl_company_movement_audit(901,9101,'2026-10');
  IF v_cash_audit->>'accountingCertification'<>'NOT_CERTIFIED'
    OR (v_cash_audit->>'linkedMovementCount')::bigint<1
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_cash_audit->'mismatchExamples') ex
      WHERE (ex->>'transactionId')::bigint=1501)
  THEN RAISE EXCEPTION 'D10_CASH_AUDIT_REFUND_MISMATCH: %',v_cash_audit;END IF;
  -- A forged tenant cannot borrow another tenant's return or refund source.
  reject:=false;
  BEGIN
    PERFORM public.powerhub_financial_gl_source_plan(902,9201,'supplier_ledger',1103);
  EXCEPTION WHEN SQLSTATE '22023' THEN reject:=true;END;
  IF NOT reject THEN RAISE EXCEPTION 'D10_CROSS_TENANT_REFUND_ALLOWED';END IF;
  -- A missing cash transaction fails closed; no fake GL.
  UPDATE public.account_transactions SET amount=11 WHERE id=1501;
  reject:=false;
  BEGIN
    PERFORM public.powerhub_financial_gl_source_plan(901,9101,'supplier_ledger',1103);
  EXCEPTION WHEN SQLSTATE '22023' THEN reject:=true;END;
  IF NOT reject THEN RAISE EXCEPTION 'D10_TAMPERED_REFUND_CASH_ACCEPTED';END IF;
  UPDATE public.account_transactions SET amount=12 WHERE id=1501;
  -- The credit must match both the return header and its physical source.
  UPDATE public.supplier_purchase_return_lines SET stock_cost_amount=23 WHERE id=1251;
  reject:=false;
  BEGIN
    PERFORM public.powerhub_financial_gl_source_plan(901,9101,'supplier_ledger',1102);
  EXCEPTION WHEN SQLSTATE '22023' THEN reject:=true;END;
  IF NOT reject THEN RAISE EXCEPTION 'D10_TAMPERED_RETURN_VALUATION_ACCEPTED';END IF;
  UPDATE public.supplier_purchase_return_lines SET stock_cost_amount=24 WHERE id=1251;
  RAISE NOTICE 'D10_REFUND_AND_VARIANCE_GL_DISPOSABLE_PASS';
END;
$d10$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
SELECT 'D10_REFUND_AND_VARIANCE_GL_DISPOSABLE_PASS' AS acceptance;
