-- Phase A: read-only qualification of known Staging-only synthetic ledger
-- movements for future audited quarantine/archive. NOT an exclusion rule.
-- It does not delete, relabel, suppress, or reclassify a financial movement.
-- Scoped to tenant 1, site 1 by known Staging fixture evidence.
-- Deliberately fails closed if a single unknown reference, user, description,
-- relation, operation link, imbalance or unexpected cohort is present.
WITH cohort AS MATERIALIZED (
 SELECT a.*
 FROM public.account_transactions a
 WHERE a.tenant_id=1 AND a.site_id=1
   AND a.reference_no LIKE 'STG-PERF-%'
), per_account AS (
 SELECT account_id,
  COUNT(*) AS n,
  COUNT(*) FILTER(WHERE transaction_type='collection') AS collections,
  COUNT(*) FILTER(WHERE transaction_type='withdrawal') AS withdrawals,
  COALESCE(sum(CASE transaction_type
    WHEN 'collection' THEN amount WHEN 'withdrawal' THEN -amount
    ELSE NULL END),0) AS signed_amount
 FROM cohort GROUP BY account_id
), discrepancies AS (
 SELECT COUNT(*) AS count,
  COUNT(*) FILTER(WHERE reference_no IS NULL OR
    reference_no !~ '^STG-PERF-20261105-(250K-(CASH|PALPAY)-[0-9]{6}|[0-9]{6})$') AS unknown_reference,
  COUNT(*) FILTER(WHERE description NOT IN (
    'Synthetic 250k scale benchmark movement',
    'Synthetic Staging performance fixture (100k); not a real financial movement')) AS unknown_description,
  COUNT(*) FILTER(WHERE created_by_user_id IS NOT NULL) AS attributed_to_user,
  COUNT(*) FILTER(WHERE transaction_type NOT IN ('collection','withdrawal')) AS non_fixture_type,
  COUNT(*) FILTER(WHERE amount NOT IN (1.00,125.00)) AS unexpected_amount,
  COUNT(*) FILTER(WHERE related_payment_id IS NOT NULL
    OR related_expense_id IS NOT NULL OR related_supplier_payment_id IS NOT NULL
    OR related_supplier_return_id IS NOT NULL OR related_account_id IS NOT NULL) AS linked_business_sources,
  COUNT(*) FILTER(WHERE occurred_at < '2026-05-01'::timestamptz
    OR occurred_at >= '2026-05-04'::timestamptz) AS outside_fixture_dates
 FROM cohort
), external_refs AS (
 SELECT
 (SELECT count(*) FROM public.company_account_movement_operations op
    JOIN cohort c ON c.id=op.primary_transaction_id AND c.tenant_id=op.tenant_id) +
 (SELECT count(*) FROM public.company_account_movement_operations op
    JOIN cohort c ON c.id=op.counterpart_transaction_id AND c.tenant_id=op.tenant_id) +
 (SELECT count(*) FROM public.employee_adjustment_repayments rep
    JOIN cohort c ON c.id=rep.account_transaction_id) +
 (SELECT count(*) FROM public.employee_adjustments adj
    JOIN cohort c ON c.id=adj.disbursement_transaction_id) +
 (SELECT count(*) FROM public.powerhub_expense_offline_operation_results r
    JOIN cohort c ON c.id=r.transaction_id) +
 (SELECT count(*) FROM public.supplier_payments pay
    JOIN cohort c ON c.id=pay.account_transaction_id AND c.tenant_id=pay.tenant_id)
 AS other_table_references
)
SELECT CASE WHEN d.count=250000 AND d.unknown_reference=0
 AND d.unknown_description=0 AND d.attributed_to_user=0
 AND d.non_fixture_type=0 AND d.unexpected_amount=0
 AND d.linked_business_sources=0 AND d.outside_fixture_dates=0
 AND x.other_table_references=0
 AND (SELECT COUNT(*) FROM per_account)=2
 AND NOT EXISTS(SELECT 1 FROM per_account p
    WHERE p.n<>125000 OR p.collections<>62500
      OR p.withdrawals<>62500 OR p.signed_amount<>0)
 THEN 'ARCHIVE_CANDIDATE_VERIFIED_NOT_ARCHIVED'
 ELSE 'BLOCKED_MANUAL_REVIEW_REQUIRED' END AS status,
 d.*,x.other_table_references,
 (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.account_id) FROM per_account p)
 AS per_account_evidence,
 'READ_ONLY_NO_FINANCIAL_CERTIFICATION'::text AS accounting_status
FROM discrepancies d CROSS JOIN external_refs x;
