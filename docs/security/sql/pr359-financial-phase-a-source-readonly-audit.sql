-- Phase A0 read-only source reconciliation inventory (Staging).
-- These counts are diagnostics, not financial-statement certification.
-- All statements are SELECT; no changes to operations, schema or migration ledger.
WITH checks AS (
 SELECT 'issued_invoices_missing_cycle' AS check_name,count(*)::bigint AS affected
 FROM public.invoices WHERE status IN ('issued','overdue','partially_paid','paid')
 AND (cycle_start_at IS NULL OR cycle_end_at IS NULL)
 UNION ALL
 SELECT 'invoice_cycle_reversed',count(*) FROM public.invoices
 WHERE cycle_start_at IS NOT NULL AND cycle_end_at IS NOT NULL AND cycle_end_at < cycle_start_at
 UNION ALL
 SELECT 'invoice_invalid_tax',count(*) FROM public.invoices
 WHERE status IN ('issued','overdue','partially_paid','paid')
   AND (total_amount IS NULL OR tax_amount IS NULL OR total_amount < 0
     OR tax_amount < 0 OR tax_amount > total_amount)
 UNION ALL
 SELECT 'completed_payments_with_unlinked_invoice_allocation',count(*)
 FROM public.payments
 WHERE status='completed' AND invoice_id IS NULL
   AND coalesce(invoice_applied_amount,0)>0
 UNION ALL
 SELECT 'company_account_movements_missing_site',count(*)
 FROM public.account_transactions WHERE site_id IS NULL
 UNION ALL
 SELECT 'stock_issues_without_accounting_treatment',count(*)
 FROM public.inventory_stock_movements m JOIN public.inventory_items i
  ON i.id=m.item_id AND i.tenant_id=m.tenant_id
 WHERE m.movement_type IN ('issue','fuel_consumption')
   AND (i.accounting_treatment IS NULL
       OR i.accounting_treatment NOT IN ('expense_on_issue','capital_asset','inventory_asset'))
 UNION ALL
 SELECT 'draft_payroll_runs',count(*) FROM public.payroll_runs WHERE status='draft'
 UNION ALL
 SELECT 'posted_accrual_journals',count(*) FROM public.financial_accrual_journals WHERE status='posted'
), audit AS (
 SELECT check_name,affected,
   CASE WHEN check_name='posted_accrual_journals' THEN 'INFORMATIONAL'
        WHEN check_name='draft_payroll_runs' AND affected>0 THEN 'BLOCKS_MONTH_CLOSE'
        WHEN affected>0 THEN 'REVIEW_REQUIRED'
        ELSE 'NO_ROWS_FOUND' END AS status
 FROM checks
)
SELECT * FROM audit ORDER BY check_name;
-- Do not interpret zero from this query as proof of general-ledger completeness:
-- opening balances, unbilled service, prepaid revenue and source-to-GL postings
-- have their own mandatory A2/A3 reconciliation and accounting evidence gates.
