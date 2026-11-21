-- B4.2 deployed exact source, read-only company account movement audit.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_company_movement_audit(p_tenant_id bigint, p_site_id bigint, p_period text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_cutoff timestamptz;
  v_fixture jsonb := '{}'::jsonb;
  v_fixture_registered boolean;
  v_fixture_verified boolean := false;
  v_fixture_rows bigint := 0;
  v_fixture_unreviewed bigint := 0;
  v_total bigint := 0;
  v_bad bigint := 0;
  v_orphans bigint := 0;
  v_unlinked bigint := 0;
  v_gl_count bigint;
  v_gl_id bigint;
  v_gl_period text;
  v_gl_match numeric;
  v_gl_cash_total numeric;
  v_amount numeric;
  v_status text;
  v_related_account_id bigint;
  v_related_tx_id bigint;
  v_supplier_ledger_count bigint;
  v_supplier_ledger_id bigint;
  v_supplier_ledger_debit numeric;
  v_supplier_ledger_credit numeric;
  v_source_type text;
  v_source_id text;
  v_cash_account_code text;
  v_expected_side text;
  v_reason text;
  v_source_date timestamptz;
  v_link_count integer;
  v_duplicate_links bigint;
  v_examples jsonb := '[]'::jsonb;
  v_aggregate jsonb;
  v_account_totals jsonb;
  v_rec record;
BEGIN
  IF p_tenant_id IS NULL OR p_site_id IS NULL OR p_tenant_id<=0 OR p_site_id<=0
    OR p_period IS NULL OR p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
    OR NOT EXISTS (SELECT 1 FROM public.sites s
      WHERE s.id=p_site_id AND s.tenant_id=p_tenant_id AND s.status<>'archived')
  THEN RAISE EXCEPTION 'GL_B4_CASH_INVALID_SCOPE' USING ERRCODE='22023'; END IF;
  v_cutoff:=(((p_period||'-01')::date + interval '1 month')::timestamp AT TIME ZONE 'Asia/Gaza');
  SELECT EXISTS(SELECT 1 FROM public.financial_gl_staging_technical_exclusions x
     WHERE x.tenant_id=p_tenant_id AND x.site_id=p_site_id AND x.cohort_key='STG-PERF-20261105')
     OR EXISTS(SELECT 1 FROM public.financial_gl_staging_fixture_manifests x
     WHERE x.tenant_id=p_tenant_id AND x.site_id=p_site_id AND x.cohort_key='STG-PERF-20261105')
   INTO v_fixture_registered;
  IF v_fixture_registered THEN
    v_fixture:=public.powerhub_financial_gl_verify_staging_fixture(p_tenant_id,p_site_id);
    v_fixture_verified:=(v_fixture->>'verified')::boolean IS TRUE
      AND (v_fixture->>'quarantinedCount')::bigint=250000
      AND v_fixture->>'financialCertification'='NOT_CERTIFIED';
    IF v_fixture_verified THEN v_fixture_rows:=250000; END IF;
  END IF;
  SELECT count(*) INTO v_fixture_unreviewed
    FROM public.account_transactions t
    WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id
      AND t.occurred_at<v_cutoff AND t.reference_no LIKE 'STG-PERF-%';
  -- Verify both count and content. If a cohort was inserted without a manifest,
  -- or verification drifts, the result is BLOCKED (never silently excluded).
  IF v_fixture_unreviewed>0 AND
    (NOT v_fixture_verified OR v_fixture_unreviewed<>v_fixture_rows)
  THEN v_fixture_verified:=false;v_fixture_rows:=0; END IF;
  SELECT count(*) INTO v_unlinked
  FROM public.account_transactions t
  WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id AND t.occurred_at<v_cutoff
    AND (t.reference_no IS NULL OR t.reference_no NOT LIKE 'STG-PERF-%')
    AND t.related_payment_id IS NULL
    AND t.related_supplier_payment_id IS NULL
    AND t.related_expense_id IS NULL
    AND t.related_supplier_return_id IS NULL
    AND t.related_account_id IS NULL;
  FOR v_rec IN
    SELECT t.*,a.account_type
    FROM public.account_transactions t
    JOIN public.company_accounts a ON a.id=t.account_id AND a.tenant_id=t.tenant_id
    WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id
      AND t.occurred_at<v_cutoff
      AND (t.related_payment_id IS NOT NULL OR t.related_supplier_payment_id IS NOT NULL
        OR t.related_expense_id IS NOT NULL OR t.related_supplier_return_id IS NOT NULL
        OR t.related_account_id IS NOT NULL)
    ORDER BY t.id
  LOOP
    v_total:=v_total+1;
    v_reason:=NULL;
    v_status:=NULL;
    v_amount:=NULL;
    v_source_date:=NULL;
    v_source_type:=NULL;
    v_source_id:=NULL;
    v_related_account_id:=NULL;
    v_related_tx_id:=NULL;
    v_gl_id:=NULL;
    v_gl_count:=0;
    v_gl_period:=NULL;
    v_cash_account_code:=CASE WHEN v_rec.account_type='cash' THEN '1010' ELSE '1020' END;
    v_expected_side:=CASE WHEN v_rec.transaction_type='collection' THEN 'debit'
      WHEN v_rec.transaction_type='withdrawal' THEN 'credit' ELSE NULL END;
    v_link_count:=(v_rec.related_payment_id IS NOT NULL)::integer+
      (v_rec.related_supplier_payment_id IS NOT NULL)::integer+
      (v_rec.related_expense_id IS NOT NULL)::integer+
      (v_rec.related_supplier_return_id IS NOT NULL)::integer+
      (v_rec.related_account_id IS NOT NULL)::integer;
    IF v_link_count<>1 THEN
      v_reason:='MULTIPLE_OR_UNSUPPORTED_LINKS';
    ELSIF v_expected_side IS NULL OR v_rec.amount<=0 THEN
      v_reason:='INVALID_TRANSACTION_DIRECTION_OR_AMOUNT';
    ELSIF v_rec.related_payment_id IS NOT NULL THEN
      v_source_type:='payment';v_source_id:=v_rec.related_payment_id::text;
      SELECT p.amount,p.status,p.paid_at
      INTO v_amount,v_status,v_source_date FROM public.payments p
      WHERE p.id=v_rec.related_payment_id AND p.tenant_id=p_tenant_id AND p.site_id=p_site_id;
      IF NOT FOUND THEN v_reason:='MISSING_PAYMENT_IN_SCOPE';
      ELSIF v_status<>'completed' OR v_expected_side<>'debit'
        OR v_amount IS DISTINCT FROM v_rec.amount
        OR v_source_date IS NULL OR v_source_date>=v_cutoff
        OR (v_source_date AT TIME ZONE 'Asia/Gaza')::date
          IS DISTINCT FROM (v_rec.occurred_at AT TIME ZONE 'Asia/Gaza')::date
      THEN v_reason:='PAYMENT_ACCOUNT_SOURCE_MISMATCH'; END IF;
      SELECT count(*) INTO v_duplicate_links FROM public.account_transactions t
      WHERE t.tenant_id=p_tenant_id AND t.related_payment_id=v_rec.related_payment_id;
      IF v_duplicate_links<>1 THEN v_reason:='DUPLICATE_PAYMENT_CASH_MOVEMENT'; END IF;
    ELSIF v_rec.related_supplier_payment_id IS NOT NULL THEN
      SELECT sp.amount,sp.status,sp.company_account_id,sp.account_transaction_id
      INTO v_amount,v_status,v_related_account_id,v_related_tx_id
      FROM public.supplier_payments sp
      WHERE sp.id=v_rec.related_supplier_payment_id
        AND sp.tenant_id=p_tenant_id AND sp.site_id=p_site_id;
      IF NOT FOUND THEN v_reason:='MISSING_SUPPLIER_PAYMENT_IN_SCOPE';
      ELSIF v_status<>'posted' OR v_expected_side<>'credit'
        OR v_amount IS DISTINCT FROM v_rec.amount
        OR v_related_account_id IS DISTINCT FROM v_rec.account_id
        OR v_related_tx_id IS DISTINCT FROM v_rec.id
      THEN v_reason:='SUPPLIER_PAYMENT_CASH_MISMATCH'; END IF;
      SELECT count(*),min(l.id),coalesce(sum(l.debit_amount),0),
        coalesce(sum(l.credit_amount),0)
      INTO v_supplier_ledger_count,v_supplier_ledger_id,
        v_supplier_ledger_debit,v_supplier_ledger_credit
      FROM public.supplier_ledger_entries l
      WHERE l.tenant_id=p_tenant_id AND l.site_id=p_site_id
        AND l.supplier_payment_id=v_rec.related_supplier_payment_id
        AND l.entry_type='payment';
      IF v_supplier_ledger_count<>1 OR
        v_supplier_ledger_debit IS DISTINCT FROM v_rec.amount
        OR v_supplier_ledger_credit<>0
      THEN v_reason:='SUPPLIER_LEDGER_LINK_MISMATCH'; END IF;
      v_source_type:='supplier_ledger';v_source_id:=v_supplier_ledger_id::text;
    ELSIF v_rec.related_expense_id IS NOT NULL THEN
      v_source_type:='expense';v_source_id:=v_rec.related_expense_id::text;
      SELECT x.amount,x.company_account_id,x.occurred_at
      INTO v_amount,v_related_account_id,v_source_date FROM public.expenses x
      WHERE x.id=v_rec.related_expense_id
        AND x.tenant_id=p_tenant_id AND x.site_id=p_site_id;
      IF NOT FOUND THEN v_reason:='MISSING_EXPENSE_IN_SCOPE';
      ELSIF v_expected_side<>'credit' OR v_amount IS DISTINCT FROM v_rec.amount
         OR v_related_account_id IS DISTINCT FROM v_rec.account_id
         OR (v_source_date AT TIME ZONE 'Asia/Gaza')::date
            IS DISTINCT FROM (v_rec.occurred_at AT TIME ZONE 'Asia/Gaza')::date
      THEN v_reason:='EXPENSE_CASH_LINK_MISMATCH'; END IF;
      SELECT count(*) INTO v_duplicate_links FROM public.account_transactions t
      WHERE t.tenant_id=p_tenant_id AND t.related_expense_id=v_rec.related_expense_id;
      IF v_duplicate_links<>1 THEN v_reason:='DUPLICATE_EXPENSE_CASH_MOVEMENT'; END IF;
    ELSE v_reason:='UNSUPPORTED_RETURN_OR_INTERNAL_TRANSFER'; END IF;
    IF v_reason IS NULL THEN
      SELECT count(*),min(e.id),min(e.period)
      INTO v_gl_count,v_gl_id,v_gl_period
      FROM public.financial_gl_entries e WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
       AND e.source_type=v_source_type AND e.source_id=v_source_id
       AND e.period<=p_period;
      IF v_gl_count<>1 THEN v_reason:='MISSING_OR_DUPLICATE_GL_ENTRY';
      ELSE
        SELECT coalesce(sum(l.amount) FILTER (WHERE l.account_code=v_cash_account_code
              AND l.side=v_expected_side),0),
          coalesce(sum(l.amount) FILTER (WHERE l.account_code IN ('1010','1020')),0)
        INTO v_gl_match,v_gl_cash_total FROM public.financial_gl_lines l
        WHERE l.entry_id=v_gl_id AND l.tenant_id=p_tenant_id AND l.site_id=p_site_id;
        IF v_gl_match IS DISTINCT FROM v_rec.amount
         OR v_gl_cash_total IS DISTINCT FROM v_rec.amount
         OR v_gl_period IS DISTINCT FROM
           to_char(v_rec.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM')
        THEN v_reason:='GL_CASH_SIDE_AMOUNT_OR_PERIOD_MISMATCH'; END IF;
      END IF;
    END IF;
    IF v_reason IS NOT NULL THEN
      v_bad:=v_bad+1;
      IF jsonb_array_length(v_examples)<20 THEN
        v_examples:=v_examples||jsonb_build_array(jsonb_build_object(
          'transactionId',v_rec.id,'accountId',v_rec.account_id,
          'sourceType',coalesce(v_source_type,'unknown'),'sourceId',v_source_id,
          'glEntryId',v_gl_id,'amount',v_rec.amount,'reason',v_reason));
      END IF;
    END IF;
  END LOOP;
  -- Both directions: a valid posted business source must own exactly one account transaction.
  SELECT
    (SELECT count(*) FROM public.payments p
      WHERE p.tenant_id=p_tenant_id AND p.site_id=p_site_id
        AND p.status='completed' AND p.paid_at<v_cutoff
        AND (SELECT count(*) FROM public.account_transactions t
             WHERE t.tenant_id=p.tenant_id AND t.site_id=p.site_id
             AND t.related_payment_id=p.id AND t.occurred_at<v_cutoff)<>1)
    + (SELECT count(*) FROM public.supplier_payments sp
      WHERE sp.tenant_id=p_tenant_id AND sp.site_id=p_site_id
        AND sp.status='posted' AND (sp.payment_date::timestamp AT TIME ZONE 'Asia/Gaza')<v_cutoff
        AND (SELECT count(*) FROM public.account_transactions t
             WHERE t.tenant_id=sp.tenant_id AND t.site_id=sp.site_id
             AND t.related_supplier_payment_id=sp.id AND t.occurred_at<v_cutoff)<>1)
    + (SELECT count(*) FROM public.expenses x
      WHERE x.tenant_id=p_tenant_id AND x.site_id=p_site_id
        AND x.company_account_id IS NOT NULL AND x.occurred_at<v_cutoff
        AND (SELECT count(*) FROM public.account_transactions t
             WHERE t.tenant_id=x.tenant_id AND t.site_id=x.site_id
             AND t.related_expense_id=x.id AND t.occurred_at<v_cutoff)<>1)
  INTO v_orphans;
  SELECT coalesce(jsonb_agg(jsonb_build_object('accountId',x.account_id,
       'accountType',x.account_type,'linkedMovementCount',x.linked_count,
       'netLinkedAmount',x.net_amount) ORDER BY x.account_id),'[]'::jsonb)
  INTO v_account_totals
  FROM (
    SELECT a.id account_id,a.account_type,
     count(t.id) linked_count,
     coalesce(sum(CASE WHEN t.transaction_type='collection' THEN t.amount
        WHEN t.transaction_type='withdrawal' THEN -t.amount ELSE 0 END),0) net_amount
    FROM public.company_accounts a LEFT JOIN public.account_transactions t
    ON t.tenant_id=a.tenant_id AND t.account_id=a.id
      AND t.site_id=p_site_id AND t.occurred_at<v_cutoff
      AND (t.related_payment_id IS NOT NULL OR t.related_supplier_payment_id IS NOT NULL
        OR t.related_expense_id IS NOT NULL OR t.related_supplier_return_id IS NOT NULL
        OR t.related_account_id IS NOT NULL)
    WHERE a.tenant_id=p_tenant_id
    GROUP BY a.id,a.account_type ORDER BY a.id LIMIT 50
  ) x;
  v_aggregate:=public.powerhub_financial_gl_subledger_reconciliation(p_tenant_id,p_site_id,p_period);
  IF (v_aggregate->>'tenantId')::bigint IS DISTINCT FROM p_tenant_id
    OR (v_aggregate->>'siteId')::bigint IS DISTINCT FROM p_site_id
    OR v_aggregate->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
  THEN RAISE EXCEPTION 'GL_B4_CASH_AGGREGATE_SCOPE_INVALID' USING ERRCODE='23514';END IF;
  RETURN jsonb_build_object('tenantId',p_tenant_id,'siteId',p_site_id,'period',p_period,
    'status',CASE WHEN v_bad=0 AND v_orphans=0 AND v_unlinked=0
      AND (v_fixture_unreviewed=0 OR v_fixture_verified)
      AND (v_aggregate->>'unresolvedCount')::bigint=0
      THEN 'LINKED_ACCOUNT_MOVEMENTS_MATCH_NOT_CERTIFIED'
      ELSE 'BLOCKED_ACCOUNT_MOVEMENT_AUDIT' END,
    'accountingCertification','NOT_CERTIFIED','isApproved',false,'isFinalBalanceSheet',false,
    'linkedMovementCount',v_total,'mismatchCount',v_bad,
    'orphanOperationalSourceCount',v_orphans,
    'unlinkedNonFixtureMovementCount',v_unlinked,
    'fixtureExcludedCount',v_fixture_rows,
    'fixtureVerificationStatus',CASE WHEN v_fixture_unreviewed=0 THEN 'NOT_APPLICABLE'
      WHEN v_fixture_verified THEN 'CRYPTOGRAPHICALLY_VERIFIED_TEST_COHORT'
      ELSE 'UNVERIFIED_COHORT_BLOCKS_RECONCILIATION' END,
    'aggregateStatus',v_aggregate->'status',
    'aggregateUnresolvedCount',v_aggregate->'unresolvedCount',
    'accountBalancesLinkedOnly',v_account_totals,
    'mismatchExamples',v_examples,
    'examplesTruncated',v_bad>20,
    'limitations',jsonb_build_array('GL_CASH_CODES_DO_NOT_IDENTIFY_INDIVIDUAL_WALLETS',
      'ONLY_LINKED_OPERATIONAL_MOVEMENTS_ARE_DOCUMENT_RECONCILED',
      'HISTORICAL_OPENING_DOCUMENTS_ARE_SEPARATE',
      'NO_FINAL_ACCOUNTING_CERTIFICATION'));
END;
$function$

REVOKE ALL ON FUNCTION public.powerhub_financial_gl_company_movement_audit(bigint,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_company_movement_audit(bigint,bigint,text) TO service_role;
