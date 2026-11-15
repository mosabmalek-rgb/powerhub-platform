-- D10: Source-backed supplier-return cash refunds and purchase-return valuation.
-- Corrects two distinct gaps: credit_note had no GL plan or linked cash audit,
-- and return invoice credit was incorrectly forced to equal moving-average stock cost.
-- No history rewrite; existing equal-credit/equal-cost return fingerprints remain unchanged.
-- Account 5100 (operating cost) absorbs the documented purchase-return valuation delta.
-- All postings remain explicit via the existing service-only source posting RPC.
-- Keep this file versioned in Git and release through the protected exact-version workflow.

CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_source_plan(p_tenant_id bigint, p_site_id bigint, p_source_type text, p_source_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
 i public.invoices%ROWTYPE; pay public.payments%ROWTYPE;
 exp public.expenses%ROWTYPE; stock public.inventory_stock_movements%ROWTYPE;
 supplier public.supplier_ledger_entries%ROWTYPE;
 ret public.supplier_purchase_returns%ROWTYPE;
 payroll public.payroll_runs%ROWTYPE;
 a public.account_transactions%ROWTYPE;
 ca public.company_accounts%ROWTYPE;
 purch public.supplier_purchases%ROWTYPE;
 sp public.supplier_payments%ROWTYPE;
 corr public.financial_supplier_payment_corrections%ROWTYPE;
 v_original_gl public.financial_gl_entries%ROWTYPE;
 v_origin_sl public.supplier_ledger_entries%ROWTYPE;
 v_refund_tx public.account_transactions%ROWTYPE;
 original public.inventory_stock_movements%ROWTYPE;
 op public.company_account_movement_operations%ROWTYPE;
 incoming public.account_transactions%ROWTYPE;
 destination_account public.company_accounts%ROWTYPE;
 v_source_cash_code text;v_destination_cash_code text;
 v_count bigint;v_sum numeric;v_gross numeric;v_net numeric;v_adv numeric;v_other numeric;
 v_return_line_count bigint;v_return_ledger_count bigint;
 v_return_line_credit numeric;v_return_line_cost numeric;v_return_delta numeric;
 v_payload jsonb;v_lines jsonb:='[]'::jsonb;v_policy text;v_period text;
 v_reversal_id bigint;v_cash_account text;v_amount numeric;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0 OR p_site_id IS NULL OR p_site_id<=0
   OR p_source_id IS NULL OR p_source_id<=0 OR p_source_type IS NULL
   OR p_source_type NOT IN('invoice','payment','expense','stock_movement','supplier_ledger','payroll','payroll_payment','account_movement')
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
 ELSIF p_source_type='account_movement' THEN
  -- The primary transaction id is the stable numeric key of a transfer operation.
  SELECT * INTO op FROM public.company_account_movement_operations x
  WHERE x.tenant_id=p_tenant_id AND x.site_id=p_site_id
    AND x.primary_transaction_id=p_source_id AND x.operation_type='transfer'
    FOR SHARE;
  IF NOT FOUND OR op.counterpart_transaction_id IS NULL
     OR (SELECT count(*) FROM public.company_account_movement_operations x
       WHERE x.tenant_id=p_tenant_id AND x.primary_transaction_id=p_source_id)<>1
  THEN RAISE EXCEPTION 'GL_COMPANY_TRANSFER_OPERATION_NOT_FOUND' USING ERRCODE='22023'; END IF;
  SELECT * INTO a FROM public.account_transactions t
  WHERE t.tenant_id=p_tenant_id AND t.id=op.primary_transaction_id FOR SHARE;
  SELECT * INTO incoming FROM public.account_transactions t
  WHERE t.tenant_id=p_tenant_id AND t.id=op.counterpart_transaction_id FOR SHARE;
  SELECT * INTO ca FROM public.company_accounts ac
  WHERE ac.tenant_id=p_tenant_id AND ac.id=a.account_id FOR SHARE;
  SELECT * INTO destination_account FROM public.company_accounts ac
  WHERE ac.tenant_id=p_tenant_id AND ac.id=incoming.account_id FOR SHARE;
  IF a.id IS NULL OR incoming.id IS NULL OR ca.id IS NULL OR destination_account.id IS NULL
     OR a.site_id IS DISTINCT FROM p_site_id
     OR incoming.site_id IS DISTINCT FROM p_site_id
     OR a.transaction_type<>'transfer_out' OR incoming.transaction_type<>'transfer_in'
     OR a.account_id=incoming.account_id
     OR a.related_account_id IS DISTINCT FROM incoming.account_id
     OR incoming.related_account_id IS DISTINCT FROM a.account_id
     OR a.amount IS DISTINCT FROM incoming.amount
     OR a.amount<=0 OR a.amount<>round(a.amount,2)
     OR a.description IS DISTINCT FROM incoming.description
     OR NOT EXISTS (SELECT 1 FROM generate_series(0,6) precision_scale
       WHERE op.payload_hash=md5(jsonb_build_object(
       'tenantId',p_tenant_id,'siteId',p_site_id,
       'userId',op.created_by_user_id,'fromAccountId',a.account_id,
       'toAccountId',incoming.account_id,'amount',round(a.amount,precision_scale),
       'description',btrim(a.description))::text))
     OR (SELECT count(*) FROM public.company_account_movement_operations x
       WHERE x.tenant_id=p_tenant_id
       AND x.counterpart_transaction_id=incoming.id)<>1
     OR a.created_by_user_id IS DISTINCT FROM op.created_by_user_id
     OR incoming.created_by_user_id IS DISTINCT FROM op.created_by_user_id
     OR ca.account_type NOT IN ('cash','jawwal_pay','palpay','bank_of_palestine','other')
     OR destination_account.account_type NOT IN ('cash','jawwal_pay','palpay','bank_of_palestine','other')
     OR to_char(a.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM')
        <>to_char(incoming.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM')
     OR EXISTS(SELECT 1 FROM public.company_account_sites s WHERE s.tenant_id=p_tenant_id AND s.account_id=a.account_id)
        AND NOT EXISTS(SELECT 1 FROM public.company_account_sites s WHERE s.tenant_id=p_tenant_id AND s.account_id=a.account_id AND s.site_id=p_site_id)
     OR EXISTS(SELECT 1 FROM public.company_account_sites s WHERE s.tenant_id=p_tenant_id AND s.account_id=incoming.account_id)
        AND NOT EXISTS(SELECT 1 FROM public.company_account_sites s WHERE s.tenant_id=p_tenant_id AND s.account_id=incoming.account_id AND s.site_id=p_site_id)
  THEN RAISE EXCEPTION 'GL_COMPANY_TRANSFER_PAIR_INVALID_OR_CROSS_SITE' USING ERRCODE='22023'; END IF;
  v_source_cash_code:=CASE WHEN ca.account_type='cash' THEN '1010' ELSE '1020' END;
  v_destination_cash_code:=CASE WHEN destination_account.account_type='cash' THEN '1010' ELSE '1020' END;
  v_period:=to_char(a.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM');
  v_lines:=jsonb_build_array(
    jsonb_build_object('code',v_destination_cash_code,'side','debit','amount',a.amount),
    jsonb_build_object('code',v_source_cash_code,'side','credit','amount',a.amount));
  v_payload:=jsonb_build_object('operationKey',op.operation_key,'payloadHash',op.payload_hash,
    'fromTransactionId',a.id,'toTransactionId',incoming.id,
    'fromAccount',a.account_id,'toAccount',incoming.account_id,
    'fromAccountType',ca.account_type,'toAccountType',destination_account.account_type,
    'fromOccurredAt',a.occurred_at,'toOccurredAt',incoming.occurred_at,
    'sourceAmount',a.amount,'destinationAmount',incoming.amount,'actor',op.created_by_user_id);
  v_policy:='company-transfer-paired-no-income-or-expense-v1';
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
  -- A paired warehouse transfer is NEVER an operating expense.
  -- The associated adjustment_in is a location move, not an undo of usage.
  IF stock.operation_key LIKE 'trf:%:out' OR
     stock.operation_key LIKE 'trf:%:in' THEN
    RAISE EXCEPTION 'GL_INTERNAL_STOCK_TRANSFER_NOT_AN_EXPENSE'
      USING ERRCODE='22023'; END IF;
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
  IF NOT FOUND OR supplier.entry_type NOT IN ('purchase','supplier_return','credit_note','payment','reversal')
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
    SELECT * INTO ret FROM public.supplier_purchase_returns r
    WHERE r.tenant_id=p_tenant_id AND r.site_id=p_site_id
      AND r.id=supplier.supplier_return_id AND r.purchase_id=supplier.purchase_id
    FOR SHARE;
    SELECT coalesce(sum(m.total_cost_amount),0),count(*) INTO v_sum,v_count
    FROM public.inventory_stock_movements m WHERE m.tenant_id=p_tenant_id
      AND m.site_id=p_site_id AND m.purchase_id=supplier.purchase_id
      AND m.movement_type='supplier_return'
      AND m.reference_no=supplier.reference_no;
    SELECT count(*),coalesce(sum(l.supplier_credit_amount),0),
      coalesce(sum(l.stock_cost_amount),0)
      INTO v_return_line_count,v_return_line_credit,v_return_line_cost
    FROM public.supplier_purchase_return_lines l
    WHERE l.tenant_id=p_tenant_id AND l.return_id=ret.id
      AND l.purchase_id=supplier.purchase_id;
    IF ret.id IS NULL OR ret.status<>'posted' OR ret.supplier_id<>supplier.supplier_id
      OR ret.return_number IS DISTINCT FROM supplier.reference_no
      OR ret.total_credit_amount<=0 OR ret.total_credit_amount<>round(ret.total_credit_amount,2)
      OR ret.stock_cost_amount<0 OR ret.stock_cost_amount<>round(ret.stock_cost_amount,2)
      OR ret.refund_amount<0 OR ret.refund_amount>ret.total_credit_amount
      OR supplier.debit_amount<>ret.total_credit_amount OR supplier.credit_amount<>0
      OR supplier.supplier_payment_id IS NOT NULL
      OR v_count<1 OR v_return_line_count<1 OR v_count<>v_return_line_count
      OR v_sum IS DISTINCT FROM ret.stock_cost_amount
      OR v_return_line_cost IS DISTINCT FROM ret.stock_cost_amount
      OR v_return_line_credit IS DISTINCT FROM ret.total_credit_amount
      OR EXISTS (
        SELECT 1 FROM public.supplier_purchase_return_lines l
        LEFT JOIN public.inventory_stock_movements m
          ON m.id=l.stock_movement_id AND m.tenant_id=l.tenant_id
          AND m.site_id=p_site_id AND m.purchase_id=l.purchase_id
          AND m.movement_type='supplier_return' AND m.reference_no=ret.return_number
          AND m.total_cost_amount=l.stock_cost_amount
        WHERE l.tenant_id=p_tenant_id AND l.return_id=ret.id
          AND (m.id IS NULL OR l.stock_cost_amount<0 OR l.supplier_credit_amount<0)
      )
      OR NOT EXISTS (SELECT 1 FROM public.financial_gl_entries e
        WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
          AND e.source_type='supplier_ledger'
          AND e.source_id IN (
            SELECT purchase_entry.id::text
            FROM public.supplier_ledger_entries purchase_entry
            WHERE purchase_entry.tenant_id=p_tenant_id
              AND purchase_entry.site_id=p_site_id
              AND purchase_entry.entry_type='purchase'
              AND purchase_entry.purchase_id=supplier.purchase_id))
    THEN RAISE EXCEPTION 'GL_SUPPLIER_RETURN_NOT_RECONCILED' USING ERRCODE='22023'; END IF;
    v_return_delta:=ret.total_credit_amount-ret.stock_cost_amount;
    -- Payable credit = invoice credit; inventory credit = carrying cost.
    -- Account 5100 records the disclosed purchase-return price/cost variance.
    v_lines:=jsonb_build_array(
      jsonb_build_object('code','2300','side','debit','amount',ret.total_credit_amount));
    IF ret.stock_cost_amount>0 THEN
      v_lines:=v_lines||jsonb_build_array(
        jsonb_build_object('code','1300','side','credit','amount',ret.stock_cost_amount));
    END IF;
    IF v_return_delta>0 THEN
      v_lines:=v_lines||jsonb_build_array(
        jsonb_build_object('code','5100','side','credit','amount',v_return_delta));
    ELSIF v_return_delta<0 THEN
      v_lines:=v_lines||jsonb_build_array(
        jsonb_build_object('code','5100','side','debit','amount',-v_return_delta));
    END IF;
  ELSIF supplier.entry_type='credit_note' THEN
    -- A cash refund offsets the gross supplier return credit: DR cash / CR AP.
    -- It is a distinct source, never a second inventory return or new income.
    SELECT * INTO ret FROM public.supplier_purchase_returns r
    WHERE r.tenant_id=p_tenant_id AND r.site_id=p_site_id
      AND r.id=supplier.supplier_return_id AND r.purchase_id=supplier.purchase_id
    FOR SHARE;
    SELECT count(*) INTO v_return_ledger_count
    FROM public.supplier_ledger_entries x
    WHERE x.tenant_id=p_tenant_id
      AND x.supplier_return_id=supplier.supplier_return_id
      AND x.entry_type='credit_note';
    SELECT count(*) INTO v_count FROM public.account_transactions t
    WHERE t.tenant_id=p_tenant_id
      AND t.related_supplier_return_id=supplier.supplier_return_id;
    SELECT * INTO a FROM public.account_transactions t
    WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id
      AND t.related_supplier_return_id=supplier.supplier_return_id
    FOR SHARE;
    SELECT * INTO ca FROM public.company_accounts c
    WHERE c.tenant_id=p_tenant_id AND c.id=ret.refund_company_account_id
    FOR SHARE;
    IF ret.id IS NULL OR ret.status<>'posted' OR ret.supplier_id<>supplier.supplier_id
      OR ret.return_number IS DISTINCT FROM supplier.reference_no
      OR ret.refund_amount<=0 OR ret.refund_amount<>round(ret.refund_amount,2)
      OR ret.refund_amount>ret.total_credit_amount
      OR supplier.credit_amount<>ret.refund_amount OR supplier.debit_amount<>0
      OR supplier.supplier_payment_id IS NOT NULL
      OR v_return_ledger_count<>1 OR v_count<>1 OR a.id IS NULL OR ca.id IS NULL
      OR a.site_id IS DISTINCT FROM p_site_id
      OR a.account_id IS DISTINCT FROM ret.refund_company_account_id
      OR a.amount IS DISTINCT FROM ret.refund_amount
      OR a.transaction_type<>'deposit'
      OR a.reference_no IS DISTINCT FROM ret.return_number
      OR a.occurred_at IS DISTINCT FROM supplier.occurred_at
      OR ca.account_type NOT IN ('cash','jawwal_pay','palpay','bank_of_palestine','other')
      OR NOT EXISTS (
        SELECT 1 FROM public.supplier_ledger_entries sr
        JOIN public.financial_gl_entries g
          ON g.tenant_id=sr.tenant_id AND g.site_id=sr.site_id
          AND g.source_type='supplier_ledger' AND g.source_id=sr.id::text
        WHERE sr.tenant_id=p_tenant_id AND sr.site_id=p_site_id
          AND sr.entry_type='supplier_return'
          AND sr.supplier_return_id=ret.id
          AND sr.debit_amount=ret.total_credit_amount
          AND sr.credit_amount=0)
    THEN RAISE EXCEPTION 'GL_SUPPLIER_RETURN_REFUND_NOT_RECONCILED' USING ERRCODE='22023'; END IF;
    v_cash_account:=CASE WHEN ca.account_type='cash' THEN '1010' ELSE '1020' END;
    v_sum:=ret.refund_amount;
    v_lines:=jsonb_build_array(
      jsonb_build_object('code',v_cash_account,'side','debit','amount',ret.refund_amount),
      jsonb_build_object('code','2300','side','credit','amount',ret.refund_amount));
  ELSIF supplier.entry_type='reversal' THEN
    SELECT * INTO corr FROM public.financial_supplier_payment_corrections c
      WHERE c.tenant_id=p_tenant_id AND c.site_id=p_site_id
      AND c.payment_id=supplier.supplier_payment_id
      AND c.reversal_supplier_ledger_entry_id=supplier.id
      AND c.status IN ('posting','posted') FOR SHARE;
    SELECT * INTO sp FROM public.supplier_payments
      WHERE tenant_id=p_tenant_id AND site_id=p_site_id
        AND id=supplier.supplier_payment_id FOR SHARE;
    SELECT * INTO v_origin_sl FROM public.supplier_ledger_entries
      WHERE tenant_id=p_tenant_id AND site_id=p_site_id
        AND id=corr.original_supplier_ledger_id FOR SHARE;
    SELECT * INTO v_original_gl FROM public.financial_gl_entries
      WHERE tenant_id=p_tenant_id AND site_id=p_site_id
        AND id=corr.original_gl_entry_id;
    SELECT * INTO v_refund_tx FROM public.account_transactions
      WHERE tenant_id=p_tenant_id AND site_id=p_site_id
        AND id=corr.refund_transaction_id FOR SHARE;
    IF corr.id IS NULL OR sp.id IS NULL OR v_origin_sl.id IS NULL
       OR v_original_gl.id IS NULL OR v_refund_tx.id IS NULL
       OR corr.amount<=0 OR corr.amount<>sp.amount
       OR sp.status<>'reversed'
       OR sp.reversed_by_user_id IS DISTINCT FROM corr.approved_by_user_id
       OR sp.reversal_reason IS DISTINCT FROM corr.reason
       OR corr.requested_by_user_id=corr.approved_by_user_id
       OR corr.approved_at IS NULL
       OR supplier.supplier_id<>sp.supplier_id
       OR supplier.debit_amount<>0 OR supplier.credit_amount<>corr.amount
       OR supplier.entry_key IS DISTINCT FROM 'supplier-payment-reversal:'||sp.id
       OR v_origin_sl.entry_type<>'payment'
       OR v_origin_sl.supplier_payment_id<>sp.id
       OR v_origin_sl.debit_amount<>corr.amount
       OR v_original_gl.source_type<>'supplier_ledger'
       OR v_original_gl.source_id IS DISTINCT FROM v_origin_sl.id::text
       OR v_original_gl.source_fingerprint IS DISTINCT FROM corr.original_gl_fingerprint
       OR v_refund_tx.account_id<>sp.company_account_id
       OR v_refund_tx.related_supplier_payment_id IS NOT NULL
       OR v_refund_tx.transaction_type<>'deposit'
       OR v_refund_tx.amount<>sp.amount
       OR v_refund_tx.reference_no IS DISTINCT FROM 'REV-SUPPLIER-PAYMENT-'||sp.id
       OR EXISTS(SELECT 1 FROM public.financial_gl_entries e
         WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
         AND e.reverses_entry_id=v_original_gl.id
         AND e.source_id IS DISTINCT FROM supplier.id::text)
    THEN RAISE EXCEPTION 'GL_SUPPLIER_CORRECTION_SOURCE_INVALID' USING ERRCODE='22023'; END IF;
    SELECT * INTO ca FROM public.company_accounts
      WHERE tenant_id=p_tenant_id AND id=sp.company_account_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GL_SUPPLIER_CORRECTION_ACCOUNT_MISSING' USING ERRCODE='22023'; END IF;
    v_cash_account:=CASE WHEN ca.account_type='cash' THEN '1010' ELSE '1020' END;
    IF (SELECT count(*) FROM public.financial_gl_lines l
      WHERE l.entry_id=v_original_gl.id)<>2
       OR NOT EXISTS(SELECT 1 FROM public.financial_gl_lines l
        WHERE l.entry_id=v_original_gl.id AND l.account_code='2300'
          AND l.side='debit' AND l.amount=sp.amount)
       OR NOT EXISTS(SELECT 1 FROM public.financial_gl_lines l
        WHERE l.entry_id=v_original_gl.id AND l.account_code=v_cash_account
          AND l.side='credit' AND l.amount=sp.amount)
    THEN RAISE EXCEPTION 'GL_SUPPLIER_CORRECTION_ORIGINAL_LINES_CHANGED'
       USING ERRCODE='22023'; END IF;
    v_reversal_id:=v_original_gl.id;
    v_lines:=jsonb_build_array(
      jsonb_build_object('code',v_cash_account,'side','debit','amount',sp.amount),
      jsonb_build_object('code','2300','side','credit','amount',sp.amount));
    v_policy:='supplier-payment-source-correction-v1';
    v_payload:=jsonb_build_object(
      'id',supplier.id,'type','reversal','date',supplier.occurred_at,
      'paymentId',sp.id,'amount',sp.amount,'originalLedgerId',v_origin_sl.id,
      'originalGlId',v_original_gl.id,'originalSha',corr.original_gl_fingerprint,
      'correctionId',corr.id,'refundTransactionId',v_refund_tx.id,
      'makerId',corr.requested_by_user_id,'checkerId',corr.approved_by_user_id,
      'approvedAt',corr.approved_at);
  ELSE
    SELECT * INTO sp FROM public.supplier_payments
      WHERE id=supplier.supplier_payment_id AND tenant_id=p_tenant_id
       AND site_id=p_site_id FOR SHARE;
    IF NOT FOUND OR (sp.status<>'posted' AND NOT (sp.status='reversed' AND
      public.powerhub_financial_supplier_payment_correction_proof(p_tenant_id,p_site_id,sp.id)
        ='SOURCE_BACKED_REVERSAL_VALID')) OR sp.amount<=0
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
  IF supplier.entry_type<>'reversal' THEN
  v_payload:=jsonb_build_object('id',supplier.id,'type',supplier.entry_type,
    'date',supplier.occurred_at,'purchaseId',supplier.purchase_id,
    'returnId',supplier.supplier_return_id,'paymentId',supplier.supplier_payment_id,
    'debit',supplier.debit_amount,'credit',supplier.credit_amount,
    'accountTxId',a.id,'receiptAmount',CASE WHEN supplier.entry_type='payment' THEN NULL ELSE v_sum END);
  v_policy:=CASE
    WHEN supplier.entry_type='credit_note' THEN 'supplier-return-cash-refund-v1'
    WHEN supplier.entry_type='supplier_return' AND v_return_delta<>0
      THEN 'supplier-return-price-variance-5100-v1'
    ELSE 'supplier-event-no-stock-duplication-v1' END;
  END IF;
 ELSIF p_source_type='payroll' THEN
  SELECT * INTO payroll FROM public.payroll_runs WHERE id=p_source_id
    AND tenant_id=p_tenant_id AND site_id=p_site_id FOR SHARE;
  IF NOT FOUND OR
    (payroll.status<>'approved' AND NOT (
       payroll.status='paid' AND EXISTS(
         SELECT 1 FROM public.financial_gl_entries e
         WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
           AND e.source_type='payroll' AND e.source_id=payroll.id::text
           AND e.source_revision=1)))
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
  IF payroll.status='approved' AND
     (payroll.paid_at IS NOT NULL OR payroll.paid_from_account_id IS NOT NULL)
  THEN RAISE EXCEPTION 'GL_PAYROLL_PAYMENT_REQUIRES_CASH_RECONCILIATION'
    USING ERRCODE='22023'; END IF;
  IF v_count<1 OR v_gross<>payroll.total_gross OR v_net<>payroll.total_net
    OR v_adv+v_other<>payroll.total_deductions OR v_adv<0 OR v_other<0
    OR payroll.total_gross<>round(payroll.total_gross,2)
  THEN RAISE EXCEPTION 'GL_PAYROLL_ITEMS_RECONCILIATION_FAILED' USING ERRCODE='22023'; END IF;
  IF NOT public.powerhub_payroll_advance_allocations_valid(p_tenant_id,p_site_id,payroll.id,payroll.period) THEN
    RAISE EXCEPTION 'GL_PAYROLL_ADVANCE_DISBURSEMENT_OR_ALLOCATION_INVALID' USING ERRCODE='23514';
  END IF;
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
 ELSIF p_source_type='payroll_payment' THEN
  SELECT * INTO payroll FROM public.payroll_runs WHERE id=p_source_id
    AND tenant_id=p_tenant_id AND site_id=p_site_id FOR SHARE;
  IF NOT FOUND OR payroll.status<>'paid'
     OR payroll.paid_at IS NULL OR payroll.paid_from_account_id IS NULL
     OR payroll.total_net<=0 OR payroll.total_net<>round(payroll.total_net,2)
     OR payroll.approved_by_user_id IS NULL
     OR payroll.created_by_user_id=payroll.approved_by_user_id
     OR NOT EXISTS (SELECT 1 FROM public.financial_gl_entries e
         WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
          AND e.source_type='payroll' AND e.source_id=payroll.id::text)
  THEN RAISE EXCEPTION 'GL_PAYROLL_PAYOUT_ACCRUAL_NOT_POSTED'
    USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO v_count FROM public.expenses e
    WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
      AND e.category='payroll' AND e.reference_no='PAYROLL-'||payroll.id;
  IF v_count<>1 THEN RAISE EXCEPTION 'GL_PAYROLL_PAYOUT_EXPENSE_MISSING'
    USING ERRCODE='22023'; END IF;
  SELECT * INTO exp FROM public.expenses e
    WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
      AND e.category='payroll' AND e.reference_no='PAYROLL-'||payroll.id
    FOR SHARE;
  IF exp.amount<>payroll.total_net OR exp.company_account_id<>payroll.paid_from_account_id
    THEN RAISE EXCEPTION 'GL_PAYROLL_PAYOUT_AMOUNT_MISMATCH'
      USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO v_count FROM public.account_transactions tx
    WHERE tx.tenant_id=p_tenant_id AND tx.site_id=p_site_id
      AND tx.reference_no='PAYROLL-'||payroll.id;
  IF v_count<>1 THEN RAISE EXCEPTION 'GL_PAYROLL_PAYOUT_CASH_MOVEMENT_MISSING'
    USING ERRCODE='22023'; END IF;
  SELECT * INTO a FROM public.account_transactions tx
    WHERE tx.tenant_id=p_tenant_id AND tx.site_id=p_site_id
      AND tx.reference_no='PAYROLL-'||payroll.id FOR SHARE;
  IF a.related_expense_id<>exp.id OR a.transaction_type<>'withdrawal'
     OR a.amount<>payroll.total_net OR a.account_id<>payroll.paid_from_account_id
     OR (a.occurred_at AT TIME ZONE 'Asia/Gaza')::date<>(payroll.paid_at AT TIME ZONE 'Asia/Gaza')::date
  THEN RAISE EXCEPTION 'GL_PAYROLL_PAYOUT_CASH_MOVEMENT_MISMATCH'
      USING ERRCODE='22023'; END IF;
  SELECT * INTO ca FROM public.company_accounts
    WHERE id=a.account_id AND tenant_id=p_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'GL_PAYROLL_PAYOUT_ACCOUNT_UNKNOWN'
      USING ERRCODE='22023'; END IF;
  v_cash_account:=CASE WHEN ca.account_type='cash' THEN '1010' ELSE '1020' END;
  v_period:=to_char(payroll.paid_at AT TIME ZONE 'Asia/Gaza','YYYY-MM');
  v_lines:=jsonb_build_array(
   jsonb_build_object('code','2400','side','debit','amount',payroll.total_net),
   jsonb_build_object('code',v_cash_account,'side','credit','amount',payroll.total_net));
  v_payload:=jsonb_build_object('payrollRunId',payroll.id,'paidAt',payroll.paid_at,
    'net',payroll.total_net,'approvedBy',payroll.approved_by_user_id,
    'expenseId',exp.id,'movementId',a.id,'cashAccount',a.account_id,
    'cashAccountType',ca.account_type);
  v_policy:='payroll-settlement-no-second-wage-expense-v1';
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
$function$;

-- D10 preserves B5.18 optimized keyset-UNION and only adds supplier return cash handling.
-- The cash reconciliation read model must classify the cash leg from a supplier return
-- against its own source-linked credit_note GL, rather than report an unsupported transfer.
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
  v_corrected_payment_id bigint;
  v_supplier_ledger_debit numeric;
  v_supplier_ledger_credit numeric;
  v_return_reference text;
  v_return_date date;
  v_return_supplier_id bigint;
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
  -- B5.4: reuse the immutable SHA-256 anchored Staging proof, including
  -- precise cohort count, active freeze triggers and forbidden source links.
  -- Only a reporting cutoff after the entire May benchmark cohort may
  -- exclude it. Every other scope takes the original full counting path.
  v_fixture:=public.powerhub_financial_gl_fast_staging_fixture_proof(
     p_tenant_id,p_site_id);
  v_fixture_verified:=coalesce((v_fixture->>'verified')::boolean,false);
  IF v_fixture_verified
      AND (v_fixture->>'quarantinedCount')::bigint=250000
      AND v_cutoff>'2026-05-03T20:50:00+00'::timestamptz
  THEN
    v_fixture_unreviewed:=250000;
    v_fixture_rows:=250000;
  ELSE
    SELECT count(*) INTO v_fixture_unreviewed
    FROM public.account_transactions t WHERE t.tenant_id=p_tenant_id
      AND t.site_id=p_site_id AND t.occurred_at<v_cutoff
      AND t.reference_no LIKE 'STG-PERF-%';
    v_fixture_verified:=false;
    v_fixture_rows:=0;
  END IF;
  SELECT count(*) INTO v_unlinked
  FROM public.account_transactions t
  WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id AND t.occurred_at<v_cutoff
    AND (t.reference_no IS NULL OR t.reference_no NOT LIKE 'STG-PERF-%')
    AND t.related_payment_id IS NULL
    AND t.related_supplier_payment_id IS NULL
    AND t.related_expense_id IS NULL
    AND t.related_supplier_return_id IS NULL
    AND t.related_account_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM public.financial_supplier_payment_corrections c
      WHERE c.tenant_id=t.tenant_id AND c.site_id=t.site_id
      AND c.refund_transaction_id=t.id AND c.status='posted'
      AND public.powerhub_financial_supplier_payment_correction_proof(
        c.tenant_id,c.site_id,c.payment_id)='SOURCE_BACKED_REVERSAL_VALID');
  FOR v_rec IN
    SELECT t.*,a.account_type
    FROM (
 SELECT x.id FROM public.account_transactions x
 WHERE x.tenant_id=p_tenant_id AND x.site_id=p_site_id AND x.occurred_at<v_cutoff
  AND (x.related_payment_id IS NOT NULL OR x.related_supplier_payment_id IS NOT NULL
   OR x.related_expense_id IS NOT NULL OR x.related_supplier_return_id IS NOT NULL
   OR x.related_account_id IS NOT NULL)
 UNION
 SELECT c.refund_transaction_id AS id
 FROM public.financial_supplier_payment_corrections c
 WHERE c.tenant_id=p_tenant_id AND c.site_id=p_site_id AND c.status='posted'
  AND c.refund_transaction_id IS NOT NULL
) cash_keys
    JOIN public.account_transactions t ON t.id=cash_keys.id
      AND t.tenant_id=p_tenant_id AND t.site_id=p_site_id AND t.occurred_at<v_cutoff
    JOIN public.company_accounts a ON a.id=t.account_id AND a.tenant_id=t.tenant_id
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
    v_expected_side:=CASE WHEN v_rec.transaction_type IN ('collection','deposit') THEN 'debit'
      WHEN v_rec.transaction_type='withdrawal' THEN 'credit' ELSE NULL END;
    v_link_count:=(v_rec.related_payment_id IS NOT NULL)::integer+
      (v_rec.related_supplier_payment_id IS NOT NULL)::integer+
      (v_rec.related_expense_id IS NOT NULL)::integer+
      (v_rec.related_supplier_return_id IS NOT NULL)::integer+
      (v_rec.related_account_id IS NOT NULL)::integer+
      (EXISTS(SELECT 1 FROM public.financial_supplier_payment_corrections c
        WHERE c.tenant_id=p_tenant_id AND c.site_id=p_site_id
          AND c.refund_transaction_id=v_rec.id AND c.status='posted'))::integer;
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
    ELSIF EXISTS(SELECT 1 FROM public.financial_supplier_payment_corrections c
      WHERE c.tenant_id=p_tenant_id AND c.site_id=p_site_id
        AND c.refund_transaction_id=v_rec.id AND c.status='posted') THEN
      SELECT c.amount,c.reversal_supplier_ledger_entry_id,c.payment_id,
        p.company_account_id
      INTO v_amount,v_supplier_ledger_id,v_corrected_payment_id,v_related_account_id
      FROM public.financial_supplier_payment_corrections c
      JOIN public.supplier_payments p ON p.tenant_id=c.tenant_id
        AND p.id=c.payment_id AND p.site_id=c.site_id
      WHERE c.tenant_id=p_tenant_id AND c.site_id=p_site_id
        AND c.refund_transaction_id=v_rec.id AND c.status='posted';
      v_source_type:='supplier_ledger';v_source_id:=v_supplier_ledger_id::text;
      IF v_corrected_payment_id IS NULL OR
        public.powerhub_financial_supplier_payment_correction_proof(
          p_tenant_id,p_site_id,v_corrected_payment_id)<>'SOURCE_BACKED_REVERSAL_VALID'
        OR v_expected_side<>'debit'
        OR v_rec.amount IS DISTINCT FROM v_amount
        OR v_rec.account_id IS DISTINCT FROM v_related_account_id
      THEN v_reason:='SUPPLIER_PAYMENT_CORRECTION_CASH_OR_GL_MISMATCH';END IF;
    ELSIF v_rec.related_supplier_payment_id IS NOT NULL THEN
      SELECT sp.amount,sp.status,sp.company_account_id,sp.account_transaction_id
      INTO v_amount,v_status,v_related_account_id,v_related_tx_id
      FROM public.supplier_payments sp
      WHERE sp.id=v_rec.related_supplier_payment_id
        AND sp.tenant_id=p_tenant_id AND sp.site_id=p_site_id;
      IF NOT FOUND THEN v_reason:='MISSING_SUPPLIER_PAYMENT_IN_SCOPE';
      ELSIF (v_status<>'posted' AND NOT (v_status='reversed' AND
        public.powerhub_financial_supplier_payment_correction_proof(
          p_tenant_id,p_site_id,v_rec.related_supplier_payment_id)
             ='SOURCE_BACKED_REVERSAL_VALID')) OR v_expected_side<>'credit'
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
    ELSIF v_rec.related_supplier_return_id IS NOT NULL THEN
      SELECT r.refund_amount,r.status,r.refund_company_account_id,
        r.return_number,r.return_date,r.supplier_id
      INTO v_amount,v_status,v_related_account_id,
        v_return_reference,v_return_date,v_return_supplier_id
      FROM public.supplier_purchase_returns r
      WHERE r.tenant_id=p_tenant_id AND r.site_id=p_site_id
        AND r.id=v_rec.related_supplier_return_id;
      SELECT count(*),min(sl.id),coalesce(sum(sl.credit_amount),0)
        INTO v_supplier_ledger_count,v_supplier_ledger_id,v_supplier_ledger_credit
      FROM public.supplier_ledger_entries sl
      WHERE sl.tenant_id=p_tenant_id AND sl.site_id=p_site_id
        AND sl.supplier_return_id=v_rec.related_supplier_return_id
        AND sl.entry_type='credit_note'
        AND sl.supplier_id=v_return_supplier_id
        AND sl.entry_key='supplier-return-refund:'||v_rec.related_supplier_return_id
        AND sl.debit_amount=0
        AND sl.reference_no=v_return_reference
        AND sl.occurred_at=v_rec.occurred_at;
      v_source_type:='supplier_ledger';v_source_id:=v_supplier_ledger_id::text;
      SELECT count(*) INTO v_duplicate_links FROM public.account_transactions t
      WHERE t.tenant_id=p_tenant_id
        AND t.related_supplier_return_id=v_rec.related_supplier_return_id;
      IF v_status IS DISTINCT FROM 'posted' OR v_supplier_ledger_count<>1
        OR v_duplicate_links<>1 OR v_expected_side<>'debit'
        OR v_rec.transaction_type<>'deposit' OR v_amount IS NULL OR v_amount<=0
        OR v_rec.amount IS DISTINCT FROM v_amount
        OR v_supplier_ledger_credit IS DISTINCT FROM v_amount
        OR v_rec.account_id IS DISTINCT FROM v_related_account_id
        OR v_rec.reference_no IS DISTINCT FROM v_return_reference
        OR (v_rec.occurred_at AT TIME ZONE 'Asia/Gaza')::date
          IS DISTINCT FROM v_return_date
      THEN v_reason:='SUPPLIER_RETURN_REFUND_CASH_OR_LEDGER_MISMATCH'; END IF;
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
        WHEN t.transaction_type='withdrawal' THEN -t.amount
        WHEN t.transaction_type='deposit' AND EXISTS(
          SELECT 1 FROM public.financial_supplier_payment_corrections c
          WHERE c.tenant_id=t.tenant_id AND c.site_id=t.site_id
            AND c.refund_transaction_id=t.id AND c.status='posted'
            AND public.powerhub_financial_supplier_payment_correction_proof(
              c.tenant_id,c.site_id,c.payment_id)='SOURCE_BACKED_REVERSAL_VALID')
        THEN t.amount
        WHEN t.transaction_type='deposit'
          AND t.related_supplier_return_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM public.supplier_purchase_returns sr
            JOIN public.supplier_ledger_entries sl
              ON sl.tenant_id=sr.tenant_id AND sl.site_id=sr.site_id
              AND sl.supplier_return_id=sr.id AND sl.entry_type='credit_note'
              AND sl.credit_amount=sr.refund_amount AND sl.debit_amount=0
            JOIN public.financial_gl_entries e
              ON e.tenant_id=sl.tenant_id AND e.site_id=sl.site_id
              AND e.source_type='supplier_ledger' AND e.source_id=sl.id::text
            WHERE sr.tenant_id=t.tenant_id AND sr.site_id=t.site_id
              AND sr.id=t.related_supplier_return_id
              AND sr.status='posted' AND sr.refund_amount=t.amount
              AND sr.refund_company_account_id=t.account_id)
        THEN t.amount ELSE 0 END),0) net_amount
    FROM public.company_accounts a LEFT JOIN (
    SELECT t.* FROM (
 SELECT x.id FROM public.account_transactions x
 WHERE x.tenant_id=p_tenant_id AND x.site_id=p_site_id AND x.occurred_at<v_cutoff
  AND (x.related_payment_id IS NOT NULL OR x.related_supplier_payment_id IS NOT NULL
   OR x.related_expense_id IS NOT NULL OR x.related_supplier_return_id IS NOT NULL
   OR x.related_account_id IS NOT NULL)
 UNION
 SELECT c.refund_transaction_id AS id
 FROM public.financial_supplier_payment_corrections c
 WHERE c.tenant_id=p_tenant_id AND c.site_id=p_site_id AND c.status='posted'
  AND c.refund_transaction_id IS NOT NULL
) cash_keys
    JOIN public.account_transactions t ON t.id=cash_keys.id
      AND t.tenant_id=p_tenant_id AND t.site_id=p_site_id AND t.occurred_at<v_cutoff
  ) t ON t.tenant_id=a.tenant_id AND t.account_id=a.id
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
      WHEN v_fixture_verified THEN 'HASH_ANCHORED_IMMUTABLE_TEST_COHORT'
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
$function$;

-- Retain least-privilege EXECUTE grants across replacement on existing databases.
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_source_plan(bigint,bigint,text,bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_source_plan(bigint,bigint,text,bigint)
  TO service_role;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_company_movement_audit(bigint,bigint,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_company_movement_audit(bigint,bigint,text)
  TO service_role;

COMMENT ON FUNCTION public.powerhub_financial_gl_source_plan(bigint,bigint,text,bigint)
IS 'D10: source-backed supplier cash refund via credit_note (DR cash/CR AP); supplier return valuation difference transparently assigned to GL cost 5100; preexisting equal-valued return fingerprint preserved. NOT_CERTIFIED.';
