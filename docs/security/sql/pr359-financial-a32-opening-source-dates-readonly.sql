-- A32: read-only source/date alignment for choosing a defensible Staging opening.
-- Historical performance fixtures are explicitly counted, never renamed,
-- suppressed, deleted, or mistaken for source account balance evidence.
WITH candidates(as_of_date) AS (
 VALUES ('2026-01-01'::date),('2026-05-01'::date),
        ('2026-10-01'::date),('2026-10-12'::date)
), account_scope AS (
 SELECT c.as_of_date,a.id account_id,a.created_at,a.opening_balance,
   COUNT(tx.id) FILTER (WHERE tx.occurred_at <
      (c.as_of_date::timestamp AT TIME ZONE 'Asia/Gaza')) prior_transactions,
   COUNT(tx.id) FILTER (WHERE tx.occurred_at <
      (c.as_of_date::timestamp AT TIME ZONE 'Asia/Gaza')
      AND tx.reference_no LIKE 'STG-PERF-%') prior_synthetic_transactions,
   COALESCE(SUM(CASE WHEN tx.occurred_at <
      (c.as_of_date::timestamp AT TIME ZONE 'Asia/Gaza') THEN
       CASE tx.transaction_type WHEN 'collection' THEN tx.amount
        WHEN 'withdrawal' THEN -tx.amount ELSE 0 END ELSE 0 END),0) prior_net
 FROM candidates c JOIN public.company_accounts a ON a.tenant_id=1
 JOIN public.company_account_sites link
   ON link.tenant_id=a.tenant_id AND link.account_id=a.id AND link.site_id=1
 LEFT JOIN public.account_transactions tx ON tx.tenant_id=a.tenant_id
   AND tx.site_id=link.site_id AND tx.account_id=a.id
 GROUP BY c.as_of_date,a.id,a.created_at,a.opening_balance
), dates AS (
 SELECT 'invoice' AS source_type,count(*) AS count,MIN(issue_date) earliest
 FROM public.invoices WHERE tenant_id=1 AND site_id=1
 UNION ALL SELECT 'payment',count(*),MIN(paid_at)
 FROM public.payments WHERE tenant_id=1 AND site_id=1
 UNION ALL SELECT 'stock',count(*),MIN(occurred_at)
 FROM public.inventory_stock_movements WHERE tenant_id=1 AND site_id=1
 UNION ALL SELECT 'supplier',count(*),MIN(occurred_at)
 FROM public.supplier_ledger_entries WHERE tenant_id=1 AND site_id=1
), per_date AS (
 SELECT as_of_date,count(*) accounts,
 count(*) FILTER (WHERE created_at >
   (as_of_date::timestamp AT TIME ZONE 'Asia/Gaza')) accounts_created_after_opening,
 sum(prior_transactions) transactions_before_opening,
 sum(prior_synthetic_transactions) synthetic_before_opening,
 sum(prior_transactions-prior_synthetic_transactions) other_before_opening,
 sum(prior_net) net_before_opening
 FROM account_scope GROUP BY as_of_date
)
SELECT jsonb_build_object(
 'tenantId',1,'siteId',1,'classification','READ_ONLY_TEST_DATA_NOT_CERTIFIED',
 'candidateDates',(SELECT jsonb_agg(to_jsonb(p) ORDER BY as_of_date) FROM per_date p),
 'sourceFirstDates',(SELECT jsonb_agg(to_jsonb(d) ORDER BY source_type) FROM dates d),
 'warning','Do not equate zero net synthetic fixtures with independent source ledger verification',
 'requiresIndependentOpeningReconciliation',true
) AS audit;
