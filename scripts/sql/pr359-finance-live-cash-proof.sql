-- PR359 source-derived baseline for a PRODUCTION-DERIVED shadow rehearsal.
-- READ-ONLY. Do not export individual financial rows.
WITH payment_checks AS (
 SELECT count(*)::bigint rows, count(*) FILTER (WHERE p.status='completed')::bigint completed,
   coalesce(sum(p.amount),0)::text total_amount,
   coalesce(sum(p.amount) FILTER (WHERE p.status='completed'),0)::text completed_amount,
   count(*) FILTER (WHERE p.invoice_id IS NULL AND p.status='completed') completed_unlinked,
   count(*) FILTER (WHERE p.amount<=0) nonpositive,
   count(*) FILTER (WHERE p.amount<>round(p.amount,2)) excess_precision,
   count(*) FILTER (WHERE p.invoice_id IS NOT NULL AND i.id IS NULL) orphan_invoice,
   count(*) FILTER (WHERE i.id IS NOT NULL AND (i.tenant_id<>p.tenant_id OR i.site_id<>p.site_id OR i.subscriber_id<>p.subscriber_id)) cross_scope_invoice
 FROM public.payments p LEFT JOIN public.invoices i ON p.invoice_id=i.id
), cash_per_payment AS (
 SELECT p.id,p.amount,p.tenant_id,
   coalesce(sum(t.amount),0) linked_cash_amount,
   count(t.id) linked_cash_rows,
   count(t.id) FILTER (WHERE t.tenant_id<>p.tenant_id) cross_tenant_links,
   count(t.id) FILTER (WHERE t.transaction_type<>'collection') wrong_cash_type
 FROM public.payments p LEFT JOIN public.account_transactions t ON t.related_payment_id=p.id
 GROUP BY p.id,p.amount,p.tenant_id
), cash_checks AS (
 SELECT count(*)::bigint payment_rows,
   count(*) FILTER (WHERE linked_cash_rows=1)::bigint exactly_one_cash_row,
   count(*) FILTER (WHERE linked_cash_rows=0)::bigint missing_cash,
   count(*) FILTER (WHERE linked_cash_rows>1)::bigint duplicate_cash,
   count(*) FILTER (WHERE abs(linked_cash_amount-amount)>0.01)::bigint incorrect_cash_amount,
   coalesce(sum(cross_tenant_links),0)::bigint cross_tenant_cash,
   coalesce(sum(wrong_cash_type),0)::bigint wrong_cash_type FROM cash_per_payment
), invoice_cash AS (
 SELECT i.id,i.paid_amount,coalesce(sum(p.amount) FILTER (WHERE p.status='completed'),0) cash_paid
 FROM public.invoices i LEFT JOIN public.payments p ON p.invoice_id=i.id
 GROUP BY i.id,i.paid_amount
), invoice_cash_checks AS (
 SELECT count(*)::bigint invoice_rows,
   count(*) FILTER (WHERE abs(paid_amount-cash_paid)>0.01)::bigint paid_mismatches,
   coalesce(sum(paid_amount),0)::text paid_total,
   coalesce(sum(cash_paid),0)::text linked_paid_total FROM invoice_cash
), invoice_balances AS (
 SELECT count(*)::bigint rows,coalesce(sum(total_amount),0)::text total_invoiced,
   coalesce(sum(paid_amount),0)::text total_paid,
   coalesce(sum(balance_due),0)::text total_due,
   count(*) FILTER (WHERE total_amount<0 OR paid_amount<0 OR balance_due<0)::bigint negative_amounts,
   count(*) FILTER (WHERE abs(round(total_amount-paid_amount-balance_due,2))>0.01 AND status<>'cancelled')::bigint balance_mismatches FROM public.invoices
), cash_ledger_size AS (
 SELECT count(*)::bigint rows,coalesce(sum(amount),0)::text gross_amount,
   count(*) FILTER (WHERE related_payment_id IS NOT NULL)::bigint payment_linked_rows FROM public.account_transactions
)
SELECT jsonb_build_object(
 'payments',(SELECT to_jsonb(x) FROM payment_checks x),
 'cashLinks',(SELECT to_jsonb(x) FROM cash_checks x),
 'invoiceCash',(SELECT to_jsonb(x) FROM invoice_cash_checks x),
 'invoiceBalances',(SELECT to_jsonb(x) FROM invoice_balances x),
 'cashLedgerSize',(SELECT to_jsonb(x) FROM cash_ledger_size x),
 'subscriberCreditLedgerPresent',to_regclass('public.subscriber_balance_ledger') IS NOT NULL,
 'financeColumns',(SELECT coalesce(jsonb_agg(column_name ORDER BY column_name),'[]'::jsonb)
   FROM information_schema.columns WHERE table_schema='public' AND table_name='payments'
   AND column_name IN ('payment_purpose','invoice_applied_amount','subscriber_credit_amount')),
 'coreFinanceHistory',(SELECT coalesce(jsonb_agg(jsonb_build_object(
    'version',version,'name',name,'sqlAvailable',(statements IS NOT NULL AND cardinality(statements)>0))
    ORDER BY version),'[]'::jsonb)
   FROM supabase_migrations.schema_migrations
   WHERE version IN ('20261103131052','20261103131104','20261103131125','20261103145232'))
) AS evidence;
