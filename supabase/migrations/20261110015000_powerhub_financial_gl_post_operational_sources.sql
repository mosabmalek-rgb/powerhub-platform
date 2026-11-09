-- A3.1: Explicit, source-backed GL posting. Staging first, no historical auto-backfill.
-- Single source per call; fail closed on missing evidence, no fabricated income.
-- All amounts must be <= 2 decimal places; at most one posting per source.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_source_plan(
 p_tenant_id bigint,p_site_id bigint,p_source_type text,p_source_id bigint
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $plan$
DECLARE
 i public.invoices%ROWTYPE; pay public.payments%ROWTYPE;
 exp public.expenses%ROWTYPE; stock public.inventory_stock_movements%ROWTYPE;
 supplier public.supplier_ledger_entries%ROWTYPE;
 payroll public.payroll_runs%ROWTYPE;
 a public.account_transactions%ROWTYPE;
 ca public.company_accounts%ROWTYPE;
 purch public.supplier_purchases%ROWTYPE;
 sp public.supplier_payments%ROWTYPE;
 original public.inventory_stock_movements%ROWTYPE;
 v_count bigint;v_sum numeric;v_gross numeric;v_net numeric;v_adv numeric;v_other numeric;
 v_payload jsonb;v_lines jsonb:='[]'::jsonb;v_policy text;v_period text;
 v_reversal_id bigint;v_cash_account text;v_amount numeric;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0 OR p_site_id IS NULL OR p_site_id<=0
   OR p_source_id IS NULL OR p_source_id<=0 OR p_source_type IS NULL
   OR p_source_type NOT IN('invoice','payment','expense','stock_movement','supplier_ledger','payroll')
   OR NOT EXISTS(SELECT 1 FROM public.sites s WHERE s.id=p_site_id
      AND s.tenant_id=p_tenant_id AND s.status<>'archived')
 THEN RAISE EXCEPTION 'GL_SOURCE_SCOPE_INVALID' USING ERRCODE='22023'; END IF;
 IF p_source_type='invoice' THEN
  SELECT * INTO i FROM public.invoices
   WHERE id=p_source_id AND tenant_id=p_tenant_id AND site_id=p_site_id FOR SHARE;
  IF NOT FOUND OR i.status NOT IN ('issued','overdue','partially_paid','paid')
     OR i.total_amount<=0 OR i.tax_amount<0 OR i.tax_amount>i.total_amount
     OR i.total_amount<>round(i.total_amount,2) OR i.tax_amount<>round(i.tax_amount,2)
     OR i.credit_applied_amount<>0 OR i.cycle_start_at IS NULL OR i.cycle_end_at IS NULL
     OR i.cycle_end_at<i.cycle_start_at
  THEN RAISE EXCEPTION 'GL_INVOICE_UNVERIFIED_OR_CREDIT_NOT_SUPPORTED' USING ERRCODE='22023'; END IF;
  v_period:=to_char(i.issue_date AT TIME ZONE 'Asia/Gaza','YYYY-MM');
  v_lines:=jsonb_build_array(
    jsonb_build_object('code','1200','side','debit','amount',i.total_amount),
    jsonb_build_object('code','2200','side','credit','amount',i.total_amount-i.tax_amount));
  IF i.tax_amount>0 THEN
    v_lines:=v_lines||jsonb_build_array(jsonb_build_object('code','2500','side','credit','amount',i.tax_amount));
  END IF;
  v_payload:=jsonb_build_object('id',i.id,'issuedAt',i.issue_date,
    'cycleStart',i.cycle_start_at,'cycleEnd',i.cycle_end_at,
    'gross',i.total_amount,'tax',i.tax_amount,'creditApplied',i.credit_applied_amount,
    'invoiceNo',i.invoice_no,'subscriberId',i.subscriber_id);
  v_policy:='invoice-receivable-v1-defer-service';
 ELSIF p_source_type='payment' THEN
  SELECT * INTO pay FROM public.payments WHERE id=p_source_id
    AND tenant_id=p_tenant_id AND site_id=p_site_id FOR SHARE;
  IF NOT FOUND OR pay.status<>'completed' OR pay.amount<=0
    OR pay.amount<>round(pay.amount,2)
    OR pay.invoice_applied_amount<0 OR pay.subscriber_credit_amount<0
    OR pay.amount<>pay.invoice_applied_amount+pay.subscriber_credit_amount
    OR (pay.invoice_applied_amount>0 AND (pay.invoice_id IS NULL OR
      NOT EXISTS(SELECT 1 FROM public.invoices iv WHERE iv.id=pay.invoice_id
       AND iv.tenant_id=p_tenant_id AND iv.site_id=p_site_id)))
  THEN RAISE EXCEPTION 'GL_PAYMENT_AMOUNT_OR_INVOICE_INVALID' USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO v_count FROM public.account_transactions t
  WHERE t.tenant_id=p_tenant_id AND t.related_payment_id=pay.id;
  IF v_count<>1 THEN RAISE EXCEPTION 'GL_PAYMENT_COLLECTION_LINK_MISSING' USING ERRCODE='22023'; END IF;
  SELECT * INTO a FROM public.account_transactions t
  WHERE t.tenant_id=p_tenant_id AND t.related_payment_id=pay.id FOR SHARE;
  IF a.site_id IS DISTINCT FROM p_site_id OR a.transaction_type<>'collection'
    OR a.amount<>pay.amount OR a.amount<=0
  THEN RAISE EXCEPTION 'GL_PAYMENT_COLLECTION_MISMATCH' USING ERRCODE='22023'; END IF;
  SELECT * INTO ca FROM public.company_accounts
   WHERE id=a.account_id AND tenant_id=p_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'GL_PAYMENT_CASH_ACCOUNT_UNKNOWN' USING ERRCODE='22023'; END IF;
  v_cash_account:=CASE WHEN ca.account_type='cash' THEN '1010' ELSE '1020' END;
  -- A payment settles an already issued invoice. It must not create revenue twice.
  IF pay.invoice_applied_amount>0 AND NOT EXISTS(
    SELECT 1 FROM public.financial_gl_entries e WHERE e.tenant_id=p_tenant_id
     AND e.site_id=p_site_id AND e.source_type='invoice'
     AND e.source_id=pay.invoice_id::text AND e.source_revision=1)
  THEN RAISE EXCEPTION 'GL_PAYMENT_INVOICE_NOT_POSTED' USING ERRCODE='22023'; END IF;
  v_period:=to_char(pay.paid_at AT TIME ZONE 'Asia/Gaza','YYYY-MM');
  v_lines:=jsonb_build_array(jsonb_build_object('code',v_cash_account,'side','debit','amount',pay.amount));
  IF pay.invoice_applied_amount>0 THEN
   v_lines:=v_lines||jsonb_build_array(
    jsonb_build_object('code','1200','side','credit','amount',pay.invoice_applied_amount));
  END IF;
  IF pay.subscriber_credit_amount>0 THEN
   v_lines:=v_lines||jsonb_build_array(
    jsonb_build_object('code','2250','side','credit','amount',pay.subscriber_credit_amount));
  END IF;
  v_payload:=jsonb_build_object('id',pay.id,'paidAt',pay.paid_at,'amount',pay.amount,
   'invoiceId',pay.invoice_id,'applied',pay.invoice_applied_amount,
   'credit',pay.subscriber_credit_amount,'movementId',a.id,'accountId',a.account_id,
   'accountType',ca.account_type,'movementAmount',a.amount);
  v_policy:='payment-receivable-and-prepayment-v1';
 ELSIF p_source_type='expense' THEN
  SELECT * INTO exp FROM public.expenses WHERE id=p_source_id
    AND tenant_id=p_tenant_id AND site_id=p_site_id FOR SHARE;
  IF NOT FOUND OR exp.amount<=0 OR exp.amount<>round(exp.amount,2)
    OR exp.company_account_id IS NULL
    OR exp.expense_classification NOT IN ('operating','non_operating')
    OR exp.category='payroll'
  THEN RAISE EXCEPTION 'GL_EXPENSE_NOT_CASH_VERIFIED' USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO v_count FROM public.account_transactions t
    WHERE t.tenant_id=p_tenant_id AND t.related_expense_id=exp.id;
  IF v_count<>1 THEN RAISE EXCEPTION 'GL_EXPENSE_CASH_LINK_MISSING' USING ERRCODE='22023'; END IF;
  SELECT * INTO a FROM public.account_transactions t
    WHERE t.tenant_id=p_tenant_id AND t.related_expense_id=exp.id FOR SHARE;
  IF a.site_id IS DISTINCT FROM p_site_id OR a.transaction_type<>'withdrawal'
     OR a.amount<>exp.amount OR a.account_id<>exp.company_account_id
  THEN RAISE EXCEPTION 'GL_EXPENSE_CASH_MISMATCH' USING ERRCODE='22023'; END IF;
  SELECT * INTO ca FROM public.company_accounts
    WHERE id=a.account_id AND tenant_id=p_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'GL_EXPENSE_CASH_ACCOUNT_UNKNOWN' USING ERRCODE='22023'; END IF;
  v_cash_account:=CASE WHEN ca.account_type='cash' THEN '1010' ELSE '1020' END;
  v_period:=to_char(exp.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM');
  v_lines:=jsonb_build_array(
   jsonb_build_object('code',CASE WHEN exp.expense_classification='operating'
      THEN '5100' ELSE '6100' END,'side','debit','amount',exp.amount),
   jsonb_build_object('code',v_cash_account,'side','credit','amount',exp.amount));
  v_payload:=jsonb_build_object('id',exp.id,'amount',exp.amount,'occurredAt',exp.occurred_at,
    'classification',exp.expense_classification,'category',exp.category,
    'movementId',a.id,'accountId',a.account_id,'cashType',ca.account_type);
  v_policy:='cash-expense-no-double-count-v1';
 ELSIF p_source_type='stock_movement' THEN
  SELECT * INTO stock FROM public.inventory_stock_movements
   WHERE id=p_source_id AND tenant_id=p_tenant_id AND site_id=p_site_id FOR SHARE;
  IF NOT FOUND OR stock.total_cost_amount<=0 OR stock.total_cost_amount<>round(stock.total_cost_amount,2)
    OR stock.quantity<=0 OR stock.quantity*stock.unit_cost<>stock.total_cost_amount
    OR NOT EXISTS(SELECT 1 FROM public.inventory_items it
      WHERE it.id=stock.item_id AND it.tenant_id=p_tenant_id
        AND it.accounting_treatment='expense_on_issue')
  THEN RAISE EXCEPTION 'GL_STOCK_QUANTITY_COST_OR_CLASS_INVALID' USING ERRCODE='22023'; END IF;
  v_period:=to_char(stock.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM');
  IF stock.movement_type='issue' THEN
    v_lines:=jsonb_build_array(
      jsonb_build_object('code','5100','side','debit','amount',stock.total_cost_amount),
      jsonb_build_object('code','1300','side','credit','amount',stock.total_cost_amount));
  ELSIF stock.movement_type='adjustment_in' THEN
    IF stock.reversal_of_movement_id IS NULL THEN
      RAISE EXCEPTION 'GL_STOCK_ADJUSTMENT_NEEDS_SOURCE_LINK' USING ERRCODE='22023'; END IF;
    SELECT * INTO original FROM public.inventory_stock_movements m
    WHERE m.id=stock.reversal_of_movement_id AND m.tenant_id=p_tenant_id
      AND m.site_id=p_site_id AND m.movement_type='issue' FOR SHARE;
    IF NOT FOUND OR original.item_id<>stock.item_id OR original.quantity<>stock.quantity
      OR original.total_cost_amount<>stock.total_cost_amount THEN
      RAISE EXCEPTION 'GL_STOCK_REVERSAL_NOT_MATCHED' USING ERRCODE='22023'; END IF;
    SELECT id INTO v_reversal_id FROM public.financial_gl_entries e
      WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
        AND e.source_type='stock_movement' AND e.source_id=original.id::text
        AND e.source_revision=1;
    IF v_reversal_id IS NULL THEN
      RAISE EXCEPTION 'GL_STOCK_REVERSAL_ORIGINAL_NOT_POSTED' USING ERRCODE='22023'; END IF;
    v_lines:=jsonb_build_array(
      jsonb_build_object('code','1300','side','debit','amount',stock.total_cost_amount),
      jsonb_build_object('code','5100','side','credit','amount',stock.total_cost_amount));
  ELSE
    RAISE EXCEPTION 'GL_STOCK_EVENT_ACCOUNTED_VIA_SUPPLIER_LEDGER_OR_UNSUPPORTED'
      USING ERRCODE='22023';
  END IF;
  v_payload:=jsonb_build_object('id',stock.id,'itemId',stock.item_id,
    'type',stock.movement_type,'quantity',stock.quantity,'unitCost',stock.unit_cost,
    'cost',stock.total_cost_amount,'date',stock.occurred_at,
    'reversesMovement',stock.reversal_of_movement_id);
  v_policy:='inventory-expense-on-issue-v1';
 ELSIF p_source_type='supplier_ledger' THEN
  SELECT * INTO supplier FROM public.supplier_ledger_entries
   WHERE id=p_source_id AND tenant_id=p_tenant_id AND site_id=p_site_id FOR SHARE;
  IF NOT FOUND OR supplier.entry_type NOT IN ('purchase','supplier_return','payment')
    OR supplier.debit_amount<0 OR supplier.credit_amount<0
    OR supplier.debit_amount<>round(supplier.debit_amount,2)
    OR supplier.credit_amount<>round(supplier.credit_amount,2)
  THEN RAISE EXCEPTION 'GL_SUPPLIER_EVENT_INVALID' USING ERRCODE='22023'; END IF;
  v_period:=to_char(supplier.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM');
  IF supplier.entry_type='purchase' THEN
    SELECT * INTO purch FROM public.supplier_purchases
     WHERE id=supplier.purchase_id AND tenant_id=p_tenant_id AND site_id=p_site_id FOR SHARE;
    SELECT coalesce(sum(m.total_cost_amount),0),count(*) INTO v_sum,v_count
    FROM public.inventory_stock_movements m WHERE m.tenant_id=p_tenant_id
      AND m.site_id=p_site_id AND m.purchase_id=supplier.purchase_id
      AND m.movement_type='purchase_receipt';
    IF NOT FOUND OR purch.id IS NULL OR purch.status<>'received'
       OR v_count<1 OR supplier.debit_amount<>0 OR supplier.credit_amount<=0
       OR v_sum<>supplier.credit_amount
       OR purch.total_amount<>supplier.credit_amount THEN
      RAISE EXCEPTION 'GL_SUPPLIER_PURCHASE_NOT_RECEIVED_OR_RECONCILED' USING ERRCODE='22023'; END IF;
    v_lines:=jsonb_build_array(
      jsonb_build_object('code','1300','side','debit','amount',v_sum),
      jsonb_build_object('code','2300','side','credit','amount',supplier.credit_amount));
  ELSIF supplier.entry_type='supplier_return' THEN
    SELECT coalesce(sum(m.total_cost_amount),0),count(*) INTO v_sum,v_count
    FROM public.inventory_stock_movements m WHERE m.tenant_id=p_tenant_id
     AND m.site_id=p_site_id AND m.purchase_id=supplier.purchase_id
     AND m.movement_type='supplier_return';
    IF supplier.supplier_return_id IS NULL OR supplier.debit_amount<=0
      OR supplier.credit_amount<>0 OR v_sum<>supplier.debit_amount OR v_count<1
      OR NOT EXISTS(SELECT 1 FROM public.financial_gl_entries e
       WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
       AND e.source_type='supplier_ledger' AND e.source_id IN (
          SELECT s.id::text FROM public.supplier_ledger_entries s
          WHERE s.tenant_id=p_tenant_id AND s.site_id=p_site_id
            AND s.entry_type='purchase' AND s.purchase_id=supplier.purchase_id))
    THEN RAISE EXCEPTION 'GL_SUPPLIER_RETURN_NOT_RECONCILED' USING ERRCODE='22023'; END IF;
    v_lines:=jsonb_build_array(
      jsonb_build_object('code','2300','side','debit','amount',supplier.debit_amount),
      jsonb_build_object('code','1300','side','credit','amount',supplier.debit_amount));
  ELSE
    SELECT * INTO sp FROM public.supplier_payments
      WHERE id=supplier.supplier_payment_id AND tenant_id=p_tenant_id
       AND site_id=p_site_id FOR SHARE;
    IF NOT FOUND OR sp.status<>'posted' OR sp.amount<=0
       OR sp.amount<>supplier.debit_amount OR supplier.credit_amount<>0
       OR sp.account_transaction_id IS NULL
    THEN RAISE EXCEPTION 'GL_SUPPLIER_PAYMENT_NOT_POSTED' USING ERRCODE='22023'; END IF;
    SELECT * INTO a FROM public.account_transactions
      WHERE id=sp.account_transaction_id AND tenant_id=p_tenant_id FOR SHARE;
    IF NOT FOUND OR a.site_id IS DISTINCT FROM p_site_id
       OR a.related_supplier_payment_id<>sp.id
       OR a.transaction_type<>'withdrawal' OR a.amount<>sp.amount
       OR a.account_id<>sp.company_account_id
    THEN RAISE EXCEPTION 'GL_SUPPLIER_PAYMENT_CASH_MISMATCH' USING ERRCODE='22023'; END IF;
    SELECT * INTO ca FROM public.company_accounts
      WHERE id=a.account_id AND tenant_id=p_tenant_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GL_SUPPLIER_PAYMENT_ACCOUNT_UNKNOWN' USING ERRCODE='22023'; END IF;
    v_cash_account:=CASE WHEN ca.account_type='cash' THEN '1010' ELSE '1020' END;
    v_lines:=jsonb_build_array(
      jsonb_build_object('code','2300','side','debit','amount',supplier.debit_amount),
      jsonb_build_object('code',v_cash_account,'side','credit','amount',supplier.debit_amount));
    -- Supplier purchase is recognized once from supplier_ledger, never
    -- a second expense from the matching bank movement or receipt.
    IF NOT EXISTS(SELECT 1 FROM public.financial_gl_entries e
       WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
         AND e.source_type='supplier_ledger' AND e.source_id IN
         (SELECT sl.id::text FROM public.supplier_ledger_entries sl
          WHERE sl.tenant_id=p_tenant_id AND sl.site_id=p_site_id
            AND sl.entry_type='purchase' AND sl.purchase_id=supplier.purchase_id))
    THEN RAISE EXCEPTION 'GL_SUPPLIER_PAYMENT_PURCHASE_NOT_POSTED' USING ERRCODE='22023'; END IF;
  END IF;
  v_payload:=jsonb_build_object('id',supplier.id,'type',supplier.entry_type,
    'date',supplier.occurred_at,'purchaseId',supplier.purchase_id,
    'returnId',supplier.supplier_return_id,'paymentId',supplier.supplier_payment_id,
    'debit',supplier.debit_amount,'credit',supplier.credit_amount,
    'accountTxId',a.id,'receiptAmount',CASE WHEN supplier.entry_type='payment' THEN NULL ELSE v_sum END);
  v_policy:='supplier-event-no-stock-duplication-v1';
 ELSIF p_source_type='payroll' THEN
  SELECT * INTO payroll FROM public.payroll_runs WHERE id=p_source_id
    AND tenant_id=p_tenant_id AND site_id=p_site_id FOR SHARE;
  IF NOT FOUND OR payroll.status<>'approved'
    OR payroll.approved_by_user_id IS NULL
    OR payroll.approved_by_user_id=payroll.created_by_user_id
    OR payroll.total_gross<=0 OR payroll.total_net<=0 OR payroll.total_deductions<0
    OR payroll.total_gross<>payroll.total_net+payroll.total_deductions
  THEN RAISE EXCEPTION 'GL_PAYROLL_DRAFT_OR_UNAPPROVED' USING ERRCODE='22023'; END IF;
  SELECT count(*),coalesce(sum(it.base_amount+it.extra_amount),0),
    coalesce(sum(it.net_amount),0),coalesce(sum(it.advance_deduction),0),
    coalesce(sum(it.other_deduction),0)
  INTO v_count,v_gross,v_net,v_adv,v_other FROM public.payroll_items it
  WHERE it.payroll_run_id=payroll.id;
  -- Payroll paid state needs a separately verified cash settlement. The
  -- accrual entry below must never misstate a paid run as unpaid liability.
  IF payroll.paid_at IS NOT NULL OR payroll.paid_from_account_id IS NOT NULL
  THEN RAISE EXCEPTION 'GL_PAYROLL_PAYMENT_REQUIRES_CASH_RECONCILIATION'
    USING ERRCODE='22023'; END IF;
  IF v_count<1 OR v_gross<>payroll.total_gross OR v_net<>payroll.total_net
    OR v_adv+v_other<>payroll.total_deductions OR v_adv<0 OR v_other<0
    OR payroll.total_gross<>round(payroll.total_gross,2)
  THEN RAISE EXCEPTION 'GL_PAYROLL_ITEMS_RECONCILIATION_FAILED' USING ERRCODE='22023'; END IF;
  v_period:=payroll.period;
  v_lines:=jsonb_build_array(
    jsonb_build_object('code','5200','side','debit','amount',v_gross),
    jsonb_build_object('code','2400','side','credit','amount',v_net));
  IF v_adv>0 THEN v_lines:=v_lines||jsonb_build_array(
    jsonb_build_object('code','1700','side','credit','amount',v_adv)); END IF;
  IF v_other>0 THEN v_lines:=v_lines||jsonb_build_array(
    jsonb_build_object('code','2450','side','credit','amount',v_other)); END IF;
  v_payload:=jsonb_build_object('id',payroll.id,'period',payroll.period,
    'gross',v_gross,'net',v_net,'advance',v_adv,'other',v_other,
    'approvedBy',payroll.approved_by_user_id,'itemCount',v_count);
  v_policy:='payroll-accrued-gross-advance-deductions-v1';
 END IF;
 IF v_lines IS NULL OR jsonb_typeof(v_lines)<>'array' OR jsonb_array_length(v_lines)<2
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_lines) item
       WHERE (item->>'amount')::numeric<=0
          OR (item->>'amount')::numeric<>round((item->>'amount')::numeric,2))
    OR (SELECT sum(CASE WHEN item->>'side'='debit' THEN (item->>'amount')::numeric
                   ELSE -(item->>'amount')::numeric END)
        FROM jsonb_array_elements(v_lines) item)<>0
 THEN RAISE EXCEPTION 'GL_SOURCE_PLAN_NOT_BALANCED' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('tenantId',p_tenant_id,'siteId',p_site_id,
    'sourceType',p_source_type,'sourceId',p_source_id,'period',v_period,
    'policyVersion',v_policy,'lines',v_lines,'reversesEntryId',v_reversal_id,
    'sourceFingerprint',encode(sha256(convert_to(v_payload::text,'UTF8')),'hex'),
    'accountingCertification','NOT_CERTIFIED');
END;
$plan$;

-- A site ledger event is created under a deterministic tenant/site advisory lock;
-- retries are reconciled to identical source, policy and line multiset.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_post_source(
 p_tenant_id bigint,p_site_id bigint,p_source_type text,p_source_id bigint,
 p_user_id bigint
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $posting$
DECLARE
 v_plan jsonb;v_entry public.financial_gl_entries%ROWTYPE;
 v_period text;v_lines jsonb;v_fingerprint text;v_policy text;v_key text;
 v_line jsonb;v_debit numeric;v_credit numeric;v_expected bigint;
 v_reversal_id bigint;v_count bigint;v_required numeric;v_available numeric;
BEGIN
 IF p_user_id IS NULL OR p_user_id<=0 OR NOT EXISTS(
    SELECT 1 FROM public.users u WHERE u.id=p_user_id)
 THEN RAISE EXCEPTION 'GL_SOURCE_ACTOR_INVALID' USING ERRCODE='22023'; END IF;
 v_plan:=public.powerhub_financial_gl_source_plan(
   p_tenant_id,p_site_id,p_source_type,p_source_id);
 v_period:=v_plan->>'period';v_lines:=v_plan->'lines';
 v_fingerprint:=v_plan->>'sourceFingerprint';v_policy:=v_plan->>'policyVersion';
 v_reversal_id:=(v_plan->>'reversesEntryId')::bigint;
 v_key:='gl:source:'||p_source_type||':'||p_source_id||':v1';
 -- Match the existing accrual/opening lock hierarchy: period before site.
 PERFORM pg_advisory_xact_lock(hashtextextended(
   'powerhub:accrual-period:'||p_tenant_id||':'||p_site_id||':'||v_period,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(
   'powerhub:gl-site:'||p_tenant_id||':'||p_site_id,0));
 -- Source may have changed while waiting for locks: derive and compare again.
 IF public.powerhub_financial_gl_source_plan(
     p_tenant_id,p_site_id,p_source_type,p_source_id)->>'sourceFingerprint'
     IS DISTINCT FROM v_fingerprint
 THEN RAISE EXCEPTION 'GL_SOURCE_CHANGED_DURING_POST'
    USING ERRCODE='40001'; END IF;
 SELECT * INTO v_entry FROM public.financial_gl_entries e
 WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
   AND e.source_type=p_source_type AND e.source_id=p_source_id::text
   AND e.source_revision=1;
 IF FOUND THEN
   IF v_entry.period<>v_period OR v_entry.source_fingerprint<>v_fingerprint
      OR v_entry.operation_key<>v_key OR v_entry.accounting_policy_version<>v_policy
      OR v_entry.reverses_entry_id IS DISTINCT FROM v_reversal_id
      OR EXISTS (
        SELECT code,side,amount,count(*) FROM
          (SELECT v->>'code' AS code,v->>'side' AS side,(v->>'amount')::numeric AS amount
           FROM jsonb_array_elements(v_lines) v) want GROUP BY code,side,amount
        EXCEPT
        SELECT account_code,side,amount,count(*) FROM public.financial_gl_lines
        WHERE entry_id=v_entry.id GROUP BY account_code,side,amount
      )
      OR EXISTS(
        SELECT account_code,side,amount,count(*) FROM public.financial_gl_lines
        WHERE entry_id=v_entry.id GROUP BY account_code,side,amount
        EXCEPT
        SELECT code,side,amount,count(*) FROM
          (SELECT v->>'code' AS code,v->>'side' AS side,(v->>'amount')::numeric AS amount
           FROM jsonb_array_elements(v_lines) v) want GROUP BY code,side,amount
      )
   THEN RAISE EXCEPTION 'GL_SOURCE_REPLAY_MISMATCH' USING ERRCODE='23505'; END IF;
   RETURN jsonb_build_object('status','posted','alreadyPosted',true,'entryId',v_entry.id,
     'sourceType',p_source_type,'sourceId',p_source_id);
 END IF;
 IF EXISTS(SELECT 1 FROM public.financial_accrual_period_reviews r
   WHERE r.tenant_id=p_tenant_id AND r.site_id=p_site_id
    AND r.period=v_period AND r.status='locked')
 THEN RAISE EXCEPTION 'GL_SOURCE_PERIOD_LOCKED' USING ERRCODE='22023'; END IF;
 -- No postings without a separately approved documentary opening. Without it,
 -- arithmetic GL equality can conceal missing historical cash, stock and debts.
 IF NOT EXISTS(SELECT 1 FROM public.financial_gl_opening_batches b
    WHERE b.tenant_id=p_tenant_id AND b.site_id=p_site_id AND b.status='posted'
      AND b.period<=v_period AND EXISTS(
       SELECT 1 FROM public.financial_gl_entries e
       WHERE e.tenant_id=b.tenant_id AND e.site_id=b.site_id
         AND e.source_type='opening_balance' AND e.source_id=b.id::text
         AND e.source_fingerprint=b.source_fingerprint))
 THEN RAISE EXCEPTION 'GL_DOCUMENTED_OPENING_REQUIRED' USING ERRCODE='22023'; END IF;
 -- Source cost/settlement may not consume more than the documented GL
 -- asset or liability available at this site. Check AFTER acquiring both
 -- advisory locks, so two concurrent issues cannot spend the same stock.
 FOR v_line IN SELECT jsonb_array_elements(v_lines) LOOP
   IF (v_line->>'side')='credit' AND (v_line->>'code') IN ('1300','1700') THEN
     v_required:=(v_line->>'amount')::numeric;
     SELECT coalesce(sum(CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END),0)
       INTO v_available
     FROM public.financial_gl_lines l JOIN public.financial_gl_entries e ON e.id=l.entry_id
     WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
       AND e.period<=v_period AND l.account_code=v_line->>'code';
     IF v_available<v_required THEN
       RAISE EXCEPTION 'GL_SOURCE_ASSET_NOT_SUPPORTED_BY_LEDGER'
         USING ERRCODE='22023'; END IF;
   ELSIF (v_line->>'side')='debit' AND (v_line->>'code')='2300' THEN
     v_required:=(v_line->>'amount')::numeric;
     SELECT coalesce(sum(CASE WHEN l.side='credit' THEN l.amount ELSE -l.amount END),0)
       INTO v_available
     FROM public.financial_gl_lines l JOIN public.financial_gl_entries e ON e.id=l.entry_id
     WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
       AND e.period<=v_period AND l.account_code='2300';
     IF v_available<v_required THEN
       RAISE EXCEPTION 'GL_SUPPLIER_PAYMENT_EXCEEDS_LIABILITY'
         USING ERRCODE='22023'; END IF;
   END IF;
 END LOOP;
 PERFORM public.powerhub_financial_gl_seed_chart(p_tenant_id);
 INSERT INTO public.financial_gl_accounts(tenant_id,code,name,account_class,normal_side,is_contra)
 VALUES(p_tenant_id,'2250','أرصدة مقدمة للمشتركين','liability','credit',false),
       (p_tenant_id,'2450','استقطاعات رواتب مستحقة','liability','credit',false)
 ON CONFLICT(tenant_id,code) DO NOTHING;
 IF EXISTS(SELECT 1 FROM public.financial_gl_accounts a WHERE a.tenant_id=p_tenant_id
    AND a.code IN ('2250','2450')
    AND (a.account_class<>'liability' OR a.normal_side<>'credit' OR a.is_contra))
 THEN RAISE EXCEPTION 'GL_SOURCE_ACCOUNT_CATALOG_CONFLICT' USING ERRCODE='23514'; END IF;
 SELECT count(*) INTO v_count FROM jsonb_array_elements(v_lines) l
 LEFT JOIN public.financial_gl_accounts a ON a.tenant_id=p_tenant_id AND a.code=l->>'code'
 WHERE a.code IS NULL;
 IF v_count<>0 THEN RAISE EXCEPTION 'GL_SOURCE_ACCOUNT_UNKNOWN' USING ERRCODE='22023'; END IF;
 INSERT INTO public.financial_gl_entries(tenant_id,site_id,period,source_type,source_id,
   source_revision,operation_key,source_fingerprint,accounting_policy_version,
   posted_by_user_id,reverses_entry_id)
 VALUES(p_tenant_id,p_site_id,v_period,p_source_type,p_source_id::text,1,v_key,
   v_fingerprint,v_policy,p_user_id,v_reversal_id)
 RETURNING * INTO v_entry;
 INSERT INTO public.financial_gl_lines(entry_id,tenant_id,site_id,account_code,side,amount)
 SELECT v_entry.id,p_tenant_id,p_site_id,l->>'code',l->>'side',(l->>'amount')::numeric
 FROM jsonb_array_elements(v_lines) l;
 RETURN jsonb_build_object('status','posted','alreadyPosted',false,'entryId',v_entry.id,
   'sourceType',p_source_type,'sourceId',p_source_id,
   'accountingCertification','NOT_CERTIFIED');
END;
$posting$;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_source_plan(bigint,bigint,text,bigint)
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_post_source(bigint,bigint,text,bigint,bigint)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_source_plan(bigint,bigint,text,bigint)
 TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_post_source(bigint,bigint,text,bigint,bigint)
 TO service_role;
COMMENT ON FUNCTION public.powerhub_financial_gl_post_source(bigint,bigint,text,bigint,bigint)
 IS 'Source-bound financial projection, service-role only: preserves opening, period locks and exact replay; does not certify historical accounting completeness.';
NOTIFY pgrst,'reload schema';
