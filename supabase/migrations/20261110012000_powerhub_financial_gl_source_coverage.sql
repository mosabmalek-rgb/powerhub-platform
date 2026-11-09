-- Phase A3: source-completeness diagnostics; NEVER a certified profit statement.
-- A monthly branch report is blocked if financial source documents are not mapped
-- to the GL. This function never silently truncates sources or downloads rows.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_source_coverage(
 p_tenant_id bigint,p_site_id bigint,p_period text
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $coverage$
DECLARE
 v_start timestamptz;v_end timestamptz;v_day date;
 v_opening_count bigint;v_unposted_opening_count bigint;
 v_opening_date date;
 v_invoice_total bigint;v_invoice_unposted bigint;v_invoice_missing_cycle bigint;
 v_payments_total bigint;v_payments_unposted bigint;
 v_expense_total bigint;v_expense_unposted bigint;
 v_payroll_total bigint;v_payroll_unposted bigint;v_payroll_drafts bigint;
 v_stock_total bigint;v_stock_unposted bigint;
 v_supplier_total bigint;v_supplier_unposted bigint;
 v_cash_moves bigint;v_cash_unclassified bigint;v_cash_perf_fixture bigint;
 v_gl_total bigint;v_gl_broken bigint;v_gl_balance numeric;
 v_missing bigint;
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
 SELECT count(*),count(*) FILTER(WHERE NOT EXISTS(
   SELECT 1 FROM public.financial_gl_entries g
   WHERE g.tenant_id=p.tenant_id AND g.site_id=p.site_id
   AND g.source_type='payment' AND g.source_id=p.id::text))
 INTO v_payments_total,v_payments_unposted
 FROM public.payments p
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
        count(*) FILTER(WHERE status IN ('approved','paid') AND NOT EXISTS(
          SELECT 1 FROM public.financial_gl_entries g
          WHERE g.tenant_id=p.tenant_id AND g.site_id=p.site_id
          AND g.source_type='payroll' AND g.source_id=p.id::text)),
        count(*) FILTER(WHERE status='draft')
 INTO v_payroll_total,v_payroll_unposted,v_payroll_drafts
 FROM public.payroll_runs p WHERE p.tenant_id=p_tenant_id
 AND p.site_id=p_site_id AND p.period=p_period;
 SELECT count(*),count(*) FILTER(WHERE NOT EXISTS(
   SELECT 1 FROM public.financial_gl_entries g
   WHERE g.tenant_id=m.tenant_id AND g.site_id=m.site_id
   AND g.source_type='stock_movement' AND g.source_id=m.id::text))
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
 v_missing:=v_invoice_unposted+v_invoice_missing_cycle+v_payments_unposted+
   v_expense_unposted+v_payroll_unposted+v_payroll_drafts+
   v_stock_unposted+v_supplier_unposted+v_cash_unclassified+v_gl_broken;
 RETURN jsonb_build_object(
  'tenantId',p_tenant_id,'siteId',p_site_id,'period',p_period,
  'opening',jsonb_build_object('postedCount',v_opening_count,
     'draftCount',v_unposted_opening_count,'asOfDate',v_opening_date),
  'sources',jsonb_build_object(
    'invoices',jsonb_build_object('inScope',v_invoice_total,
      'missingGL',v_invoice_unposted,'missingCycle',v_invoice_missing_cycle),
    'payments',jsonb_build_object('inScope',v_payments_total,'missingGL',v_payments_unposted),
    'expenses',jsonb_build_object('inScope',v_expense_total,'missingGL',v_expense_unposted),
    'payroll',jsonb_build_object('approvedOrPaid',v_payroll_total,
      'missingGL',v_payroll_unposted,'drafts',v_payroll_drafts),
    'stockMovements',jsonb_build_object('inScope',v_stock_total,'missingGL',v_stock_unposted),
    'supplierLedger',jsonb_build_object('inScope',v_supplier_total,'missingGL',v_supplier_unposted),
    'companyAccountMovements',jsonb_build_object('inScope',v_cash_moves,
      'unclassified',v_cash_unclassified,
      'performanceFixtureTagged',v_cash_perf_fixture)),
  'gl',jsonb_build_object('entries',v_gl_total,'unbalancedEntries',v_gl_broken,
    'signedBalance',v_gl_balance),
  'unreconciledSourceCount',v_missing,
  'isOpeningReconciled',v_opening_count=1 AND v_unposted_opening_count=0,
  'isGLStructurallyBalanced',v_gl_broken=0 AND v_gl_balance=0,
  'isSourceCoverageComplete',v_missing=0 AND v_opening_count=1
    AND v_unposted_opening_count=0,
  'isCompleteAccrualStatement',false,'isFinalProfit',false,
  'accountingCertification','NOT_CERTIFIED',
  'limitation','Operational movement types still need authoritative classification and opening subledger reconciliation');
END;
$coverage$;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_source_coverage(bigint,bigint,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_source_coverage(bigint,bigint,text)
 TO service_role;
NOTIFY pgrst,'reload schema';
