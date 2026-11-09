-- A4: fail-closed GL source integrity audit, with source evidence and actual GL lines.
-- No backfill, no client execute, no journal mutation.
-- Checks ALL posted through-period GL entries; only diagnostic samples are bounded.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_source_integrity(
 p_tenant_id bigint,p_site_id bigint,p_period text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $integrity$
DECLARE
 v_entry public.financial_gl_entries%ROWTYPE;
 v_invoice public.invoices%ROWTYPE;
 v_invoice_gl public.financial_gl_entries%ROWTYPE;
 v_plan jsonb; v_invoice_plan jsonb;
 v_checked bigint:=0; v_drifted bigint:=0;
 v_invalid bigint:=0; v_unverified bigint:=0;
 v_samples jsonb:='[]'::jsonb;
 v_reason text; v_bad_lines boolean;
 v_invoice_id bigint; v_month date; v_last date;
 v_first_service date; v_last_service date;
 v_days bigint; v_net_minor bigint; v_through bigint; v_prior bigint;
 v_amount_minor bigint; v_amount numeric; v_hash text;
 v_line_count bigint; v_matching_lines bigint;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0 OR p_site_id IS NULL OR p_site_id<=0
    OR p_period IS NULL OR p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
    OR NOT EXISTS (SELECT 1 FROM public.sites s
      WHERE s.id=p_site_id AND s.tenant_id=p_tenant_id AND s.status<>'archived')
 THEN RAISE EXCEPTION 'GL_INTEGRITY_INVALID_SCOPE' USING ERRCODE='22023'; END IF;
 FOR v_entry IN SELECT e.* FROM public.financial_gl_entries e
   WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
     AND e.period<=p_period
   ORDER BY e.id
 LOOP
   v_reason:=NULL;
   IF v_entry.source_type IN
      ('invoice','payment','expense','supplier_ledger',
       'stock_movement','payroll','payroll_payment') THEN
     v_checked:=v_checked+1;
     IF v_entry.source_id !~ '^[0-9]{1,18}$' OR v_entry.source_revision<>1 THEN
       v_reason:='INVALID_SOURCE_ID_OR_REVISION';
       v_invalid:=v_invalid+1;
     ELSE
       BEGIN
         v_plan:=public.powerhub_financial_gl_source_plan(
           p_tenant_id,p_site_id,v_entry.source_type,v_entry.source_id::bigint);
         SELECT
           EXISTS(
             SELECT x->>'code' AS code,x->>'side' AS side,
               (x->>'amount')::numeric AS amount,count(*) AS n
             FROM jsonb_array_elements(v_plan->'lines') x
             GROUP BY 1,2,3
             EXCEPT
             SELECT l.account_code,l.side,l.amount,count(*)
             FROM public.financial_gl_lines l WHERE l.entry_id=v_entry.id
             GROUP BY 1,2,3)
           OR EXISTS(
             SELECT l.account_code,l.side,l.amount,count(*)
             FROM public.financial_gl_lines l WHERE l.entry_id=v_entry.id
             GROUP BY 1,2,3
             EXCEPT
             SELECT x->>'code',x->>'side',(x->>'amount')::numeric,count(*)
             FROM jsonb_array_elements(v_plan->'lines') x GROUP BY 1,2,3)
         INTO v_bad_lines;
         IF v_entry.source_fingerprint IS DISTINCT FROM v_plan->>'sourceFingerprint'
           OR v_entry.period IS DISTINCT FROM v_plan->>'period'
           OR v_entry.accounting_policy_version IS DISTINCT FROM v_plan->>'policyVersion'
           OR v_entry.reverses_entry_id IS DISTINCT FROM
             (v_plan->>'reversesEntryId')::bigint
           OR v_entry.operation_key IS DISTINCT FROM
              'gl:source:'||v_entry.source_type||':'||v_entry.source_id||':v1'
           OR v_bad_lines THEN
           v_reason:='SOURCE_FINGERPRINT_OR_LINES_CHANGED';
           v_drifted:=v_drifted+1;
         END IF;
       EXCEPTION
         WHEN SQLSTATE '22023' OR SQLSTATE '23505' OR SQLSTATE '23514' THEN
           v_reason:='SOURCE_NOT_VERIFIABLE';
           v_invalid:=v_invalid+1;
       END;
     END IF;
   ELSIF v_entry.source_type='service_recognition' THEN
     v_checked:=v_checked+1;
     IF v_entry.source_id !~ '^[0-9]{1,18}:[0-9]{4}-(0[1-9]|1[0-2])$'
        OR v_entry.source_revision<>1
        OR split_part(v_entry.source_id,':',2)<>v_entry.period THEN
       v_reason:='SERVICE_SOURCE_ID_INVALID';
       v_invalid:=v_invalid+1;
     ELSE
       BEGIN
         v_invoice_id:=split_part(v_entry.source_id,':',1)::bigint;
         SELECT * INTO v_invoice FROM public.invoices i
           WHERE i.id=v_invoice_id AND i.tenant_id=p_tenant_id
             AND i.site_id=p_site_id;
         IF NOT FOUND THEN
           RAISE EXCEPTION 'GL_INTEGRITY_INVOICE_MISSING' USING ERRCODE='22023';
         END IF;
         v_invoice_plan:=public.powerhub_financial_gl_source_plan(
           p_tenant_id,p_site_id,'invoice',v_invoice_id);
         SELECT * INTO v_invoice_gl FROM public.financial_gl_entries e
           WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
             AND e.source_type='invoice' AND e.source_id=v_invoice_id::text
             AND e.source_revision=1;
         IF NOT FOUND OR
            v_invoice_gl.source_fingerprint IS DISTINCT FROM
               v_invoice_plan->>'sourceFingerprint' OR
            v_invoice_gl.accounting_policy_version IS DISTINCT FROM
               'invoice-receivable-v1-defer-service' THEN
           RAISE EXCEPTION 'GL_INTEGRITY_INVOICE_NOT_DEFERRED'
             USING ERRCODE='22023';
         END IF;
         v_month:=(v_entry.period||'-01')::date;
         v_last:=(v_month+interval '1 month - 1 day')::date;
         v_first_service:=(v_invoice.cycle_start_at AT TIME ZONE 'Asia/Gaza')::date;
         v_last_service:=(v_invoice.cycle_end_at AT TIME ZONE 'Asia/Gaza')::date;
         v_days:=(v_last_service-v_first_service+1)::bigint;
         IF v_days NOT BETWEEN 1 AND 3660 OR v_first_service>v_last
            OR v_last_service<v_month OR v_first_service>v_last
         THEN RAISE EXCEPTION 'GL_INTEGRITY_SERVICE_PERIOD_INVALID'
           USING ERRCODE='22023'; END IF;
         v_net_minor:=((v_invoice.total_amount-v_invoice.tax_amount)*100)::bigint;
         v_through:=v_net_minor*((least(v_last_service,v_last)
           -v_first_service+1)::bigint)/v_days;
         v_prior:=v_net_minor*((greatest(v_first_service,v_month)
           -v_first_service)::bigint)/v_days;
         v_amount_minor:=v_through-v_prior;
         IF v_amount_minor<=0 THEN
           RAISE EXCEPTION 'GL_INTEGRITY_SERVICE_ALLOCATION_INVALID'
             USING ERRCODE='22023';
         END IF;
         v_amount:=v_amount_minor::numeric/100;
         v_hash:=encode(sha256(convert_to(jsonb_build_object(
           'invoice',v_invoice.id,'period',v_entry.period,
           'invoiceSourceHash',v_invoice_plan->>'sourceFingerprint',
           'minorUnits',v_amount_minor,
           'policy','gaza-invoice-service-calendar-days-v1'
         )::text,'UTF8')),'hex');
         SELECT count(*),count(*) FILTER (WHERE
           (l.account_code='2200' AND l.side='debit' AND l.amount=v_amount)
           OR (l.account_code='4100' AND l.side='credit' AND l.amount=v_amount))
           INTO v_line_count,v_matching_lines
         FROM public.financial_gl_lines l WHERE l.entry_id=v_entry.id;
         IF v_entry.source_fingerprint IS DISTINCT FROM v_hash
           OR v_entry.accounting_policy_version IS DISTINCT FROM
             'gaza-invoice-service-calendar-days-v1'
           OR v_entry.operation_key IS DISTINCT FROM
             'gl:service:'||v_entry.source_id||':v1'
           OR v_line_count<>2 OR v_matching_lines<>2
         THEN
           v_reason:='SERVICE_FINGERPRINT_OR_LINES_CHANGED';
           v_drifted:=v_drifted+1;
         END IF;
       EXCEPTION
         WHEN SQLSTATE '22023' OR SQLSTATE '23505' OR SQLSTATE '23514' THEN
           v_reason:='SERVICE_NOT_VERIFIABLE';
           v_invalid:=v_invalid+1;
       END;
     END IF;
   ELSIF v_entry.source_type='opening_balance' THEN
     v_checked:=v_checked+1;
     IF NOT EXISTS (
       SELECT 1 FROM public.financial_gl_opening_batches b
       WHERE b.tenant_id=p_tenant_id AND b.site_id=p_site_id
         AND b.id::text=v_entry.source_id AND b.status='posted'
         AND b.source_fingerprint=v_entry.source_fingerprint
     ) THEN
       v_reason:='OPENING_GL_SOURCE_MISMATCH';
       v_drifted:=v_drifted+1;
     END IF;
   ELSE
     -- A type not yet audited is never interpreted as a clean source.
     -- Accrual adjustments remain separately audited in phase A1.
     IF v_entry.source_type<>'accrual_adjustment' THEN
       v_unverified:=v_unverified+1;
       v_reason:='GL_SOURCE_TYPE_NOT_AUDITED';
     END IF;
   END IF;
   IF v_reason IS NOT NULL AND jsonb_array_length(v_samples)<12 THEN
     v_samples:=v_samples||jsonb_build_array(jsonb_build_object(
       'type',v_entry.source_type,'sourceId',v_entry.source_id,
       'entryId',v_entry.id,'reason',v_reason));
   END IF;
 END LOOP;
 RETURN jsonb_build_object(
   'checkedEntries',v_checked,'driftedEntries',v_drifted,
   'invalidSources',v_invalid,'unauditedEntries',v_unverified,
   'isClean',v_drifted=0 AND v_invalid=0 AND v_unverified=0,
   'samples',v_samples,
   'sampleTruncated',v_drifted+v_invalid+v_unverified>jsonb_array_length(v_samples));
END;
$integrity$;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_source_integrity(bigint,bigint,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_source_integrity(bigint,bigint,text)
  TO service_role;


-- Override the previous coverage RPC to include source-integrity failures.
-- Phase A3.2 superseding coverage: source-backed operational GL and coalesced stock receipt events.
-- Phase A3: source-completeness diagnostics; NEVER a certified profit statement.
-- A monthly branch report is blocked if financial source documents are not mapped
-- to the GL. This function never silently truncates sources or downloads rows.
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
 v_missing:=v_invoice_unposted+v_invoice_missing_cycle+v_payments_unposted+
   v_expense_unposted+v_payroll_unposted+v_payroll_drafts+
   v_stock_unposted+v_supplier_unposted+v_cash_unclassified+v_gl_broken+
   v_payment_ledger_mismatches+v_service_recognition_missing+
   (v_source_integrity->>'driftedEntries')::bigint+
   (v_source_integrity->>'invalidSources')::bigint+
   (v_source_integrity->>'unauditedEntries')::bigint;
 RETURN jsonb_build_object(
  'tenantId',p_tenant_id,'siteId',p_site_id,'period',p_period,
  'opening',jsonb_build_object('postedCount',v_opening_count,
     'draftCount',v_unposted_opening_count,'asOfDate',v_opening_date),
  'sources',jsonb_build_object(
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
