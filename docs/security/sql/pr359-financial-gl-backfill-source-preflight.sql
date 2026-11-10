-- Phase A: scoped, rollback-only source backlog preflight for Staging.
-- No posting, approval, opening creation, fixture quarantine, or source mutation.
-- This report diagnoses SOURCE PLANS, not accounting certification or permission
-- to post. A 250k performance cohort is excluded from this operational list;
-- assess it separately using the exact fingerprint and reviewed Manifest.
-- Change ONLY the input CTE tenant/site/through_period for a different test scope.
BEGIN;
CREATE OR REPLACE FUNCTION pg_temp.powerhub_gl_preflight_probe(
  p_tenant_id bigint,p_site_id bigint,p_type text,p_id bigint
) RETURNS jsonb LANGUAGE plpgsql
SET search_path=pg_catalog,public,pg_temp AS $probe$
DECLARE v_plan jsonb;
BEGIN
 v_plan:=public.powerhub_financial_gl_source_plan(
   p_tenant_id,p_site_id,p_type,p_id);
 RETURN jsonb_build_object(
   'state','SOURCE_PLAN_VALID',
   'reason',null,
   'period',v_plan->>'period',
   'lineCount',jsonb_array_length(coalesce(v_plan->'lines','[]'::jsonb)));
EXCEPTION WHEN OTHERS THEN
 RETURN jsonb_build_object('state','SOURCE_PLAN_BLOCKED',
   'reason',split_part(SQLERRM,':',1),'sqlstate',SQLSTATE);
END;
$probe$;
WITH input AS (
 SELECT 1::bigint AS tenant_id,1::bigint AS site_id,
   '2026-11'::text AS through_period
), validated AS (
 SELECT i.*, ((i.through_period||'-01')::date + interval '1 month')::timestamp
   AT TIME ZONE 'Asia/Gaza' AS until_exclusive
 FROM input i WHERE i.through_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
 AND EXISTS(SELECT 1 FROM public.sites s
   WHERE s.id=i.site_id AND s.tenant_id=i.tenant_id AND s.status<>'archived')
), candidates AS (
 SELECT 'invoice'::text AS source_type,x.id,x.issue_date AS at
 FROM public.invoices x JOIN validated i ON x.tenant_id=i.tenant_id AND x.site_id=i.site_id
 WHERE x.status IN ('issued','overdue','partially_paid','paid') AND x.issue_date<i.until_exclusive
 UNION ALL
 SELECT 'payment',x.id,x.paid_at FROM public.payments x JOIN validated i
 ON x.tenant_id=i.tenant_id AND x.site_id=i.site_id
 WHERE x.status='completed' AND x.paid_at<i.until_exclusive
 UNION ALL
 SELECT 'expense',x.id,x.occurred_at FROM public.expenses x JOIN validated i
 ON x.tenant_id=i.tenant_id AND x.site_id=i.site_id
 WHERE x.category<>'payroll' AND x.occurred_at<i.until_exclusive
 UNION ALL
 SELECT 'stock_movement',x.id,x.occurred_at
 FROM public.inventory_stock_movements x JOIN validated i
 ON x.tenant_id=i.tenant_id AND x.site_id=i.site_id WHERE x.occurred_at<i.until_exclusive
 UNION ALL
 SELECT 'supplier_ledger',x.id,x.occurred_at
 FROM public.supplier_ledger_entries x JOIN validated i
 ON x.tenant_id=i.tenant_id AND x.site_id=i.site_id WHERE x.occurred_at<i.until_exclusive
 UNION ALL
 SELECT 'payroll',x.id,(x.period||'-01')::timestamp AT TIME ZONE 'Asia/Gaza'
 FROM public.payroll_runs x JOIN validated i
 ON x.tenant_id=i.tenant_id AND x.site_id=i.site_id
 WHERE x.status IN ('approved','paid') AND x.period<=i.through_period
 UNION ALL
 SELECT 'payroll_payment',x.id,(x.period||'-01')::timestamp AT TIME ZONE 'Asia/Gaza'
 FROM public.payroll_runs x JOIN validated i
 ON x.tenant_id=i.tenant_id AND x.site_id=i.site_id
 WHERE x.status='paid' AND x.period<=i.through_period
), unapplied AS MATERIALIZED (
 SELECT c.*,i.tenant_id,i.site_id FROM candidates c CROSS JOIN validated i
 WHERE NOT EXISTS (
   SELECT 1 FROM public.financial_gl_entries e
   WHERE e.tenant_id=i.tenant_id AND e.site_id=i.site_id
     AND e.source_type=c.source_type AND e.source_id=c.id::text
 )
), checked AS (
 SELECT CASE WHEN (SELECT count(*) FROM unapplied)>2000
   THEN (1/0)::integer ELSE 1 END AS safe_count
), probed AS MATERIALIZED (
 SELECT b.source_type,b.id,b.at,
   pg_temp.powerhub_gl_preflight_probe(
     b.tenant_id,b.site_id,b.source_type,b.id) AS probe
 FROM unapplied b CROSS JOIN checked
), categorized AS (
 SELECT p.*,
 CASE WHEN p.probe->>'state'='SOURCE_PLAN_VALID'
    THEN 'SOURCE_PLAN_VALID_NOT_POSTED'
  WHEN p.probe->>'reason'='GL_INTERNAL_STOCK_TRANSFER_NOT_AN_EXPENSE'
    THEN 'INTERNAL_TRANSFER_NOT_DIRECT_GL'
  WHEN p.probe->>'reason'='GL_STOCK_EVENT_ACCOUNTED_VIA_SUPPLIER_LEDGER_OR_UNSUPPORTED'
    THEN 'STOCK_REQUIRES_SUPPLIER_COVERAGE_CHECK'
  WHEN p.probe->>'reason' IN ('GL_PAYMENT_INVOICE_NOT_POSTED',
    'GL_SUPPLIER_PAYMENT_PURCHASE_NOT_POSTED')
    THEN 'WAITING_FOR_PREREQUISITE_GL'
  ELSE 'REQUIRES_SOURCE_REVIEW'
 END AS classification FROM probed p
)
SELECT
 (SELECT through_period FROM input) AS through_period,
 (SELECT count(*) FROM categorized) AS candidate_count,
 (SELECT count(*) FROM categorized WHERE classification='SOURCE_PLAN_VALID_NOT_POSTED') AS source_plan_valid_count,
 (SELECT count(*) FROM categorized WHERE classification='WAITING_FOR_PREREQUISITE_GL') AS prerequisite_count,
 (SELECT count(*) FROM categorized WHERE classification IN ('INTERNAL_TRANSFER_NOT_DIRECT_GL',
  'STOCK_REQUIRES_SUPPLIER_COVERAGE_CHECK')) AS indirect_stock_count,
 (SELECT count(*) FROM categorized WHERE classification='REQUIRES_SOURCE_REVIEW') AS source_review_count,
 coalesce((SELECT jsonb_agg(jsonb_build_object('sourceType',source_type,
   'sourceId',id,'occurredAt',at,'classification',classification,
   'reason',probe->>'reason','plannedPeriod',probe->>'period')
   ORDER BY CASE source_type WHEN 'invoice' THEN 1
     WHEN 'supplier_ledger' THEN 2 WHEN 'payroll' THEN 3
     WHEN 'expense' THEN 4 WHEN 'stock_movement' THEN 5
     WHEN 'payment' THEN 6 ELSE 7 END,id)
   FROM categorized),'[]'::jsonb) AS entries,
 'NOT_CERTIFIED' AS accounting_certification,
 'NO_PERSISTENT_CHANGES_ALL_STATEMENTS_ROLLED_BACK' AS evidence_notice;
ROLLBACK;
