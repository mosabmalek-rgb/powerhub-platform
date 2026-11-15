-- D28 source-linked cash -> operational document -> GL cash-leg verification.
-- Service-only and preliminary: no posting, no inferred provenance, no final certification.
-- Unlinked historical movements, including synthetic performance fixtures, stay visible as blockers.
CREATE OR REPLACE FUNCTION public.powerhub_financial_cash_source_gl_chain(
 p_tenant_id bigint, p_period text
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path TO 'pg_catalog','public','pg_temp'
AS $fn$
DECLARE
 v_cutoff timestamptz;
 v_total bigint; v_transfers bigint; v_unlinked bigint; v_fixture bigint;
 v_linked bigint; v_verified bigint; v_invalid bigint;
 v_payments bigint; v_expenses bigint; v_suppliers bigint;
 v_payment_amount numeric; v_expense_amount numeric; v_supplier_amount numeric;
 v_gl_count bigint; v_blockers jsonb:='[]'::jsonb;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0 OR p_period IS NULL
 OR p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
 OR NOT EXISTS(SELECT 1 FROM public.sites s
   WHERE s.tenant_id=p_tenant_id AND s.status='active')
 THEN RAISE EXCEPTION 'GL_D28_INVALID_TENANT_OR_PERIOD' USING ERRCODE='22023'; END IF;
 v_cutoff:=(((p_period||'-01')::date+interval '1 month')::timestamp
   AT TIME ZONE 'Asia/Gaza');

 SELECT count(*),
 count(*) FILTER(WHERE t.transaction_type IN ('transfer_in','transfer_out')),
 count(*) FILTER(WHERE t.transaction_type NOT IN ('transfer_in','transfer_out')
  AND t.related_payment_id IS NULL AND t.related_expense_id IS NULL
  AND t.related_supplier_payment_id IS NULL AND t.related_supplier_return_id IS NULL),
 count(*) FILTER(WHERE t.reference_no LIKE 'STG-PERF-%')
 INTO v_total,v_transfers,v_unlinked,v_fixture
 FROM public.account_transactions t
 WHERE t.tenant_id=p_tenant_id AND t.occurred_at<v_cutoff;

 -- Source links and ledger rows are verified by strict tenant/site/identity predicates.
 -- Supplier payments map via supplier_ledger_entries, never source_type=supplier_payment.
 WITH linked AS (
  SELECT t.*,
   CASE WHEN t.related_payment_id IS NOT NULL THEN 'payment'
        WHEN t.related_expense_id IS NOT NULL THEN 'expense'
        WHEN t.related_supplier_payment_id IS NOT NULL THEN 'supplier_payment'
        WHEN t.related_supplier_return_id IS NOT NULL THEN 'supplier_return'
        ELSE 'unsupported' END kind,
   ((t.related_payment_id IS NOT NULL)::int
     +(t.related_expense_id IS NOT NULL)::int
     +(t.related_supplier_payment_id IS NOT NULL)::int
     +(t.related_supplier_return_id IS NOT NULL)::int) link_count,
   coalesce(t.related_payment_id,t.related_expense_id,
     t.related_supplier_payment_id,t.related_supplier_return_id) document_id,
   CASE WHEN ca.account_type='cash' THEN '1010'
        WHEN ca.account_type IN ('jawwal_pay','palpay','bank_of_palestine','other')
             THEN '1020' ELSE NULL END expected_cash_code
  FROM public.account_transactions t
  LEFT JOIN public.company_accounts ca
    ON ca.tenant_id=t.tenant_id AND ca.id=t.account_id
  WHERE t.tenant_id=p_tenant_id AND t.occurred_at<v_cutoff
    AND (t.related_payment_id IS NOT NULL OR t.related_expense_id IS NOT NULL
      OR t.related_supplier_payment_id IS NOT NULL OR t.related_supplier_return_id IS NOT NULL)
 ), joined AS (
  SELECT t.*,p.id payment_exists,p.amount payment_amount,p.status payment_status,
   x.id expense_exists,x.amount expense_amount,x.company_account_id expense_account,
   sp.id supplier_exists,sp.amount supplier_amount,sp.status supplier_status,
   sp.account_transaction_id supplier_transaction,sp.company_account_id supplier_account,
   sl.id ledger_exists,sl.debit_amount ledger_debit,sl.credit_amount ledger_credit,
   e.id gl_exists,e.period gl_period,e.reverses_entry_id,
   (SELECT count(*) FROM public.account_transactions z
      WHERE z.tenant_id=t.tenant_id
      AND (t.kind='payment' AND z.related_payment_id=t.related_payment_id
        OR t.kind='expense' AND z.related_expense_id=t.related_expense_id
        OR t.kind='supplier_payment' AND z.related_supplier_payment_id=t.related_supplier_payment_id
        OR t.kind='supplier_return' AND z.related_supplier_return_id=t.related_supplier_return_id)
   ) global_document_uses,
   gl.cash_lines,gl.exact_cash_lines,gl.total_debit,gl.total_credit,
   count(*) OVER(PARTITION BY t.id) joined_rows
  FROM linked t
  LEFT JOIN public.payments p
    ON t.kind='payment' AND p.tenant_id=t.tenant_id
    AND p.site_id=t.site_id AND p.id=t.related_payment_id
  LEFT JOIN public.expenses x
    ON t.kind='expense' AND x.tenant_id=t.tenant_id
    AND x.site_id=t.site_id AND x.id=t.related_expense_id
  LEFT JOIN public.supplier_payments sp
    ON t.kind='supplier_payment' AND sp.tenant_id=t.tenant_id
    AND sp.site_id=t.site_id AND sp.id=t.related_supplier_payment_id
  LEFT JOIN public.supplier_ledger_entries sl
    ON t.kind='supplier_payment' AND sl.tenant_id=t.tenant_id
    AND sl.site_id=t.site_id AND sl.supplier_payment_id=sp.id AND sl.entry_type='payment'
  LEFT JOIN public.financial_gl_entries e
    ON e.tenant_id=t.tenant_id AND e.site_id=t.site_id AND e.source_revision=1
    AND e.source_type=CASE WHEN t.kind='supplier_payment' THEN 'supplier_ledger'
                           ELSE t.kind END
    AND e.source_id=CASE WHEN t.kind='supplier_payment' THEN sl.id::text
                         ELSE t.document_id::text END
  LEFT JOIN LATERAL(
    SELECT count(*) FILTER(WHERE l.account_code IN ('1010','1020')) cash_lines,
     count(*) FILTER(WHERE l.account_code=t.expected_cash_code
        AND l.side=CASE WHEN t.kind='payment' THEN 'debit' ELSE 'credit' END
        AND l.amount=t.amount) exact_cash_lines,
     coalesce(sum(l.amount) FILTER(WHERE l.side='debit'),0) total_debit,
     coalesce(sum(l.amount) FILTER(WHERE l.side='credit'),0) total_credit
    FROM public.financial_gl_lines l
    WHERE l.entry_id=e.id AND l.tenant_id=t.tenant_id AND l.site_id=t.site_id
  ) gl ON true
 ), proof AS (
  SELECT j.*,
   (j.link_count=1 AND j.joined_rows=1 AND j.global_document_uses=1
    AND j.amount>0 AND j.amount=round(j.amount,2)
    AND j.expected_cash_code IS NOT NULL
    AND (CASE WHEN j.kind='payment' THEN
        j.transaction_type='collection' AND j.payment_exists IS NOT NULL
        AND j.payment_status='completed' AND j.payment_amount=j.amount
       WHEN j.kind='expense' THEN
        j.transaction_type='withdrawal' AND j.expense_exists IS NOT NULL
        AND j.expense_amount=j.amount AND j.expense_account=j.account_id
       WHEN j.kind='supplier_payment' THEN
        j.transaction_type='withdrawal' AND j.supplier_exists IS NOT NULL
        AND j.supplier_status='posted' AND j.supplier_amount=j.amount
        AND j.supplier_transaction=j.id AND j.supplier_account=j.account_id
        AND j.ledger_exists IS NOT NULL AND j.ledger_debit=j.amount
        AND j.ledger_credit=0
       ELSE false END)
    AND j.gl_exists IS NOT NULL
    AND j.gl_period=to_char(j.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM')
    AND j.reverses_entry_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.financial_gl_entries r
      WHERE r.reverses_entry_id=j.gl_exists)
    AND j.cash_lines=1 AND j.exact_cash_lines=1
    AND j.total_debit=j.total_credit AND j.total_debit>0
   ) IS TRUE verified
  FROM joined j
 )
 SELECT count(*), count(*) FILTER(WHERE verified),
 count(*) FILTER(WHERE NOT verified),
 count(*) FILTER(WHERE verified AND kind='payment'),
 count(*) FILTER(WHERE verified AND kind='expense'),
 count(*) FILTER(WHERE verified AND kind='supplier_payment'),
 coalesce(sum(amount) FILTER(WHERE verified AND kind='payment'),0),
 coalesce(sum(amount) FILTER(WHERE verified AND kind='expense'),0),
 coalesce(sum(amount) FILTER(WHERE verified AND kind='supplier_payment'),0)
 INTO v_linked,v_verified,v_invalid,v_payments,v_expenses,v_suppliers,
      v_payment_amount,v_expense_amount,v_supplier_amount
 FROM proof;

 SELECT count(*) INTO v_gl_count FROM public.financial_gl_entries e
 WHERE e.tenant_id=p_tenant_id AND e.period<=p_period;
 IF v_unlinked>0 THEN v_blockers:=v_blockers||'"UNLINKED_NON_TRANSFER_CASH_MOVEMENTS"'::jsonb; END IF;
 IF v_invalid>0 THEN v_blockers:=v_blockers||'"EXPLICIT_CASH_SOURCE_OR_GL_MISMATCH"'::jsonb; END IF;
 IF v_transfers>0 THEN v_blockers:=v_blockers||'"TRANSFERS_REQUIRE_SEPARATE_D27_AND_GL_PROOF"'::jsonb; END IF;
 IF v_total=0 THEN v_blockers:=v_blockers||'"NO_CASH_MOVEMENTS_TO_AUDIT"'::jsonb; END IF;
 RETURN jsonb_build_object(
  'tenantId',p_tenant_id,'period',p_period,'asOfExclusive',v_cutoff,
  'status',CASE WHEN jsonb_array_length(v_blockers)>0
     THEN 'BLOCKED_SOURCE_CASH_GL_RECONCILIATION'
     ELSE 'PRELIMINARY_SOURCE_CASH_GL_RECONCILIATION' END,
  'blockers',v_blockers,'totalCashMovementCount',v_total,
  'internalTransferMovementCount',v_transfers,
  'unlinkedNonTransferCashMovementCount',v_unlinked,
  'technicalPerformancePrefixMovementCountNotExcluded',v_fixture,
  'explicitSourceLinkedMovementCount',v_linked,
  'verifiedSourceCashGlMovementCount',v_verified,
  'unverifiedSourceCashGlMovementCount',v_invalid,
  'verifiedPaymentCount',v_payments,'verifiedExpenseCount',v_expenses,
  'verifiedSupplierPaymentCount',v_suppliers,
  'verifiedPaymentAmount',v_payment_amount,
  'verifiedExpenseAmount',v_expense_amount,
  'verifiedSupplierPaymentAmount',v_supplier_amount,
  'glEntryCountAsOf',v_gl_count,
  'glCashLegOnlyProof',true,'independentFullLedgerReconciliation',false,
  'openingBalanceEvidenceApproved',false,
  'internalTransferGlReconciled',false,
  'isConsolidatedFinancialStatements',false,
  'accountingCertification','NOT_CERTIFIED');
END $fn$;
REVOKE ALL ON FUNCTION public.powerhub_financial_cash_source_gl_chain(bigint,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_cash_source_gl_chain(bigint,text)
 TO service_role;
COMMENT ON FUNCTION public.powerhub_financial_cash_source_gl_chain(bigint,text)
 IS 'D28 preliminary and fail-closed cash source/document/GL cash-leg provenance. Unlinked historical and internal transfer movements remain excluded from certification.';