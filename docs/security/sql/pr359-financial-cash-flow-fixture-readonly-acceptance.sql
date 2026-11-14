-- A20: Staging-only, read-only qualification of cash-flow fixture controls.
-- Run AFTER 20261110027000 and BEFORE/AFTER independently reviewed manifest.
-- Never insert, update, delete, or attempt to "approve" a fixture from a test.
WITH fixture AS MATERIALIZED (
 SELECT t.account_id,t.transaction_type,t.amount,t.reference_no,t.occurred_at
 FROM public.account_transactions t
 WHERE t.tenant_id=1 AND t.site_id=1
   AND t.reference_no LIKE 'STG-PERF-%'
), counts AS (
 SELECT count(*) AS fixture_rows,
   count(*) FILTER (WHERE occurred_at >= '2026-05-01'::timestamptz
     AND occurred_at < '2026-06-01'::timestamptz) AS may_fixture_rows,
   coalesce(sum(amount) FILTER (WHERE transaction_type='collection'),0) AS fixture_in,
   coalesce(sum(amount) FILTER (WHERE transaction_type='withdrawal'),0) AS fixture_out
 FROM fixture
), reviewed AS (
 SELECT count(*) AS approved_manifest_count
 FROM public.financial_gl_staging_fixture_manifests m
 WHERE m.tenant_id=1 AND m.site_id=1
   AND m.cohort_key='STG-PERF-20261105' AND m.status='verified'
), verified AS (
 SELECT public.powerhub_financial_gl_verify_staging_fixture(1,1) AS proof
), raw AS (
 SELECT public.powerhub_financial_period_cash_flow_raw(1,1,
 '2026-05-01'::timestamptz,'2026-06-01'::timestamptz) AS flow
)
SELECT
 CASE WHEN counts.fixture_rows=250000
      AND counts.may_fixture_rows=250000
      AND counts.fixture_in=6325000
      AND counts.fixture_out=6325000
      AND counts.fixture_in=counts.fixture_out
   THEN 'PASS' ELSE 'BLOCKED' END AS fixture_provenance,
 CASE WHEN raw.flow->>'transactionCount'='250000'
      AND (raw.flow->>'externalCashIn')::numeric=6325000
      AND (raw.flow->>'externalCashOut')::numeric=6325000
   THEN 'PASS' ELSE 'BLOCKED' END AS raw_flow_is_preserved,
 CASE WHEN reviewed.approved_manifest_count=1
        AND (verified.proof->>'verified')::boolean IS TRUE
    THEN 'PASS'
    WHEN reviewed.approved_manifest_count=0
        AND (verified.proof->>'verified')::boolean IS FALSE
        AND verified.proof->>'reason'='NO_APPROVED_MANIFEST'
    THEN 'AWAITING_INDEPENDENT_REVIEW'
    ELSE 'BLOCKED' END AS fixture_quarantine_gate,
 CASE WHEN reviewed.approved_manifest_count=1
       AND (verified.proof->>'verified')::boolean IS TRUE
   THEN 'ELIGIBLE_FOR_EXACT_COHORT_EXCLUSION'
   ELSE 'CASH_FLOW_MUST_FAIL_CLOSED_FOR_MAY' END AS expected_guard_behavior,
 counts.fixture_rows,counts.may_fixture_rows,
 counts.fixture_in,counts.fixture_out,reviewed.approved_manifest_count,
 verified.proof->>'reason' AS verification_reason,
 'NOT_CERTIFIED'::text AS accounting_certification
FROM counts CROSS JOIN reviewed CROSS JOIN verified CROSS JOIN raw;
