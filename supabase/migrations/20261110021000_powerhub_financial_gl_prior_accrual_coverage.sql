-- A7: Fail closed on prior-period operational, draft and approved-unposted accrual
-- sources. Cumulative GL trial balances must never certify a through-period
-- view that omits earlier accrual liabilities. No automatic posting or
-- financial mutation. Requires version 20261110020000.
-- A6: Include approved accrual subledger sources missing general-ledger
-- projection, and unresolved draft adjustment sources, in monthly coverage.
-- Additive forward-only replacement of reporting RPC: never auto-post money.
-- Must follow A5 approved-accrual integrity migration 20261110019000.
-- Override the previous coverage RPC to include source-integrity failures.
-- Phase A3.2 superseding coverage: source-backed operational GL and coalesced stock receipt events.
-- Phase A3: source-completeness diagnostics; NEVER a certified profit statement.
-- A monthly branch report is blocked if financial source documents are not mapped
-- to the GL. This function never silently truncates sources or downloads rows.
-- Audit outstanding pre-period operational source records in one set-based pass
-- per source family (not one recursive coverage call per month).
-- "Through period" GL trial balances require prior source continuity.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_prior_operational_gaps(
 p_tenant_id bigint,p_site_id bigint,p_period text
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $historical$
DECLARE
 v_start timestamptz;v_origin timestamptz;v_origin_date date;
 v_prior_invoices bigint;v_prior_invoice_invalid bigint;
 v_prior_payments bigint;v_prior_payment_cash_mismatch bigint;
 v_prior_expenses bigint;v_prior_supplier bigint;
 v_prior_payroll bigint;v_prior_stock bigint;
 v_prior_service bigint;v_prior_cash bigint;v_prior_perf bigint;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0 OR p_site_id IS NULL OR p_site_id<=0
    OR p_period IS NULL OR p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
    OR NOT EXISTS (SELECT 1 FROM public.sites s WHERE s.id=p_site_id
       AND s.tenant_id=p_tenant_id AND s.status<>'archived')
 THEN RAISE EXCEPTION 'GL_HISTORICAL_INVALID_SCOPE' USING ERRCODE='22023'; END IF;
 v_start:=(p_period||'-01')::timestamp AT TIME ZONE 'Asia/Gaza';
 SELECT min(as_of_date) INTO v_origin_date
 FROM public.financial_gl_opening_batches
 WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND status='posted'
   AND as_of_date <= (p_period||'-01')::date;
 -- With no opening, never treat the prior ledger as empty by assumption.
 v_origin:=coalesce(v_origin_date,'1900-01-01'::date)::timestamp
      AT TIME ZONE 'Asia/Gaza';
 SELECT count(*) FILTER(WHERE i.cycle_end_at IS NULL OR
      i.cycle_start_at IS NULL OR i.cycle_start_at>i.cycle_end_at),
        count(*) FILTER(WHERE i.cycle_end_at IS NOT NULL AND
          i.cycle_start_at IS NOT NULL AND i.cycle_start_at<=i.cycle_end_at
          AND NOT EXISTS(
            SELECT 1 FROM public.financial_gl_entries e
            WHERE e.tenant_id=i.tenant_id AND e.site_id=i.site_id
              AND e.source_type='invoice'
              AND e.source_id=i.id::text AND e.source_revision=1))
 INTO v_prior_invoice_invalid,v_prior_invoices
 FROM public.invoices i
 WHERE i.tenant_id=p_tenant_id AND i.site_id=p_site_id
   AND i.status IN ('issued','overdue','partially_paid','paid')
   AND ((i.cycle_end_at>=v_origin AND i.cycle_end_at<v_start)
     OR ((i.cycle_end_at IS NULL OR i.cycle_start_at IS NULL)
       AND i.issue_date>=v_origin AND i.issue_date<v_start));
 SELECT count(*) FILTER(WHERE NOT EXISTS(
   SELECT 1 FROM public.financial_gl_entries e
   WHERE e.tenant_id=p.tenant_id AND e.site_id=p.site_id
     AND e.source_type='payment' AND e.source_id=p.id::text
     AND e.source_revision=1)),
 count(*) FILTER(WHERE linked.movement_count<>1
    OR linked.correct_count<>1 OR linked.movement_amount<>p.amount
    OR coalesce(p.invoice_applied_amount,0)+coalesce(p.subscriber_credit_amount,0)<>p.amount
    OR p.invoice_applied_amount<0 OR p.subscriber_credit_amount<0)
 INTO v_prior_payments,v_prior_payment_cash_mismatch
 FROM public.payments p
 CROSS JOIN LATERAL (
   SELECT count(*) movement_count,
    count(*) FILTER(WHERE a.tenant_id=p.tenant_id AND a.site_id=p.site_id
       AND a.transaction_type='collection') correct_count,
    coalesce(sum(a.amount),0) movement_amount
   FROM public.account_transactions a
   WHERE a.related_payment_id=p.id AND a.tenant_id=p.tenant_id
 ) linked
 WHERE p.tenant_id=p_tenant_id AND p.site_id=p_site_id
   AND p.status='completed' AND p.paid_at>=v_origin AND p.paid_at<v_start;
 SELECT count(*) INTO v_prior_expenses FROM public.expenses x
 WHERE x.tenant_id=p_tenant_id AND x.site_id=p_site_id
   AND x.category<>'payroll' AND x.occurred_at>=v_origin AND x.occurred_at<v_start
   AND NOT EXISTS (SELECT 1 FROM public.financial_gl_entries e
     WHERE e.tenant_id=x.tenant_id AND e.site_id=x.site_id
       AND e.source_type='expense' AND e.source_id=x.id::text
       AND e.source_revision=1);
 SELECT count(*) INTO v_prior_supplier
 FROM public.supplier_ledger_entries s
 WHERE s.tenant_id=p_tenant_id AND s.site_id=p_site_id
   AND s.occurred_at>=v_origin AND s.occurred_at<v_start
   AND NOT EXISTS (SELECT 1 FROM public.financial_gl_entries e
     WHERE e.tenant_id=s.tenant_id AND e.site_id=s.site_id
       AND e.source_type='supplier_ledger' AND e.source_id=s.id::text
       AND e.source_revision=1);
 SELECT count(*) INTO v_prior_payroll FROM public.payroll_runs p
 WHERE p.tenant_id=p_tenant_id AND p.site_id=p_site_id
  AND p.period>=to_char(v_origin AT TIME ZONE 'Asia/Gaza','YYYY-MM')
  AND p.period<p_period AND
  (p.status='draft' OR (p.status IN ('approved','paid') AND (
      NOT EXISTS(SELECT 1 FROM public.financial_gl_entries e
       WHERE e.tenant_id=p.tenant_id AND e.site_id=p.site_id
        AND e.source_type='payroll' AND e.source_id=p.id::text)
      OR (p.status='paid' AND NOT EXISTS(
       SELECT 1 FROM public.financial_gl_entries e
       WHERE e.tenant_id=p.tenant_id AND e.site_id=p.site_id
        AND e.source_type='payroll_payment' AND e.source_id=p.id::text)))));
 -- Stock receipt/returns are represented by the supplier ledger, and
 -- paired internal transfers are movements of location, not GL expense.
 SELECT count(*) FILTER(WHERE NOT (
   EXISTS(SELECT 1 FROM public.financial_gl_entries g
     WHERE g.tenant_id=m.tenant_id AND g.site_id=m.site_id
       AND g.source_type='stock_movement' AND g.source_id=m.id::text)
   OR (m.movement_type='purchase_receipt' AND EXISTS(
      SELECT 1 FROM public.supplier_ledger_entries sl
      JOIN public.financial_gl_entries gl
        ON gl.tenant_id=sl.tenant_id AND gl.site_id=sl.site_id
       AND gl.source_type='supplier_ledger' AND gl.source_id=sl.id::text
      WHERE sl.tenant_id=m.tenant_id AND sl.site_id=m.site_id
        AND sl.purchase_id=m.purchase_id AND sl.entry_type='purchase'
        AND sl.credit_amount>0 AND sl.credit_amount=(
          SELECT coalesce(sum(sm.total_cost_amount),0)
          FROM public.inventory_stock_movements sm
          WHERE sm.tenant_id=m.tenant_id AND sm.site_id=m.site_id
            AND sm.purchase_id=m.purchase_id AND sm.movement_type='purchase_receipt')))
   OR (m.movement_type='supplier_return' AND EXISTS(
      SELECT 1 FROM public.supplier_ledger_entries sl
      JOIN public.financial_gl_entries gl
        ON gl.tenant_id=sl.tenant_id AND gl.site_id=sl.site_id
       AND gl.source_type='supplier_ledger' AND gl.source_id=sl.id::text
      WHERE sl.tenant_id=m.tenant_id AND sl.site_id=m.site_id
        AND sl.purchase_id=m.purchase_id AND sl.entry_type='supplier_return'
        AND sl.reference_no=m.reference_no
        AND sl.debit_amount>0 AND sl.debit_amount=(
          SELECT coalesce(sum(sm.total_cost_amount),0)
          FROM public.inventory_stock_movements sm
          WHERE sm.tenant_id=m.tenant_id AND sm.site_id=m.site_id
            AND sm.purchase_id=m.purchase_id
            AND sm.reference_no=m.reference_no
            AND sm.movement_type='supplier_return')))
   OR (m.movement_type='issue' AND m.operation_key LIKE 'trf:%:out'
     AND (SELECT count(*) FROM public.inventory_stock_movements paired
       WHERE paired.tenant_id=m.tenant_id AND paired.site_id=m.site_id
         AND paired.movement_type='adjustment_in'
         AND paired.operation_key=left(m.operation_key,length(m.operation_key)-4)||':in'
         AND paired.reference_no=m.reference_no
         AND paired.item_id=m.item_id AND paired.quantity=m.quantity
         AND paired.unit_cost=m.unit_cost
         AND paired.total_cost_amount=m.total_cost_amount
         AND paired.warehouse_id<>m.warehouse_id)=1)
   OR (m.movement_type='adjustment_in' AND m.operation_key LIKE 'trf:%:in'
     AND (SELECT count(*) FROM public.inventory_stock_movements paired
       WHERE paired.tenant_id=m.tenant_id AND paired.site_id=m.site_id
         AND paired.movement_type='issue'
         AND paired.operation_key=left(m.operation_key,length(m.operation_key)-3)||':out'
         AND paired.reference_no=m.reference_no
         AND paired.item_id=m.item_id AND paired.quantity=m.quantity
         AND paired.unit_cost=m.unit_cost
         AND paired.total_cost_amount=m.total_cost_amount
         AND paired.warehouse_id<>m.warehouse_id)=1)
 )) INTO v_prior_stock
 FROM public.inventory_stock_movements m
 WHERE m.tenant_id=p_tenant_id AND m.site_id=p_site_id
 AND m.occurred_at>=v_origin AND m.occurred_at<v_start;
 -- Month-by-month earned-service recognition, across ALL completed prior
 -- service months. Calendar allocations use the identical minor-unit floor
 -- formula as the posting RPC; only positive allocations need recognition.
 WITH scoped AS (
   SELECT i.id,
      (i.cycle_start_at AT TIME ZONE 'Asia/Gaza')::date first_day,
      (i.cycle_end_at AT TIME ZONE 'Asia/Gaza')::date last_day,
      ((i.total_amount-i.tax_amount)*100)::bigint net_minor
   FROM public.invoices i
   WHERE i.tenant_id=p_tenant_id AND i.site_id=p_site_id
    AND i.status IN ('issued','overdue','partially_paid','paid')
    AND i.cycle_start_at IS NOT NULL AND i.cycle_end_at IS NOT NULL
    AND i.cycle_start_at<v_start AND i.cycle_end_at>=v_origin
    AND i.total_amount>=i.tax_amount AND i.tax_amount>=0
    AND i.total_amount=round(i.total_amount,2)
    AND i.tax_amount=round(i.tax_amount,2)
 ), calendar AS (
   SELECT i.id,i.first_day,i.last_day,i.net_minor,
     (i.last_day-i.first_day+1)::bigint service_days,
     month_start::date month_day
   FROM scoped i
   CROSS JOIN LATERAL generate_series(
     date_trunc('month',greatest(i.first_day,(v_origin AT TIME ZONE 'Asia/Gaza')::date)::timestamp),
     date_trunc('month',(v_start AT TIME ZONE 'Asia/Gaza')::date - 1),
     interval '1 month'
   ) month_start
   WHERE i.last_day>=i.first_day
      AND i.last_day-i.first_day+1 BETWEEN 1 AND 3660
      AND month_start::date <= i.last_day
 ), allocations AS (
   SELECT id,month_day,
     (net_minor*((least(last_day,(month_day+interval '1 month - 1 day')::date)
       -first_day+1)::bigint)/service_days)
      -(net_minor*((greatest(first_day,month_day)-first_day)::bigint)/service_days)
       expected_minor
   FROM calendar
 )
 SELECT count(*) INTO v_prior_service
 FROM allocations a
 WHERE a.expected_minor>0 AND NOT EXISTS(
   SELECT 1 FROM public.financial_gl_entries e
   WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
     AND e.source_type='service_recognition'
     AND e.source_id=a.id::text||':'||to_char(a.month_day,'YYYY-MM')
     AND e.source_revision=1);
 SELECT count(*) FILTER(WHERE
    a.related_payment_id IS NULL AND a.related_expense_id IS NULL
    AND a.related_supplier_payment_id IS NULL AND a.related_supplier_return_id IS NULL
    AND a.related_account_id IS NULL),
    count(*) FILTER(WHERE a.reference_no LIKE 'STG-PERF-%'
        OR a.reference_no LIKE 'PH-PERF-%')
 INTO v_prior_cash,v_prior_perf
 FROM public.account_transactions a
 WHERE a.tenant_id=p_tenant_id AND a.site_id=p_site_id
   AND a.occurred_at>=v_origin AND a.occurred_at<v_start;
 RETURN jsonb_build_object(
   'fromOpeningDate',v_origin_date,'priorPeriodExclusive',p_period,
   'invoicesMissingGL',v_prior_invoices,
   'invoicesInvalidCycle',v_prior_invoice_invalid,
   'paymentsMissingGL',v_prior_payments,
   'paymentCollectionMismatches',v_prior_payment_cash_mismatch,
   'expensesMissingGL',v_prior_expenses,
   'supplierLedgerMissingGL',v_prior_supplier,
   'payrollUnresolved',v_prior_payroll,
   'stockMovementsMissingGL',v_prior_stock,
   'serviceRecognitionMissingGL',v_prior_service,
   'unclassifiedAccountMovements',v_prior_cash,
   'performanceFixtureTagged',v_prior_perf,
   'unreconciledCount',v_prior_invoices+v_prior_invoice_invalid+
     v_prior_payments+v_prior_payment_cash_mismatch+
     v_prior_expenses+v_prior_supplier+v_prior_payroll+
     v_prior_stock+v_prior_service+v_prior_cash);
END;
$historical$;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_prior_operational_gaps(bigint,bigint,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_prior_operational_gaps(bigint,bigint,text)
 TO service_role;

CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_source_coverage(
 p_tenant_id bigint,p_site_id bigint,p_period text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $coverage$
DECLARE
 v_start timestamptz;v_end timestamptz;v_day date;
 v_opening_count bigint;v_unposted_opening_count bigint;
 v_opening_date date;
 v_invoice_total bigint;v_invoice_unposted bigint;v_invoice_missing_cycle bigint;
 v_service_recognition_required bigint:=0;v_service_recognition_missing bigint:=0;
 v_payments_total bigint;v_payments_unposted bigint;
 v_payment_ledger_mismatches bigint;v_payment_missing_ledger bigint;
 v_expense_total bigint;v_expense_unposted bigint;
 v_payroll_total bigint;v_payroll_unposted bigint;v_payroll_drafts bigint;
 v_stock_total bigint;v_stock_unposted bigint;
 v_supplier_total bigint;v_supplier_unposted bigint;
 v_cash_moves bigint;v_cash_unclassified bigint;v_cash_perf_fixture bigint;
 v_gl_total bigint;v_gl_broken bigint;v_gl_balance numeric;
 v_missing bigint;v_source_integrity jsonb;
 v_accrual_posted bigint;v_accrual_unposted bigint;v_accrual_drafts bigint;
 v_prior_accrual_posted bigint;v_prior_accrual_unposted bigint;v_prior_accrual_drafts bigint;
 v_prior_operational jsonb;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0 OR
   p_site_id IS NULL OR p_site_id<=0 OR
   p_period IS NULL OR p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' OR
   NOT EXISTS(SELECT 1 FROM public.sites s WHERE s.id=p_site_id
     AND s.tenant_id=p_tenant_id AND s.status<>'archived')
 THEN RAISE EXCEPTION 'GL_COVERAGE_INVALID_SCOPE' USING ERRCODE='22023'; END IF;
 v_day:=(p_period||'-01')::date;
 v_start:=v_day::timestamp AT TIME ZONE 'Asia/Gaza';
 v_end:=(v_day+INTERVAL '1 month')::timestamp AT TIME ZONE 'Asia/Gaza';
 SELECT count(*) FILTER(WHERE status='posted' AND as_of_date<=v_day),
        count(*) FILTER(WHERE status='draft'),
        min(as_of_date) FILTER(WHERE status='posted' AND as_of_date<=v_day)
 INTO v_opening_count,v_unposted_opening_count,v_opening_date
 FROM public.financial_gl_opening_batches
 WHERE tenant_id=p_tenant_id AND site_id=p_site_id;
 -- A6: signed adjustments that are approved in the source subledger
 -- but not yet projected to GL must also block an apparently clean trial.
 -- Draft adjustment evidence remains visible instead of disappearing.
 SELECT count(*) FILTER(WHERE j.status='posted'),
        count(*) FILTER(WHERE j.status='posted' AND NOT EXISTS(
          SELECT 1 FROM public.financial_gl_entries e
          WHERE e.tenant_id=j.tenant_id AND e.site_id=j.site_id
            AND e.source_type='accrual_adjustment'
            AND e.source_id=j.id::text AND e.source_revision=1)),
        count(*) FILTER(WHERE j.status='draft')
 INTO v_accrual_posted,v_accrual_unposted,v_accrual_drafts
 FROM public.financial_accrual_journals j
 WHERE j.tenant_id=p_tenant_id AND j.site_id=p_site_id AND j.period=p_period;
 -- A7: fiscal continuity: earlier approved journals without GL are
 -- a missing source even when the current month has zero source gaps.
 -- Compare all earlier periods up to (not including) the queried period.
 -- Do not mark historical source gaps as clean, and do not truncate counts.
 SELECT count(*) FILTER(WHERE j.status='posted'),
        count(*) FILTER(WHERE j.status='posted' AND NOT EXISTS(
          SELECT 1 FROM public.financial_gl_entries e
          WHERE e.tenant_id=j.tenant_id AND e.site_id=j.site_id
            AND e.source_type='accrual_adjustment'
            AND e.source_id=j.id::text AND e.source_revision=1)),
        count(*) FILTER(WHERE j.status='draft')
 INTO v_prior_accrual_posted,v_prior_accrual_unposted,v_prior_accrual_drafts
 FROM public.financial_accrual_journals j
 WHERE j.tenant_id=p_tenant_id AND j.site_id=p_site_id
   AND j.period<p_period;
 SELECT count(*),
        count(*) FILTER (WHERE (i.cycle_start_at IS NULL OR i.cycle_end_at IS NULL
          OR i.cycle_start_at>i.cycle_end_at)),
        count(*) FILTER(WHERE NOT EXISTS(
          SELECT 1 FROM public.financial_gl_entries g
          WHERE g.tenant_id=i.tenant_id AND g.site_id=i.site_id
            AND g.source_type='invoice'
            AND (g.source_id=i.id::text OR g.source_id=i.id::text||':'||p_period)))
 INTO v_invoice_total,v_invoice_missing_cycle,v_invoice_unposted
 FROM public.invoices i
 WHERE i.tenant_id=p_tenant_id AND i.site_id=p_site_id
  AND i.status IN ('issued','overdue','partially_paid','paid')
  AND i.cycle_start_at<v_end AND i.cycle_end_at>=v_start;
 -- Missing-cycle invoices issued in this period are counted separately,
 -- because they cannot be allocated by service month.
 SELECT v_invoice_missing_cycle+count(*) INTO v_invoice_missing_cycle
 FROM public.invoices i WHERE i.tenant_id=p_tenant_id AND i.site_id=p_site_id
 AND i.status IN ('issued','overdue','partially_paid','paid')
 AND (i.cycle_start_at IS NULL OR i.cycle_end_at IS NULL)
 AND i.issue_date>=v_start AND i.issue_date<v_end;
 -- For fully completed months, a posted invoice alone does not prove
 -- earned-service recognition. Evaluate the same Gaza calendar-day, integer-
 -- minor-unit formula as the dedicated recognition RPC. No future-month
 -- revenue recognition is required, and a zero-cent allocation needs no GL.
 IF (v_day+INTERVAL '1 month - 1 day')::date
    < (now() AT TIME ZONE 'Asia/Gaza')::date THEN
   WITH scoped AS (
     SELECT i.id, i.total_amount, i.tax_amount,
       (i.cycle_start_at AT TIME ZONE 'Asia/Gaza')::date first_day,
       (i.cycle_end_at AT TIME ZONE 'Asia/Gaza')::date last_day
     FROM public.invoices i
     WHERE i.tenant_id=p_tenant_id AND i.site_id=p_site_id
       AND i.status IN ('issued','overdue','partially_paid','paid')
       AND i.cycle_start_at IS NOT NULL AND i.cycle_end_at IS NOT NULL
       AND i.cycle_end_at>=v_start AND i.cycle_start_at<v_end
       AND i.total_amount IS NOT NULL AND i.tax_amount IS NOT NULL
       AND i.total_amount>=i.tax_amount AND i.tax_amount>=0
       AND i.total_amount=round(i.total_amount,2)
       AND i.tax_amount=round(i.tax_amount,2)
   ), calendar AS (
     SELECT id, first_day,last_day,
       ((total_amount-tax_amount)*100)::bigint net_minor,
       (last_day-first_day+1)::bigint service_days
     FROM scoped
     WHERE last_day>=v_day AND first_day<(v_day+INTERVAL '1 month')::date
       AND last_day>=first_day AND last_day-first_day+1 BETWEEN 1 AND 3660
   ), portions AS (
     SELECT id,
       (net_minor*((least(last_day,(v_day+INTERVAL '1 month - 1 day')::date)
         -first_day+1)::bigint)/service_days)
       -(net_minor*((greatest(first_day,v_day)-first_day)::bigint)/service_days)
       AS expected_minor
     FROM calendar
   )
   SELECT count(*),count(*) FILTER(WHERE NOT EXISTS(
      SELECT 1 FROM public.financial_gl_entries gl
      WHERE gl.tenant_id=p_tenant_id AND gl.site_id=p_site_id
       AND gl.source_type='service_recognition'
       AND gl.source_revision=1
       AND gl.source_id=portions.id::text||':'||p_period))
   INTO v_service_recognition_required,v_service_recognition_missing
   FROM portions WHERE expected_minor>0;
 END IF;
 SELECT count(*),count(*) FILTER(WHERE NOT EXISTS(
   SELECT 1 FROM public.financial_gl_entries g
   WHERE g.tenant_id=p.tenant_id AND g.site_id=p.site_id
   AND g.source_type='payment' AND g.source_id=p.id::text))
 INTO v_payments_total,v_payments_unposted
 FROM public.payments p
 WHERE p.tenant_id=p_tenant_id AND p.site_id=p_site_id
 AND p.status='completed' AND p.paid_at>=v_start AND p.paid_at<v_end;
 -- Audit the ACTUAL payment-to-company-account movement, without
 -- counting the same collection again as a second revenue event.
 -- One completed payment must have exactly one collection movement with
 -- matching tenant, site and amount. A link to another tenant is invalid.
 SELECT count(*) FILTER(WHERE linked.movement_count=0),
        count(*) FILTER(WHERE linked.movement_count<>1 OR
          linked.correct_count<>1 OR linked.movement_amount<>p.amount OR
          coalesce(p.invoice_applied_amount,0)+
            coalesce(p.subscriber_credit_amount,0)<>p.amount OR
          p.invoice_applied_amount<0 OR p.subscriber_credit_amount<0
        )
 INTO v_payment_missing_ledger,v_payment_ledger_mismatches
 FROM public.payments p
 CROSS JOIN LATERAL (
   SELECT count(*) AS movement_count,
      count(*) FILTER(WHERE a.tenant_id=p.tenant_id AND
        a.site_id=p.site_id AND a.transaction_type='collection') AS correct_count,
      coalesce(sum(a.amount),0) AS movement_amount
   FROM public.account_transactions a
   WHERE a.related_payment_id=p.id AND a.tenant_id=p.tenant_id
 ) linked
 WHERE p.tenant_id=p_tenant_id AND p.site_id=p_site_id
   AND p.status='completed' AND p.paid_at>=v_start AND p.paid_at<v_end;
 SELECT count(*),count(*) FILTER(WHERE NOT EXISTS(
   SELECT 1 FROM public.financial_gl_entries g
   WHERE g.tenant_id=x.tenant_id AND g.site_id=x.site_id
   AND g.source_type='expense' AND g.source_id=x.id::text))
 INTO v_expense_total,v_expense_unposted FROM public.expenses x
 WHERE x.tenant_id=p_tenant_id AND x.site_id=p_site_id
 AND x.occurred_at>=v_start AND x.occurred_at<v_end
 AND x.category<>'payroll';
 SELECT count(*) FILTER(WHERE status IN ('approved','paid')),
        count(*) FILTER(WHERE status IN ('approved','paid') AND
          (NOT EXISTS(
            SELECT 1 FROM public.financial_gl_entries g
            WHERE g.tenant_id=p.tenant_id AND g.site_id=p.site_id
              AND g.source_type='payroll' AND g.source_id=p.id::text)
           OR (p.status='paid' AND NOT EXISTS(
             SELECT 1 FROM public.financial_gl_entries g
             WHERE g.tenant_id=p.tenant_id AND g.site_id=p.site_id
               AND g.source_type='payroll_payment' AND g.source_id=p.id::text)))),
        count(*) FILTER(WHERE status='draft')
 INTO v_payroll_total,v_payroll_unposted,v_payroll_drafts
 FROM public.payroll_runs p WHERE p.tenant_id=p_tenant_id
 AND p.site_id=p_site_id AND p.period=p_period;
 -- Receipt and supplier return have one authoritative supplier-ledger event
 -- (purchase or return). Their individual stock rows are not GL postings.
 -- All receipt rows must add up exactly to their supplier event before coverage
 -- can be marked complete; this avoids counting purchases twice.
 SELECT count(*),count(*) FILTER(WHERE NOT (
   EXISTS(SELECT 1 FROM public.financial_gl_entries g
     WHERE g.tenant_id=m.tenant_id AND g.site_id=m.site_id
       AND g.source_type='stock_movement' AND g.source_id=m.id::text)
   OR
   (m.movement_type='purchase_receipt' AND EXISTS(
      SELECT 1 FROM public.supplier_ledger_entries sl
      JOIN public.financial_gl_entries gl
        ON gl.tenant_id=sl.tenant_id AND gl.site_id=sl.site_id
       AND gl.source_type='supplier_ledger' AND gl.source_id=sl.id::text
      WHERE sl.tenant_id=m.tenant_id AND sl.site_id=m.site_id
        AND sl.purchase_id=m.purchase_id AND sl.entry_type='purchase'
        AND sl.credit_amount>0
        AND sl.credit_amount=(
          SELECT coalesce(sum(sm.total_cost_amount),0)
          FROM public.inventory_stock_movements sm
          WHERE sm.tenant_id=m.tenant_id AND sm.site_id=m.site_id
            AND sm.purchase_id=m.purchase_id AND sm.movement_type='purchase_receipt')))
   OR
   (m.movement_type='supplier_return' AND EXISTS(
      SELECT 1 FROM public.supplier_ledger_entries sl
      JOIN public.financial_gl_entries gl
        ON gl.tenant_id=sl.tenant_id AND gl.site_id=sl.site_id
       AND gl.source_type='supplier_ledger' AND gl.source_id=sl.id::text
      WHERE sl.tenant_id=m.tenant_id AND sl.site_id=m.site_id
        AND sl.purchase_id=m.purchase_id AND sl.entry_type='supplier_return'
        AND sl.reference_no=m.reference_no
        AND sl.debit_amount>0 AND sl.debit_amount=(
          SELECT coalesce(sum(sm.total_cost_amount),0)
          FROM public.inventory_stock_movements sm
          WHERE sm.tenant_id=m.tenant_id AND sm.site_id=m.site_id
            AND sm.purchase_id=m.purchase_id
            AND sm.reference_no=m.reference_no
            AND sm.movement_type='supplier_return')))
   OR
   (m.movement_type='issue' AND m.operation_key LIKE 'trf:%:out'
     AND (SELECT count(*) FROM public.inventory_stock_movements paired
       WHERE paired.tenant_id=m.tenant_id AND paired.site_id=m.site_id
         AND paired.movement_type='adjustment_in'
         AND paired.operation_key=left(m.operation_key,length(m.operation_key)-4)||':in'
         AND paired.reference_no=m.reference_no
         AND paired.item_id=m.item_id AND paired.quantity=m.quantity
         AND paired.unit_cost=m.unit_cost
         AND paired.total_cost_amount=m.total_cost_amount
         AND paired.warehouse_id<>m.warehouse_id)=1)
   OR
   (m.movement_type='adjustment_in' AND m.operation_key LIKE 'trf:%:in'
     AND (SELECT count(*) FROM public.inventory_stock_movements paired
       WHERE paired.tenant_id=m.tenant_id AND paired.site_id=m.site_id
         AND paired.movement_type='issue'
         AND paired.operation_key=left(m.operation_key,length(m.operation_key)-3)||':out'
         AND paired.reference_no=m.reference_no
         AND paired.item_id=m.item_id AND paired.quantity=m.quantity
         AND paired.unit_cost=m.unit_cost
         AND paired.total_cost_amount=m.total_cost_amount
         AND paired.warehouse_id<>m.warehouse_id)=1)
 ))
 INTO v_stock_total,v_stock_unposted
 FROM public.inventory_stock_movements m
 WHERE m.tenant_id=p_tenant_id AND m.site_id=p_site_id
 AND m.occurred_at>=v_start AND m.occurred_at<v_end;
 SELECT count(*),count(*) FILTER(WHERE NOT EXISTS(
   SELECT 1 FROM public.financial_gl_entries g
   WHERE g.tenant_id=s.tenant_id AND g.site_id=s.site_id
   AND g.source_type='supplier_ledger' AND g.source_id=s.id::text))
 INTO v_supplier_total,v_supplier_unposted
 FROM public.supplier_ledger_entries s
 WHERE s.tenant_id=p_tenant_id AND s.site_id=p_site_id
 AND s.occurred_at>=v_start AND s.occurred_at<v_end;
 -- Report all movements, not only the first 5,000; linked movements may
 -- share one business-event GL posting, so don't sum them as new revenue.
 SELECT count(*),count(*) FILTER(WHERE
     a.related_payment_id IS NULL AND a.related_expense_id IS NULL
     AND a.related_supplier_payment_id IS NULL AND a.related_supplier_return_id IS NULL
     AND a.related_account_id IS NULL),
     count(*) FILTER(WHERE a.reference_no LIKE 'STG-PERF-%'
        OR a.reference_no LIKE 'PH-PERF-%')
 INTO v_cash_moves,v_cash_unclassified,v_cash_perf_fixture
 FROM public.account_transactions a
 WHERE a.tenant_id=p_tenant_id AND a.site_id=p_site_id
 AND a.occurred_at>=v_start AND a.occurred_at<v_end;
 SELECT count(*),count(*) FILTER (WHERE z.cnt<2 OR z.net<>0),
        COALESCE(sum(z.net),0)
 INTO v_gl_total,v_gl_broken,v_gl_balance
 FROM (
   SELECT e.id,count(l.id) cnt,
       coalesce(sum(CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END),0) net
   FROM public.financial_gl_entries e LEFT JOIN public.financial_gl_lines l
     ON l.entry_id=e.id AND l.tenant_id=e.tenant_id AND l.site_id=e.site_id
   WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id AND e.period=p_period
   GROUP BY e.id
 ) z;
 v_source_integrity:=public.powerhub_financial_gl_source_integrity(
   p_tenant_id,p_site_id,p_period);
 v_prior_operational:=public.powerhub_financial_gl_prior_operational_gaps(
   p_tenant_id,p_site_id,p_period);
 v_missing:=v_invoice_unposted+v_invoice_missing_cycle+v_payments_unposted+
   v_expense_unposted+v_payroll_unposted+v_payroll_drafts+
   v_stock_unposted+v_supplier_unposted+v_cash_unclassified+v_gl_broken+
   v_payment_ledger_mismatches+v_service_recognition_missing+
   v_accrual_unposted+v_accrual_drafts+
   v_prior_accrual_unposted+v_prior_accrual_drafts+
   (v_prior_operational->>'unreconciledCount')::bigint+
   (v_source_integrity->>'driftedEntries')::bigint+
   (v_source_integrity->>'invalidSources')::bigint+
   (v_source_integrity->>'unauditedEntries')::bigint;
 RETURN jsonb_build_object(
  'tenantId',p_tenant_id,'siteId',p_site_id,'period',p_period,
  'opening',jsonb_build_object('postedCount',v_opening_count,
     'draftCount',v_unposted_opening_count,'asOfDate',v_opening_date),
  'sources',jsonb_build_object(
    'priorOperationalSources',v_prior_operational,
    'accrualAdjustments',jsonb_build_object('approved',v_accrual_posted,
      'drafts',v_accrual_drafts,'missingGL',v_accrual_unposted),
    'priorAccrualAdjustments',jsonb_build_object(
      'approved',v_prior_accrual_posted,'drafts',v_prior_accrual_drafts,
      'missingGL',v_prior_accrual_unposted),
    'invoices',jsonb_build_object('inScope',v_invoice_total,
      'missingGL',v_invoice_unposted,'missingCycle',v_invoice_missing_cycle),
    'serviceRecognition',jsonb_build_object(
      'monthCompleted',(v_day+INTERVAL '1 month - 1 day')::date
        < (now() AT TIME ZONE 'Asia/Gaza')::date,
      'requiredInvoiceMonths',v_service_recognition_required,
      'missingGL',v_service_recognition_missing),
    'payments',jsonb_build_object('inScope',v_payments_total,
      'missingGL',v_payments_unposted,
      'withoutLinkedCollection',v_payment_missing_ledger,
      'linkedCollectionMismatch',v_payment_ledger_mismatches),
    'expenses',jsonb_build_object('inScope',v_expense_total,'missingGL',v_expense_unposted),
    'payroll',jsonb_build_object('approvedOrPaid',v_payroll_total,
      'missingGL',v_payroll_unposted,'drafts',v_payroll_drafts),
    'stockMovements',jsonb_build_object('inScope',v_stock_total,'missingGL',v_stock_unposted),
    'supplierLedger',jsonb_build_object('inScope',v_supplier_total,'missingGL',v_supplier_unposted),
    'companyAccountMovements',jsonb_build_object('inScope',v_cash_moves,
      'unclassified',v_cash_unclassified,
      'performanceFixtureTagged',v_cash_perf_fixture)),
  'sourceIntegrity',v_source_integrity,
  'gl',jsonb_build_object('entries',v_gl_total,'unbalancedEntries',v_gl_broken,
    'signedBalance',v_gl_balance),
  'unreconciledSourceCount',v_missing,
  'isOpeningReconciled',v_opening_count=1 AND v_unposted_opening_count=0,
  'isGLStructurallyBalanced',v_gl_broken=0 AND v_gl_balance=0,
  'isSourceCoverageComplete',v_missing=0 AND (v_source_integrity->>'isClean')::boolean
    AND v_opening_count=1
    AND v_unposted_opening_count=0,
  'isCompleteAccrualStatement',false,'isFinalProfit',false,
  'accountingCertification','NOT_CERTIFIED',
  'limitation','Operational movement classification, source fingerprints and opening subledger reconciliation must all pass before final certification');
END;
$coverage$;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_source_coverage(bigint,bigint,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_source_coverage(bigint,bigint,text)
 TO service_role;
NOTIFY pgrst,'reload schema';
