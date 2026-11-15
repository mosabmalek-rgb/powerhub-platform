-- D23: October 2026 service-versus-issue cut-off, GL and cash provenance.
-- Diagnostic acceptance on the installed Staging fixture ONLY.
-- No DDL, no UPDATE, no financial correction, no certification.
-- Test hardens the unresolved accounting decision; does not solve it.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30000ms';
DO $d23$
DECLARE
 v_invoice public.invoices%ROWTYPE;
 entry public.financial_gl_entries%ROWTYPE;
 journal_count bigint;
 line_count bigint;
 balance numeric;
 v_oct_count bigint;
 v_oct_gross numeric;
 v_oct_late_count bigint;
 v_oct_late_gross numeric;
 v_oct_recognized_on_oct numeric;
 v_oct_deferred_to_nov numeric;
 v_cash_count bigint;
 v_cash_paid numeric;
 v_review jsonb;
 v_stmt jsonb;
BEGIN
 IF current_database() <> 'postgres'
 OR NOT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations
    WHERE version='20261114203000')
 OR (SELECT count(*) FROM public.financial_gl_entries) <> 25
 OR (SELECT count(*) FROM public.financial_gl_lines) <> 51
 OR (SELECT count(*) FROM public.financial_accrual_period_reviews) <> 0
 THEN RAISE EXCEPTION 'D23_STAGING_FIXTURE_NOT_VERIFIED';END IF;

 SELECT * INTO STRICT v_invoice FROM public.invoices
 WHERE id=31 AND tenant_id=1 AND site_id=1;
 IF v_invoice.status IS DISTINCT FROM 'partially_paid'
 OR (v_invoice.cycle_start_at AT TIME ZONE 'Asia/Gaza')::date <> DATE '2026-10-01'
 OR (v_invoice.cycle_end_at AT TIME ZONE 'Asia/Gaza')::date <> DATE '2026-10-31'
 OR (v_invoice.issue_date AT TIME ZONE 'Asia/Gaza')::date <> DATE '2026-11-01'
 OR v_invoice.total_amount <> 2471.50
 OR v_invoice.paid_amount <> 500.00
 THEN RAISE EXCEPTION 'D23_INVOICE31_CUTOFF_SOURCE_CHANGED';END IF;

 SELECT count(*),coalesce(sum(total_amount),0),
 count(*) FILTER(WHERE (issue_date AT TIME ZONE 'Asia/Gaza')::date
                      NOT BETWEEN DATE '2026-10-01' AND DATE '2026-10-31'),
 coalesce(sum(total_amount) FILTER(WHERE (issue_date AT TIME ZONE 'Asia/Gaza')::date
                      NOT BETWEEN DATE '2026-10-01' AND DATE '2026-10-31'),0)
 INTO v_oct_count,v_oct_gross,v_oct_late_count,v_oct_late_gross
 FROM public.invoices WHERE tenant_id=1 AND site_id=1
  AND status IN ('issued','overdue','partially_paid','paid')
  AND (cycle_end_at AT TIME ZONE 'Asia/Gaza')::date
       BETWEEN DATE '2026-10-01' AND DATE '2026-10-31';
 IF v_oct_count<>3 OR v_oct_gross<>2621.50
    OR v_oct_late_count<>1 OR v_oct_late_gross<>2471.50
 THEN RAISE EXCEPTION 'D23_COHORT_CHANGED';END IF;

 SELECT * INTO STRICT entry FROM public.financial_gl_entries
 WHERE tenant_id=1 AND site_id=1 AND source_type='invoice' AND source_id='31';
 IF entry.id<>849 OR entry.period IS DISTINCT FROM '2026-11'
 OR entry.accounting_policy_version IS DISTINCT FROM 'invoice-receivable-v1-defer-service'
 OR entry.reverses_entry_id IS NOT NULL
 THEN RAISE EXCEPTION 'D23_GL31_POSTING_PERIOD_OR_POLICY_CHANGED';END IF;
 SELECT count(*),coalesce(sum(CASE WHEN side='debit' THEN amount ELSE -amount END),0)
 INTO line_count,balance FROM public.financial_gl_lines WHERE entry_id=entry.id;
 IF line_count<>2 OR balance<>0 OR
 (SELECT count(*) FROM public.financial_gl_lines
     WHERE entry_id=entry.id AND account_code='1200' AND side='debit' AND amount=2471.50)<>1
 OR (SELECT count(*) FROM public.financial_gl_lines
     WHERE entry_id=entry.id AND account_code='2200' AND side='credit' AND amount=2471.50)<>1
 THEN RAISE EXCEPTION 'D23_GL_DEFERRED_RECEIVABLE_NOT_BALANCED'; END IF;

 SELECT count(*),coalesce(sum(invoice_applied_amount),0)
 INTO v_cash_count,v_cash_paid
 FROM public.payments WHERE tenant_id=1 AND site_id=1 AND invoice_id=31
 AND status='completed';
 IF v_cash_count<>1 OR v_cash_paid<>500.00
 THEN RAISE EXCEPTION 'D23_INVOICE31_CASH_PROVENANCE_CHANGED'; END IF;

 SELECT coalesce(sum(i.total_amount) FILTER(WHERE e.period='2026-10'),0),
 coalesce(sum(i.total_amount) FILTER(WHERE e.period='2026-11'),0)
 INTO v_oct_recognized_on_oct,v_oct_deferred_to_nov
 FROM public.invoices i JOIN public.financial_gl_entries e
 ON e.tenant_id=i.tenant_id AND e.site_id=i.site_id
 AND e.source_type='invoice' AND e.source_id=i.id::text
 WHERE i.tenant_id=1 AND i.site_id=1
 AND i.status IN('issued','overdue','partially_paid','paid')
 AND (i.cycle_end_at AT TIME ZONE 'Asia/Gaza')::date
 BETWEEN DATE '2026-10-01' AND DATE '2026-10-31';
 IF v_oct_recognized_on_oct<>150.00 OR v_oct_deferred_to_nov<>2471.50
 OR v_oct_recognized_on_oct+v_oct_deferred_to_nov<>v_oct_gross
 THEN RAISE EXCEPTION 'D23_GL_OCTOBER_SERVICE_PERIOD_SPLIT_CHANGED';END IF;

 v_stmt:=public.powerhub_financial_accrual_month_statement(1,1,'2026-10',now());
 v_review:=public.powerhub_financial_accrual_period_review_status(1,1,'2026-10');
 IF (v_stmt->>'issuedOutsideServiceMonthCount')::int<>1
 OR (v_stmt->>'serviceBillingExTax')::numeric<>2621.50
 OR v_stmt->>'isFinalProfit' IS DISTINCT FROM 'false'
 OR v_stmt->>'isCompleteAccrualStatement' IS DISTINCT FROM 'false'
 OR v_review->>'status' IS DISTINCT FROM 'unprepared'
 OR v_review->>'isCertifiedProfit' IS DISTINCT FROM 'false'
 THEN RAISE EXCEPTION 'D23_FALSE_OCTOBER_CUTOFF_CERTIFICATION';END IF;
END $d23$;
ROLLBACK;
SELECT 'D23_OCTOBER_SERVICE_ISSUE_GL_CASH_CUTOFF_BLOCKER_CONFIRMED_NOT_CERTIFIED' AS result;