-- B3.2: Synthetic Staging-only fault injection, fully rolled back.
-- This proves warehouse-transfer pair mismatches are detected without
-- classifying an intra-site stock transfer as an inter-site GL elimination.
BEGIN;
SET LOCAL statement_timeout='120000ms';
DO $audit$
DECLARE baseline jsonb; fault jsonb; affected bigint;
BEGIN
 baseline:=public.powerhub_financial_gl_tenant_rollup(1,'2026-11');
 IF (baseline->>'intraSiteWarehouseTransferCount')::bigint<>2
   OR (baseline->>'intraSiteWarehouseTransferValue')::numeric<>170
   OR (baseline->>'intraSiteWarehouseTransferMismatchCount')::bigint<>0
   OR (baseline->'readiness'->>'warehouseTransfersPaired')::boolean IS DISTINCT FROM true
   OR baseline->>'accountingCertification'<>'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'B3_2_PRECHECK_BASELINE_INVALID'; END IF;
 UPDATE public.inventory_stock_transfers
 SET total_cost_amount=total_cost_amount+0.01
 WHERE tenant_id=1 AND site_id=1 AND id=2 AND total_cost_amount=70;
 GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>1 THEN RAISE EXCEPTION 'B3_2_FIXTURE_NOT_FOUND'; END IF;
 fault:=public.powerhub_financial_gl_tenant_rollup(1,'2026-11');
 IF (fault->>'intraSiteWarehouseTransferMismatchCount')::bigint<>1
   OR (fault->'readiness'->>'warehouseTransfersPaired')::boolean IS DISTINCT FROM false
   OR fault->>'accountingCertification'<>'NOT_CERTIFIED'
   OR (fault->>'isConsolidatedFinancialStatements')::boolean IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'B3_2_MISMATCH_NOT_DETECTED'; END IF;
END;
$audit$;
SELECT 'B3_2_FAULT_INJECTION_PASS_ROLLBACK' result;
ROLLBACK;
