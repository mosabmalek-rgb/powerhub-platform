-- B4.1: Exact deployed RPC definition recovered from Staging; ACL is service-role only.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_subledger_document_audit(p_tenant_id bigint, p_site_id bigint, p_period text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
 v_cutoff timestamptz;
 v_source_count bigint;
 v_invalid_count bigint;
 v_orphan_count bigint;
 v_examples jsonb;
 v_summary jsonb;
 v_transfer_count bigint;
 v_transfer_net numeric;
 v_aggregate jsonb;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id <= 0 OR p_site_id IS NULL OR p_site_id <= 0
   OR p_period IS NULL OR p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
   OR NOT EXISTS (SELECT 1 FROM public.sites s
                  WHERE s.tenant_id=p_tenant_id AND s.id=p_site_id AND s.status<>'archived')
 THEN RAISE EXCEPTION 'GL_B4_DOCUMENT_INVALID_SCOPE' USING ERRCODE='22023'; END IF;
 v_cutoff:=(((p_period||'-01')::date+interval '1 month')::timestamp AT TIME ZONE 'Asia/Gaza');
 -- Check every candidate source in scope, aggregating GL lines once per source.
 -- Stock purchase receipts and returns are posted from the supplier ledger, not again per movement.
 WITH gl_source AS MATERIALIZED (
  SELECT e.source_type, e.source_id, min(e.id) entry_id,
   count(distinct e.id) entry_count, count(l.id) line_count,
   coalesce(sum(l.amount) FILTER (WHERE l.side='debit'),0) debits,
   coalesce(sum(l.amount) FILTER (WHERE l.side='credit'),0) credits,
   coalesce(sum(l.amount) FILTER (WHERE l.account_code='1200' AND l.side='debit'),0) ar_debit,
   coalesce(sum(l.amount) FILTER (WHERE l.account_code='1200' AND l.side='credit'),0) ar_credit,
   coalesce(sum(l.amount) FILTER (WHERE l.account_code='2200' AND l.side='credit'),0) deferred_credit,
   coalesce(sum(l.amount) FILTER (WHERE l.account_code='1010' AND l.side='debit'),0)
    +coalesce(sum(l.amount) FILTER (WHERE l.account_code='1020' AND l.side='debit'),0) cash_debit,
   coalesce(sum(l.amount) FILTER (WHERE l.account_code='2250' AND l.side='credit'),0) advance_credit,
   coalesce(sum(l.amount) FILTER (WHERE l.account_code='2300' AND l.side='debit'),0) supplier_debit,
   coalesce(sum(l.amount) FILTER (WHERE l.account_code='2300' AND l.side='credit'),0) supplier_credit,
   coalesce(sum(l.amount) FILTER (WHERE l.account_code='1300' AND l.side='credit'),0) stock_credit,
   coalesce(sum(l.amount) FILTER (WHERE l.account_code='5100' AND l.side='debit'),0) cost_debit
  FROM public.financial_gl_entries e
  JOIN public.financial_gl_lines l ON l.entry_id=e.id
   AND l.tenant_id=e.tenant_id AND l.site_id=e.site_id
  WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id AND e.period<=p_period
   AND e.source_type IN ('invoice','payment','supplier_ledger','stock_movement')
  GROUP BY e.source_type,e.source_id
 ),
 sources AS MATERIALIZED (
  SELECT 'invoice'::text source_type,i.id::text source_id, i.total_amount expected_amount,
    i.total_amount::numeric extra_1,0::numeric extra_2,
    CASE WHEN i.status IN ('cancelled','void','voided') THEN 'CANCELLED_INVOICE_REVIEW'
         WHEN coalesce(i.credit_applied_amount,0)<>0 THEN 'CREDIT_APPLICATION_REVIEW'
         ELSE NULL END warning
  FROM public.invoices i
  WHERE i.tenant_id=p_tenant_id AND i.site_id=p_site_id AND i.issue_date<v_cutoff
  UNION ALL
  SELECT 'payment',p.id::text,p.amount,p.invoice_applied_amount,
    coalesce(p.subscriber_credit_amount,0),
    CASE WHEN p.invoice_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.invoices i WHERE i.id=p.invoice_id
        AND i.tenant_id=p.tenant_id AND i.site_id=p.site_id)
     THEN 'PAYMENT_INVOICE_SCOPE_INVALID' ELSE NULL END
  FROM public.payments p
  WHERE p.tenant_id=p_tenant_id AND p.site_id=p_site_id
    AND p.status='completed' AND p.paid_at<v_cutoff
  UNION ALL
  SELECT 'supplier_ledger', l.id::text, greatest(l.debit_amount,l.credit_amount),
    l.debit_amount,l.credit_amount,
    CASE WHEN l.debit_amount<0 OR l.credit_amount<0
       OR (l.debit_amount=0 AND l.credit_amount=0)
       OR (l.debit_amount<>0 AND l.credit_amount<>0)
       OR l.entry_type NOT IN ('purchase','payment','supplier_return','opening_balance')
     THEN 'SUPPLIER_LEDGER_SOURCE_INVALID' ELSE NULL END
  FROM public.supplier_ledger_entries l
  WHERE l.tenant_id=p_tenant_id AND l.site_id=p_site_id AND l.occurred_at<v_cutoff
  UNION ALL
  SELECT 'stock_movement',m.id::text,m.total_cost_amount,m.total_cost_amount,
    0::numeric,
    CASE WHEN m.total_cost_amount IS NULL OR m.total_cost_amount<=0
      THEN 'STOCK_COST_INVALID' ELSE NULL END
  FROM public.inventory_stock_movements m
  JOIN public.inventory_items i ON i.id=m.item_id AND i.tenant_id=m.tenant_id
  WHERE m.tenant_id=p_tenant_id AND m.site_id=p_site_id AND m.occurred_at<v_cutoff
   AND m.movement_type='issue' AND i.accounting_treatment='expense_on_issue'
   AND (m.operation_key IS NULL OR m.operation_key NOT LIKE 'trf:%')
 ),
 checked AS (
  SELECT s.source_type,s.source_id,s.expected_amount,s.warning,
   g.entry_id,g.entry_count,g.line_count,g.debits,g.credits,
   CASE s.source_type
    WHEN 'invoice' THEN g.ar_debit
    WHEN 'payment' THEN g.cash_debit
    WHEN 'supplier_ledger' THEN g.supplier_debit+g.supplier_credit
    WHEN 'stock_movement' THEN g.stock_credit END observed,
   CASE
    WHEN g.entry_count IS NULL THEN 'MISSING_GL_ENTRY'
    WHEN g.entry_count<>1 THEN 'DUPLICATE_GL_ENTRY'
    WHEN s.warning IS NOT NULL THEN s.warning
    WHEN s.expected_amount IS NULL OR s.expected_amount<0 THEN 'INVALID_SOURCE_AMOUNT'
    WHEN g.debits<>g.credits OR g.debits<>s.expected_amount THEN 'GL_TOTAL_MISMATCH'
    WHEN s.source_type='invoice' AND
      (g.ar_debit<>s.expected_amount OR g.deferred_credit<>s.expected_amount OR g.line_count<>2)
      THEN 'INVOICE_GL_LINES_MISMATCH'
    WHEN s.source_type='payment' AND
      (g.cash_debit<>s.expected_amount OR g.ar_credit<>s.extra_1
       OR g.advance_credit<>s.extra_2
       OR g.line_count<>CASE WHEN s.extra_2<>0 THEN 3 ELSE 2 END)
      THEN 'PAYMENT_GL_LINES_MISMATCH'
    WHEN s.source_type='supplier_ledger' AND
      (g.supplier_debit<>s.extra_1 OR g.supplier_credit<>s.extra_2 OR g.line_count<>2)
      THEN 'SUPPLIER_GL_LINES_MISMATCH'
    WHEN s.source_type='stock_movement' AND
      (g.stock_credit<>s.expected_amount OR g.cost_debit<>s.expected_amount OR g.line_count<>2)
      THEN 'STOCK_GL_LINES_MISMATCH'
    ELSE 'MATCHED' END result
  FROM sources s LEFT JOIN gl_source g
  ON g.source_type=s.source_type AND g.source_id=s.source_id
 )
 SELECT count(*),count(*) FILTER(WHERE result<>'MATCHED'),
   coalesce(jsonb_agg(jsonb_build_object(
    'sourceType',source_type,'sourceId',source_id,'glEntryId',entry_id,
    'expectedAmount',expected_amount,'observedAmount',observed,
    'reason',result) ORDER BY source_type,source_id)
      FILTER(WHERE result<>'MATCHED'),'[]'::jsonb)
 INTO v_source_count,v_invalid_count,v_examples FROM checked;
 -- Bounded samples are returned to the client; count always covers all discrepancies.
 IF jsonb_array_length(v_examples)>20 THEN
  SELECT coalesce(jsonb_agg(value ORDER BY ordinality),'[]'::jsonb)
   INTO v_examples FROM jsonb_array_elements(v_examples) WITH ORDINALITY t(value,ordinality)
   WHERE ordinality<=20;
 END IF;
 SELECT count(*) INTO v_orphan_count FROM public.financial_gl_entries e
 WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id AND e.period<=p_period
 AND (
  (e.source_type='invoice' AND NOT EXISTS
    (SELECT 1 FROM public.invoices i WHERE i.tenant_id=e.tenant_id
    AND i.site_id=e.site_id AND i.id::text=e.source_id AND i.issue_date<v_cutoff))
  OR (e.source_type='payment' AND NOT EXISTS
    (SELECT 1 FROM public.payments p WHERE p.tenant_id=e.tenant_id
    AND p.site_id=e.site_id AND p.id::text=e.source_id AND p.status='completed'
    AND p.paid_at<v_cutoff))
  OR (e.source_type='supplier_ledger' AND NOT EXISTS
    (SELECT 1 FROM public.supplier_ledger_entries l WHERE l.tenant_id=e.tenant_id
    AND l.site_id=e.site_id AND l.id::text=e.source_id AND l.occurred_at<v_cutoff))
  OR (e.source_type='stock_movement' AND NOT EXISTS
    (SELECT 1 FROM public.inventory_stock_movements m JOIN public.inventory_items i
     ON i.id=m.item_id AND i.tenant_id=m.tenant_id
     WHERE m.tenant_id=e.tenant_id AND m.site_id=e.site_id AND m.id::text=e.source_id
     AND m.occurred_at<v_cutoff AND m.movement_type='issue'
     AND i.accounting_treatment='expense_on_issue'
     AND (m.operation_key IS NULL OR m.operation_key NOT LIKE 'trf:%')))
 );
 SELECT count(*),coalesce(sum(CASE WHEN movement_type='issue'
       THEN -total_cost_amount WHEN movement_type='adjustment_in' THEN total_cost_amount
       ELSE 0 END),0)
 INTO v_transfer_count,v_transfer_net FROM public.inventory_stock_movements
 WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND occurred_at<v_cutoff
 AND operation_key LIKE 'trf:%';
 v_aggregate:=public.powerhub_financial_gl_subledger_reconciliation(p_tenant_id,p_site_id,p_period);
 IF v_aggregate->>'tenantId' IS DISTINCT FROM p_tenant_id::text
    OR v_aggregate->>'siteId' IS DISTINCT FROM p_site_id::text
    OR v_aggregate->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
    THEN RAISE EXCEPTION 'GL_B4_DOCUMENT_AGGREGATE_SCOPE_INVALID' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('tenantId',p_tenant_id,'siteId',p_site_id,'period',p_period,
  'status',CASE WHEN v_invalid_count=0 AND v_orphan_count=0
    AND (v_aggregate->>'unresolvedCount')::bigint=0
    THEN 'DOCUMENT_SOURCES_MATCHED_NOT_CERTIFIED' ELSE 'BLOCKED_DOCUMENT_RECONCILIATION' END,
  'accountingCertification','NOT_CERTIFIED','isApproved',false,'isFinalBalanceSheet',false,
  'sourceCount',v_source_count,'mismatchCount',v_invalid_count,'orphanGLEntryCount',v_orphan_count,
  'mismatchExamples',v_examples,'examplesTruncated',v_invalid_count>20,
  'transferMovementCount',v_transfer_count,'transferCostNet',v_transfer_net,
  'aggregateStatus',v_aggregate->'status','aggregateUnresolvedCount',v_aggregate->'unresolvedCount',
  'limitations',jsonb_build_array('NOT_A_FINANCIAL_CERTIFICATION','OPENING_EVIDENCE_IS_SEPARATE',
     'CASH_TRANSACTION_PROVENANCE_IS_AGGREGATE_ONLY','OTHER_GL_SOURCES_ARE_OUT_OF_SCOPE'));
END;
$function$

REVOKE ALL ON FUNCTION public.powerhub_financial_gl_subledger_document_audit(bigint,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_subledger_document_audit(bigint,bigint,text) TO service_role;
