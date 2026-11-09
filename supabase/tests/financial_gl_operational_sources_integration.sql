-- Dedicated, disposable PostgreSQL 17 integration; original source and GL migrations.
-- Tests real RPCs, source integrity, exactly-once retries, money, month boundaries.
\set ON_ERROR_STOP on
\ir financial_gl_two_session_setup.sql
CREATE TABLE public.invoices(
 id bigint PRIMARY KEY,tenant_id bigint,site_id bigint,status text,
 cycle_start_at timestamptz,cycle_end_at timestamptz,issue_date timestamptz,
 total_amount numeric,tax_amount numeric,credit_applied_amount numeric,
 invoice_no text,subscriber_id bigint
);
CREATE TABLE public.payments(
 id bigint PRIMARY KEY,tenant_id bigint,site_id bigint,status text,
 paid_at timestamptz,amount numeric,invoice_applied_amount numeric,
 subscriber_credit_amount numeric,invoice_id bigint
);
CREATE TABLE public.expenses(
 id bigint PRIMARY KEY,tenant_id bigint,site_id bigint,category text,
 occurred_at timestamptz,amount numeric,company_account_id bigint,
 expense_classification text,reference_no text
);
CREATE TABLE public.payroll_runs(
 id bigint PRIMARY KEY,tenant_id bigint,site_id bigint,period text,status text,
 total_gross numeric,total_net numeric,total_deductions numeric,
 approved_by_user_id bigint,created_by_user_id bigint,
 paid_at timestamptz,paid_from_account_id bigint
);
CREATE TABLE public.payroll_items(
 payroll_run_id bigint,base_amount numeric,extra_amount numeric,
 advance_deduction numeric,other_deduction numeric,net_amount numeric
);
CREATE TABLE public.inventory_items(
 id bigint PRIMARY KEY,tenant_id bigint,accounting_treatment text
);
CREATE TABLE public.inventory_stock_movements(
 id bigint PRIMARY KEY,tenant_id bigint,site_id bigint,occurred_at timestamptz,
 reference_no text,quantity numeric,unit_cost numeric,total_cost_amount numeric,
 movement_type text,purchase_id bigint,item_id bigint,reversal_of_movement_id bigint,
 source_issue_movement_id bigint,operation_key text,warehouse_id bigint
);
CREATE TABLE public.supplier_ledger_entries(
 id bigint PRIMARY KEY,tenant_id bigint,site_id bigint,occurred_at timestamptz,
 entry_type text,credit_amount numeric,debit_amount numeric,purchase_id bigint,
 supplier_return_id bigint,supplier_payment_id bigint,reference_no text
);
CREATE TABLE public.supplier_purchases(
 id bigint PRIMARY KEY,tenant_id bigint,site_id bigint,status text,total_amount numeric
);
CREATE TABLE public.supplier_payments(
 id bigint PRIMARY KEY,tenant_id bigint,site_id bigint,status text,amount numeric,
 account_transaction_id bigint,company_account_id bigint
);
CREATE TABLE public.company_accounts(
 id bigint PRIMARY KEY,tenant_id bigint,account_type text
);
CREATE TABLE public.account_transactions(
 id bigint PRIMARY KEY,tenant_id bigint,site_id bigint,occurred_at timestamptz,
 reference_no text,related_payment_id bigint,related_expense_id bigint,
 related_supplier_payment_id bigint,related_supplier_return_id bigint,
 related_account_id bigint,account_id bigint,amount numeric,transaction_type text
);
\ir ../migrations/20261110011000_powerhub_financial_gl_opening_balances.sql
\ir ../migrations/20261110012000_powerhub_financial_gl_source_coverage.sql
\ir ../migrations/20261110013000_powerhub_financial_gl_trial_balance.sql
\ir ../migrations/20261110014000_powerhub_financial_service_month_allocation.sql
\ir ../migrations/20261110015000_powerhub_financial_gl_post_operational_sources.sql
\ir ../migrations/20261110016000_powerhub_financial_gl_source_coverage_operational.sql
\ir ../migrations/20261110017000_powerhub_financial_gl_service_recognition.sql
\ir ../migrations/20261110018000_powerhub_financial_gl_source_integrity_coverage.sql
\ir ../migrations/20261110019000_powerhub_financial_gl_accrual_integrity.sql
\ir ../migrations/20261110020000_powerhub_financial_gl_accrual_source_coverage.sql
\ir ../migrations/20261110021000_powerhub_financial_gl_prior_accrual_coverage.sql
\ir ../migrations/20261110022000_powerhub_financial_gl_opening_evidence_gate.sql
-- A18 source-custody fixture for real independent-review RPCs.
ALTER TABLE public.users ADD COLUMN account_status text NOT NULL DEFAULT 'active';
INSERT INTO public.users(id) VALUES(9903),(9904);
CREATE TABLE public.tenant_members(
 tenant_id bigint NOT NULL,user_id bigint NOT NULL,
 is_active boolean NOT NULL,membership_status text NOT NULL,role text NOT NULL,
 PRIMARY KEY(tenant_id,user_id));
INSERT INTO public.tenant_members VALUES
 (901,9901,true,'active','owner'),
 (901,9902,true,'active','owner'),
 (901,9903,true,'active','owner'),
 (901,9904,true,'active','owner');
\ir ../migrations/20261110025000_powerhub_financial_gl_opening_independent_evidence.sql

BEGIN;
INSERT INTO public.company_accounts VALUES(601,901,'cash');
INSERT INTO public.invoices VALUES
 (301,901,9101,'paid','2026-10-01T00:00:00Z','2026-10-31T12:00:00Z',
  '2026-10-20T00:00:00Z',110,10,0,'TEST-INV-301',701);
INSERT INTO public.payments VALUES
 (401,901,9101,'completed','2026-10-20T12:00:00Z',55,55,0,301);
INSERT INTO public.expenses VALUES
 (701,901,9101,'maintenance','2026-10-20T12:00:00Z',12,601,'operating');
INSERT INTO public.account_transactions VALUES
 (501,901,9101,'2026-10-20T12:00:00Z',NULL,401,NULL,NULL,NULL,NULL,601,55,'collection'),
 (502,901,9101,'2026-10-20T12:00:00Z',NULL,NULL,701,NULL,NULL,NULL,601,12,'withdrawal'),
 (503,901,9101,'2026-10-20T12:00:00Z',NULL,NULL,NULL,1301,NULL,NULL,601,15,'withdrawal');
INSERT INTO public.inventory_items VALUES(801,901,'expense_on_issue');
INSERT INTO public.supplier_purchases VALUES(901,901,9101,'received',40),
 (902,901,9101,'confirmed',20);
INSERT INTO public.inventory_stock_movements VALUES
 (1001,901,9101,'2026-10-20T12:00:00Z','PUR-901',4,10,40,'purchase_receipt',901,801,NULL,NULL),
 (1002,901,9101,'2026-10-21T12:00:00Z','ISS-1002',1,10,10,'issue',NULL,801,NULL,NULL),
 (1003,901,9101,'2026-10-22T12:00:00Z','RET-1003',1,10,10,'supplier_return',901,801,NULL,NULL),
 (1004,901,9101,'2026-10-23T12:00:00Z','ADJ-1004',1,10,10,'adjustment_in',NULL,801,NULL,NULL);
-- One paired transfer changes the warehouse, not inventory asset value.
INSERT INTO public.inventory_stock_movements(
 id,tenant_id,site_id,occurred_at,reference_no,quantity,unit_cost,total_cost_amount,
 movement_type,purchase_id,item_id,reversal_of_movement_id,source_issue_movement_id,
 operation_key,warehouse_id)
VALUES
 (1005,901,9101,'2026-10-23T12:00:00Z','XFER-1005',2,10,20,
   'issue',NULL,801,NULL,NULL,'trf:ci-warehouse-transfer:out',111),
 (1006,901,9101,'2026-10-23T12:00:00Z','XFER-1005',2,10,20,
   'adjustment_in',NULL,801,NULL,NULL,'trf:ci-warehouse-transfer:in',222);
INSERT INTO public.supplier_ledger_entries VALUES
 (1101,901,9101,'2026-10-20T12:00:00Z','purchase',40,0,901,NULL,NULL,'PUR-901'),
 (1102,901,9101,'2026-10-22T12:00:00Z','supplier_return',0,10,901,1201,NULL,'RET-1003'),
 (1103,901,9101,'2026-10-23T12:00:00Z','payment',0,15,901,NULL,1301,'PAY-1301'),
 (1104,901,9101,'2026-10-24T12:00:00Z','purchase',20,0,902,NULL,NULL,'PUR-902');
INSERT INTO public.supplier_payments VALUES(1301,901,9101,'posted',15,503,601);
INSERT INTO public.payroll_runs VALUES(1401,901,9101,'2026-10','approved',100,80,20,9902,9901);
INSERT INTO public.payroll_items VALUES(1401,100,0,10,10,80);
DO $assert$
DECLARE
 opening jsonb; posted jsonb; service jsonb; retry jsonb;
 src text; sid bigint; v jsonb; v_again jsonb; count_entries bigint;
 total_net numeric; report jsonb; trial jsonb; blocked boolean;
 evidence_line bigint; evidence_id bigint; evidence_result jsonb;
 evidence_actor bigint;
BEGIN
 opening:=public.powerhub_financial_gl_opening_create(901,9101,9901,'2026-01-01',
 'CI-FINANCE-OPENING-901','Independent documented finance opening for source reconciliation',
 'ci-financial-source-opening-901',
 '[{"accountCode":"1010","side":"debit","amount":490,"evidenceReference":"CI-CASH"},
   {"accountCode":"1700","side":"debit","amount":10,"evidenceReference":"CI-ADVANCE"},
   {"accountCode":"3100","side":"credit","amount":500,"evidenceReference":"CI-CAPITAL"}]'::jsonb);
 posted:=public.powerhub_financial_gl_opening_post(901,9101,
    (opening->>'openingId')::bigint,9902);
 IF posted->>'status'<>'posted' THEN RAISE EXCEPTION 'GL_CI_OPENING_NOT_POSTED'; END IF;
 FOR src,sid IN SELECT * FROM (VALUES
   ('invoice'::text,301::bigint),
   ('payment',401),('expense',701),('supplier_ledger',1101),
   ('supplier_ledger',1102),('supplier_ledger',1103),
   ('stock_movement',1002),('payroll',1401)) AS sources(kind,source_id)
 LOOP
   v:=public.powerhub_financial_gl_post_source(901,9101,src,sid,9902);
   v_again:=public.powerhub_financial_gl_post_source(901,9101,src,sid,9902);
   IF v->>'status'<>'posted' OR (v->>'alreadyPosted')::boolean
     OR NOT (v_again->>'alreadyPosted')::boolean
     OR v->>'entryId' IS DISTINCT FROM v_again->>'entryId'
   THEN RAISE EXCEPTION 'GL_CI_IDEMPOTENCY_FAILED % %',src,sid; END IF;
 END LOOP;
 -- An approved payroll cost is distinct from its later net cash payout.
 -- The legacy PAYROLL-<id> expense and linked withdrawal are settlement
 -- evidence, not another gross or net wage expense.
 UPDATE public.payroll_runs SET status='paid',
    paid_at='2026-10-25T12:00:00Z',paid_from_account_id=601
 WHERE id=1401 AND status='approved';
 INSERT INTO public.expenses(id,tenant_id,site_id,category,occurred_at,
    amount,company_account_id,expense_classification,reference_no)
 VALUES(702,901,9101,'payroll','2026-10-25T12:00:00Z',
    80,601,'operating','PAYROLL-1401');
 INSERT INTO public.account_transactions(
    id,tenant_id,site_id,occurred_at,reference_no,
    related_expense_id,account_id,amount,transaction_type)
 VALUES(504,901,9101,'2026-10-25T12:00:00Z','PAYROLL-1401',
    702,601,80,'withdrawal');
 v:=public.powerhub_financial_gl_post_source(901,9101,'payroll_payment',1401,9902);
 v_again:=public.powerhub_financial_gl_post_source(901,9101,'payroll_payment',1401,9902);
 IF (v->>'alreadyPosted')::boolean OR NOT (v_again->>'alreadyPosted')::boolean
    OR v->>'entryId' IS DISTINCT FROM v_again->>'entryId'
 THEN RAISE EXCEPTION 'GL_CI_PAYROLL_PAYOUT_IDEMPOTENCY'; END IF;
 -- The accrual remains exactly replayable even after payroll transitions to paid.
 v_again:=public.powerhub_financial_gl_post_source(901,9101,'payroll',1401,9902);
 IF NOT (v_again->>'alreadyPosted')::boolean
 THEN RAISE EXCEPTION 'GL_CI_PAID_PAYROLL_ACCRUAL_REPLAY_FAILED'; END IF;
 report:=public.powerhub_financial_gl_source_coverage(901,9101,'2026-10');
 IF (report->'sources'->'serviceRecognition'->>'missingGL')::int<>1
    OR (report->'sources'->'serviceRecognition'->>'requiredInvoiceMonths')::int<>1
 THEN RAISE EXCEPTION 'GL_CI_EARNED_REVENUE_MISSING_NOT_DETECTED: %',report; END IF;
 service:=public.powerhub_financial_gl_recognize_billed_service(
   901,9101,301,'2026-10',9902);
 retry:=public.powerhub_financial_gl_recognize_billed_service(
   901,9101,301,'2026-10',9902);
 report:=public.powerhub_financial_gl_source_coverage(901,9101,'2026-10');
 IF (report->'sources'->'serviceRecognition'->>'missingGL')::int<>0
 THEN RAISE EXCEPTION 'GL_CI_EARNED_REVENUE_POSTED_NOT_RECONCILED: %',report; END IF;
 report:=public.powerhub_financial_gl_source_coverage(901,9101,'2026-10');
 IF (report->'sourceIntegrity'->>'isClean')::boolean IS DISTINCT FROM true
    OR (report->'sourceIntegrity'->>'checkedEntries')::int<>11
 THEN RAISE EXCEPTION 'GL_CI_INTEGRITY_BASELINE_BAD: %',report->'sourceIntegrity'; END IF;
 -- A4: the source is authoritative. A booked invoice must not be silently
 -- re-posted after an amount revision, even when the journal remains balanced.
 -- This regression runs in the disposable transaction and restores source
 -- fields before the other coverage assertions.
 UPDATE public.invoices SET total_amount=111 WHERE id=301;
 blocked:=false;
 BEGIN
   PERFORM public.powerhub_financial_gl_post_source(901,9101,'invoice',301,9902);
 EXCEPTION WHEN SQLSTATE '23505' THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'GL_CI_EDITED_INVOICE_REPLAY_ALLOWED'; END IF;
 blocked:=false;
 BEGIN
   PERFORM public.powerhub_financial_gl_recognize_billed_service(
     901,9101,301,'2026-10',9902);
 EXCEPTION WHEN SQLSTATE '23505' THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'GL_CI_EDITED_INVOICE_RECOGNITION_ALLOWED'; END IF;
 report:=public.powerhub_financial_gl_source_coverage(901,9101,'2026-10');
 IF (report->'sourceIntegrity'->>'isClean')::boolean IS DISTINCT FROM false
    OR (report->'sourceIntegrity'->>'driftedEntries')::int<>1
    OR (report->'sourceIntegrity'->>'invalidSources')::int<>1
 THEN RAISE EXCEPTION 'GL_CI_INTEGRITY_CHANGED_INVOICE_NOT_DETECTED: %',report->'sourceIntegrity'; END IF;
 trial:=public.powerhub_financial_gl_trial_balance(901,9101,'2026-10');
 IF (trial->'sourceCoverage'->'sourceIntegrity'->>'isClean')::boolean
     IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'GL_CI_TRIAL_BALANCE_HIDES_SOURCE_DRIFT'; END IF;
 UPDATE public.invoices SET total_amount=110 WHERE id=301;
 report:=public.powerhub_financial_gl_source_coverage(901,9101,'2026-10');
 IF (report->'sourceIntegrity'->>'isClean')::boolean IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'GL_CI_INTEGRITY_RESTORED_INVOICE_NOT_CLEAN: %',report->'sourceIntegrity'; END IF;
 retry:=public.powerhub_financial_gl_post_source(901,9101,'invoice',301,9902);
 IF NOT (retry->>'alreadyPosted')::boolean
 THEN RAISE EXCEPTION 'GL_CI_RESTORED_INVOICE_NOT_IDEMPOTENT'; END IF;
 -- The linked collection also forms part of the payment source fingerprint.
 UPDATE public.account_transactions SET amount=56 WHERE id=501;
 blocked:=false;
 BEGIN
   PERFORM public.powerhub_financial_gl_post_source(901,9101,'payment',401,9902);
 EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'GL_CI_CHANGED_COLLECTION_REPLAY_ALLOWED'; END IF;
 report:=public.powerhub_financial_gl_source_coverage(901,9101,'2026-10');
 -- An invalid linked cash amount cannot yield an authoritative plan; the
 -- audit must fail closed, regardless of whether it is classified as drift
 -- or as an unverified source.
 IF (report->'sourceIntegrity'->>'isClean')::boolean IS DISTINCT FROM false
    OR (report->'sourceIntegrity'->>'driftedEntries')::int+
       (report->'sourceIntegrity'->>'invalidSources')::int<>1
 THEN RAISE EXCEPTION 'GL_CI_INTEGRITY_CHANGED_PAYMENT_NOT_DETECTED: %',report->'sourceIntegrity'; END IF;
 UPDATE public.account_transactions SET amount=55 WHERE id=501;
 retry:=public.powerhub_financial_gl_post_source(901,9101,'payment',401,9902);
 report:=public.powerhub_financial_gl_source_coverage(901,9101,'2026-10');
 IF (report->'sourceIntegrity'->>'isClean')::boolean IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'GL_CI_INTEGRITY_RESTORED_PAYMENT_NOT_CLEAN'; END IF;
 IF NOT (retry->>'alreadyPosted')::boolean
 THEN RAISE EXCEPTION 'GL_CI_RESTORED_PAYMENT_NOT_IDEMPOTENT'; END IF;
 retry:=public.powerhub_financial_gl_recognize_billed_service(
   901,9101,301,'2026-10',9902);
 IF (service->>'amountMinor')::bigint<>10000
    OR (service->>'alreadyPosted')::boolean
    OR NOT (retry->>'alreadyPosted')::boolean
    OR service->>'entryId' IS DISTINCT FROM retry->>'entryId'
 THEN RAISE EXCEPTION 'GL_CI_SERVICE_RECOGNITION_BAD'; END IF;
 blocked:=false;
 BEGIN
   PERFORM public.powerhub_financial_gl_post_source(901,9101,'supplier_ledger',1104,9902);
 EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true;
 END;
 IF NOT blocked THEN RAISE EXCEPTION 'GL_CI_UNRECEIVED_PURCHASE_POSTED'; END IF;
 blocked:=false;
 BEGIN
   PERFORM public.powerhub_financial_gl_post_source(901,9101,'stock_movement',1004,9902);
 EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true;
 END;
 IF NOT blocked THEN RAISE EXCEPTION 'GL_CI_UNLINKED_ADJUSTMENT_POSTED'; END IF;
 FOR sid IN SELECT unnest(ARRAY[1005::bigint,1006]) LOOP
   blocked:=false;
   BEGIN
      PERFORM public.powerhub_financial_gl_post_source(901,9101,'stock_movement',sid,9902);
   EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true; END;
   IF NOT blocked THEN RAISE EXCEPTION 'GL_CI_TRANSFER_EXPENSED_%',sid; END IF;
 END LOOP;
 blocked:=false;
 BEGIN
   PERFORM public.powerhub_financial_gl_post_source(902,9201,'payment',401,9902);
 EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true;
 END;
 IF NOT blocked THEN RAISE EXCEPTION 'GL_CI_CROSS_TENANT_POSTED'; END IF;
 SELECT count(*),coalesce(sum(CASE WHEN side='debit' THEN amount ELSE -amount END),0)
 INTO count_entries,total_net FROM public.financial_gl_lines WHERE tenant_id=901 AND site_id=9101;
 IF count_entries<>26 OR total_net<>0
 THEN RAISE EXCEPTION 'GL_CI_LINES_IMBALANCED lines=% net=%',count_entries,total_net; END IF;
 report:=public.powerhub_financial_gl_source_coverage(901,9101,'2026-10');
 trial:=public.powerhub_financial_gl_trial_balance(901,9101,'2026-10');
 IF (report->'sources'->'invoices'->>'missingGL')::int<>0
    OR (report->'sources'->'payments'->>'missingGL')::int<>0
    OR (report->'sources'->'expenses'->>'missingGL')::int<>0
    OR (report->'sources'->'payroll'->>'missingGL')::int<>0
    OR (report->'sources'->'supplierLedger'->>'missingGL')::int<>1
    OR (report->'sources'->'stockMovements'->>'missingGL')::int<>1
    OR (trial->>'difference')::numeric<>0
    OR trial->>'accountingCertification'<>'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'GL_CI_COVERAGE_MISMATCH: %',report; END IF;
 -- A5 accrual/reversal integrity after previous exact line-count assertions.
 -- Source and reverse are distinct posted documents; neither creates a
 -- fabricated opening balance or a second payable.
 PERFORM public.powerhub_financial_accrual_post_and_gl(901,9101,
   public.powerhub_financial_accrual_journal_create(
     901,9101,9901,'2026-09','5100','2100',13.75,
     'Independent source-backed accrual integrity acceptance case',
     'ci-a5-accrual-source-901'),9902);
 SELECT id INTO sid FROM public.financial_accrual_journals j
 WHERE j.tenant_id=901 AND j.site_id=9101
   AND j.operation_key='ci-a5-accrual-source-901';
 src:=public.powerhub_financial_accrual_journal_reverse(
   901,9101,sid,9901,'2026-10',
   'Reversal of source-backed accrual integrity acceptance case',
   'ci-a5-accrual-reversal-901')::text;
 PERFORM public.powerhub_financial_accrual_post_and_gl(
   901,9101,src::bigint,9902);
 report:=public.powerhub_financial_gl_source_coverage(901,9101,'2026-10');
 IF (report->'sourceIntegrity'->>'isClean')::boolean IS DISTINCT FROM true
    OR (report->'sourceIntegrity'->>'invalidSources')::int<>0
    OR (report->'sourceIntegrity'->>'driftedEntries')::int<>0
    OR (report->'sourceIntegrity'->>'unauditedEntries')::int<>0
 THEN RAISE EXCEPTION 'GL_CI_ACCRUAL_AND_REVERSAL_SOURCE_INTEGRITY: %',
   report->'sourceIntegrity'; END IF;
 trial:=public.powerhub_financial_gl_trial_balance(901,9101,'2026-10');
 IF (trial->>'difference')::numeric<>0 OR
    trial->'sourceCoverage'->'sourceIntegrity'->>'isClean'<>'true'
 THEN RAISE EXCEPTION 'GL_CI_ACCRUAL_REVERSAL_TRIAL_BALANCE'; END IF;
 -- A6: draft accruals and already approved but missing GL projections
 -- must block coverage despite mathematically balanced existing journals.
 sid:=public.powerhub_financial_accrual_journal_create(
   901,9101,9901,'2026-10','5100','2100',13.75,
   'Independent accrual source coverage gap detector',
   'ci-a6-approved-unposted-accrual');
 report:=public.powerhub_financial_gl_source_coverage(901,9101,'2026-10');
 IF (report->'sources'->'accrualAdjustments'->>'drafts')::int<>1
 THEN RAISE EXCEPTION 'GL_CI_A6_ACCRUAL_DRAFT_HIDDEN'; END IF;
 PERFORM public.powerhub_financial_accrual_journal_post(901,9101,sid,9902);
 report:=public.powerhub_financial_gl_source_coverage(901,9101,'2026-10');
 IF (report->'sources'->'accrualAdjustments'->>'missingGL')::int<>1
   OR (report->>'isSourceCoverageComplete')::boolean IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'GL_CI_A6_APPROVED_WITHOUT_GL_HIDDEN'; END IF;
 PERFORM public.powerhub_financial_gl_post_accrual(901,9101,sid);
 report:=public.powerhub_financial_gl_source_coverage(901,9101,'2026-10');
 IF (report->'sources'->'accrualAdjustments'->>'missingGL')::int<>0
   OR (report->'sources'->'accrualAdjustments'->>'drafts')::int<>0
   OR (report->'sourceIntegrity'->>'isClean')::boolean IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'GL_CI_A6_APPROVED_ACCRUAL_NOT_RECONCILED'; END IF;
 -- A7: an earlier-month approved accrual with no GL must block
 -- a later cumulative trial balance (not just its own month).
 sid:=public.powerhub_financial_accrual_journal_create(
   901,9101,9901,'2026-09','5100','2100',19.25,
   'Historical unposted adjustment to verify cumulative month-end source audit',
   'ci-a7-prior-accrual-missing-gl');
 PERFORM public.powerhub_financial_accrual_journal_post(901,9101,sid,9902);
 report:=public.powerhub_financial_gl_source_coverage(901,9101,'2026-10');
 trial:=public.powerhub_financial_gl_trial_balance(901,9101,'2026-10');
 IF (report->'sources'->'priorAccrualAdjustments'->>'missingGL')::int<>1
    OR (report->'sources'->'priorAccrualAdjustments'->>'approved')::int<2
    OR (trial->'sourceCoverage'->'sources'->
         'priorAccrualAdjustments'->>'missingGL')::int<>1
    OR (report->>'isSourceCoverageComplete')::boolean IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'GL_CI_A7_PRIOR_PERIOD_ACCRUAL_GAP_HIDDEN: %',
   report->'sources'->'priorAccrualAdjustments'; END IF;
 PERFORM public.powerhub_financial_gl_post_accrual(901,9101,sid);
 report:=public.powerhub_financial_gl_source_coverage(901,9101,'2026-10');
 IF (report->'sources'->'priorAccrualAdjustments'->>'missingGL')::int<>0
   OR (report->'sourceIntegrity'->>'isClean')::boolean IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'GL_CI_A7_PRIOR_ACCRUAL_RECONCILE_FAILED'; END IF;
 -- A8: a September expense without GL must make the October cumulative
 -- coverage incomplete even if the October source set itself has no gap.
 INSERT INTO public.expenses(id,tenant_id,site_id,category,occurred_at,
   amount,company_account_id,expense_classification)
 VALUES(1702,901,9101,'maintenance','2026-09-17T12:00:00Z',19.50,601,'operating');
 INSERT INTO public.account_transactions(
   id,tenant_id,site_id,occurred_at,related_expense_id,account_id,
   amount,transaction_type)
 VALUES(1602,901,9101,'2026-09-17T12:00:00Z',1702,601,19.50,'withdrawal');
 report:=public.powerhub_financial_gl_source_coverage(901,9101,'2026-10');
 trial:=public.powerhub_financial_gl_trial_balance(901,9101,'2026-10');
 IF (report->'sources'->'priorOperationalSources'->>'expensesMissingGL')::int<>1
    OR (report->'sources'->'priorOperationalSources'->>'unreconciledCount')::int<1
    OR (trial->'sourceCoverage'->'sources'->'priorOperationalSources'
       ->>'expensesMissingGL')::int<>1
    OR (report->>'isSourceCoverageComplete')::boolean IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'GL_CI_A8_PRIOR_EXPENSE_GAP_HIDDEN: %',
   report->'sources'->'priorOperationalSources'; END IF;
 PERFORM public.powerhub_financial_gl_post_source(901,9101,'expense',1702,9902);
 report:=public.powerhub_financial_gl_source_coverage(901,9101,'2026-10');
 IF (report->'sources'->'priorOperationalSources'->>'expensesMissingGL')::int<>0
 THEN RAISE EXCEPTION 'GL_CI_A8_PRIOR_EXPENSE_NOT_RECONCILED'; END IF;
 -- A8: an otherwise valid September collection (linked to a posted
 -- invoice) must also be visible as missing in October until its own GL
 -- projection is posted. The collection movement is not extra revenue.
 INSERT INTO public.payments(id,tenant_id,site_id,status,paid_at,amount,
   invoice_applied_amount,subscriber_credit_amount,invoice_id)
 VALUES(402,901,9101,'completed','2026-09-17T12:00:00Z',8,8,0,301);
 INSERT INTO public.account_transactions(id,tenant_id,site_id,occurred_at,
   related_payment_id,account_id,amount,transaction_type)
 VALUES(1603,901,9101,'2026-09-17T12:00:00Z',402,601,8,'collection');
 report:=public.powerhub_financial_gl_source_coverage(901,9101,'2026-10');
 IF (report->'sources'->'priorOperationalSources'->>'paymentsMissingGL')::int<>1
   OR (report->'sources'->'priorOperationalSources'->
      'paymentCollectionMismatches')::int<>0
 THEN RAISE EXCEPTION 'GL_CI_A8_PRIOR_COLLECTION_HIDDEN: %',
    report->'sources'->'priorOperationalSources';END IF;
 PERFORM public.powerhub_financial_gl_post_source(901,9101,'payment',402,9902);
 report:=public.powerhub_financial_gl_source_coverage(901,9101,'2026-10');
 IF (report->'sources'->'priorOperationalSources'->>'paymentsMissingGL')::int<>0
   OR (report->'sourceIntegrity'->>'isClean')::boolean IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'GL_CI_A8_PRIOR_COLLECTION_NOT_RECONCILED: %',
   report->'sources'->'priorOperationalSources';END IF;
 -- A9: a posted GL must remain immutable even to a privileged caller.
 -- Verify that denied journal edits/deletions do not turn the trial result
 -- into a false clean source. Deferred balance checks run at commit.
 blocked:=false;
 BEGIN
   UPDATE public.financial_gl_entries
      SET accounting_policy_version='tampered-v9'
    WHERE tenant_id=901 AND site_id=9101 AND source_type='invoice'
      AND source_id='301';
 EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'GL_CI_A9_POSTED_ENTRY_MUTABLE';END IF;
 blocked:=false;
 BEGIN
   DELETE FROM public.financial_gl_lines
    WHERE tenant_id=901 AND site_id=9101
      AND entry_id=(SELECT id FROM public.financial_gl_entries
         WHERE tenant_id=901 AND site_id=9101
           AND source_type='invoice' AND source_id='301');
 EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'GL_CI_A9_POSTED_LINES_DELETABLE';END IF;
 blocked:=false;
 BEGIN
   PERFORM public.powerhub_financial_gl_source_coverage(902,9101,'2026-10');
 EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true;END;
 IF NOT blocked THEN RAISE EXCEPTION 'GL_CI_A9_CROSS_TENANT_REPORT_VISIBLE'; END IF;
 -- A10: the opening batch and balanced journal prove structural posting,
 -- not independent reconciliation with source balances. No caller may infer
 -- an accountant-certified opening from the presence of posted GL.
 report:=public.powerhub_financial_gl_source_coverage(901,9101,'2026-10');
 trial:=public.powerhub_financial_gl_trial_balance(901,9101,'2026-10');
 IF (report->>'isOpeningStructurallyPosted')::boolean IS DISTINCT FROM true
   OR (report->>'isOpeningReconciled')::boolean IS DISTINCT FROM false
   OR report->'openingEvidenceAudit'->>'status'
       IS DISTINCT FROM 'INDEPENDENT_SUBLEDGER_RECONCILIATION_REQUIRED'
   OR (report->'openingEvidenceAudit'->>'accountBalancesMatchedToOpening')::boolean
       IS DISTINCT FROM false
   OR trial->>'accountingCertification'<>'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'GL_CI_A10_OPENING_EVIDENCE_FALSE_CERTIFICATION: %',
    report->'openingEvidenceAudit';END IF;
 -- A18: independent evidence review must prove line-level match but still
 -- block the assertion that a hash is a verified external source document.
 FOR src,sid IN SELECT * FROM (VALUES
    ('1010'::text,490::bigint),('1700',10),('3100',500)
 ) AS sources(account_code,source_amount)
 LOOP
   SELECT l.id INTO evidence_line
   FROM public.financial_gl_opening_lines l
   WHERE l.opening_id=(opening->>'openingId')::bigint AND l.account_code=src;
   IF evidence_line IS NULL THEN
    RAISE EXCEPTION 'GL_CI_A18_OPENING_LINE_NOT_FOUND %',src;END IF;
   evidence_id:=public.powerhub_financial_gl_opening_evidence_submit(
     901,9101,(opening->>'openingId')::bigint,evidence_line,
     CASE src WHEN '1010' THEN 'company_account_statement'
       WHEN '3100' THEN 'equity_confirmation'
       ELSE 'other_external_statement' END,
     'CI-A18-REVIEWED-SOURCE-'||src,repeat('a',64),
     '2026-01-01',CASE WHEN src='3100' THEN 'credit' ELSE 'debit' END,
     sid,9904);
   blocked:=false;
   BEGIN
     PERFORM public.powerhub_financial_gl_opening_evidence_review(
       901,9101,evidence_id,9904,true,
       'Attempted same-person document review');
   EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true;END;
   IF NOT blocked THEN RAISE EXCEPTION 'GL_CI_A18_SELF_REVIEW_ACCEPTED';END IF;
   evidence_result:=public.powerhub_financial_gl_opening_evidence_review(
     901,9101,evidence_id,9903,true,
     'Independent supporting document reviewed');
   IF evidence_result->>'status'<>'verified'
     OR (evidence_result->>'replayed')::boolean
   THEN RAISE EXCEPTION 'GL_CI_A18_REVIEW_MISSING';END IF;
   evidence_result:=public.powerhub_financial_gl_opening_evidence_review(
     901,9101,evidence_id,9903,true,
     'Independent supporting document reviewed');
   IF (evidence_result->>'replayed')::boolean IS DISTINCT FROM true THEN
     RAISE EXCEPTION 'GL_CI_A18_REVIEW_REPLAY_DUPLICATES';END IF;
 END LOOP;
 report:=public.powerhub_financial_gl_source_coverage(901,9101,'2026-10');
 IF report->'openingEvidenceAudit'->'evidenceReview'->>'status'
      <> 'EVIDENCE_ATTESTED_DOCUMENT_VERIFICATION_REQUIRED'
 OR (report->'openingEvidenceAudit'->'evidenceReview'->>'allLinesAttested')::boolean
    IS DISTINCT FROM true
 OR (report->'openingEvidenceAudit'->>'sourceSubledgersIndependentlyVerified')::boolean
    IS DISTINCT FROM false
 OR (report->>'isOpeningReconciled')::boolean IS DISTINCT FROM false
 OR report->>'accountingCertification'<>'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'GL_CI_A18_FALSE_DOCUMENT_CUSTODY_CERTIFICATION: %',
  report->'openingEvidenceAudit';END IF;
 -- A5 negative acceptance: a mathematically balanced but unapproved
 -- accrual journal projection must fail source integrity. A zero trial
 -- balance never substitutes for an authoritative approval document.
 INSERT INTO public.financial_gl_entries(tenant_id,site_id,period,source_type,
   source_id,source_revision,operation_key,source_fingerprint,
   accounting_policy_version,posted_by_user_id)
 VALUES(901,9101,'2026-10','accrual_adjustment','999999999',1,
   'gl:accrual:999999999:v1',repeat('0',64),
   'accrual-approved-subledger-v1',9902)
 RETURNING id INTO sid;
 INSERT INTO public.financial_gl_lines(
   entry_id,tenant_id,site_id,account_code,side,amount)
 VALUES(sid,901,9101,'5100','debit',19.99),
       (sid,901,9101,'2100','credit',19.99);
 report:=public.powerhub_financial_gl_source_coverage(901,9101,'2026-10');
 trial:=public.powerhub_financial_gl_trial_balance(901,9101,'2026-10');
 IF (report->'sourceIntegrity'->>'isClean')::boolean IS DISTINCT FROM false
    OR (report->'sourceIntegrity'->>'invalidSources')::int<>1
    OR (report->'sourceIntegrity'->'samples'->0->>'reason')
       IS DISTINCT FROM 'ACCRUAL_NOT_APPROVED_OR_MISSING'
    OR (trial->>'difference')::numeric<>0
    OR (trial->'sourceCoverage'->>'isSourceCoverageComplete')::boolean
       IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'GL_CI_UNAPPROVED_BUT_BALANCED_ACCRUAL_FALSE_PASS: %',
   report->'sourceIntegrity'; END IF;
 SET CONSTRAINTS ALL IMMEDIATE;
END;$assert$;
ROLLBACK;
SELECT 'PASS: source GL invoice, payment, expense, supplier, stock, payroll, service and coverage' AS acceptance;
