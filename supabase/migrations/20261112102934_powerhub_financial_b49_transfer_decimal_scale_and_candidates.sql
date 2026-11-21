-- B4.9.2: Decimal-scale-safe operation-hash validation, with direct
-- verified transfer discovery for the site-scoped posting workspace.
-- NOTE: B3 inter-site GL elimination remains separate and not certified.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_source_plan(p_tenant_id bigint, p_site_id bigint, p_source_type text, p_source_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
 op public.company_account_movement_operations%ROWTYPE;
 incoming public.account_transactions%ROWTYPE;
 destination_account public.company_accounts%ROWTYPE;
 v_source_cash_code text;v_destination_cash_code text;
 v_count bigint;v_sum numeric;v_gross numeric;v_net numeric;v_adv numeric;v_other numeric;
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
     OR ca.account_type NOT IN ('cash','palpay')
     OR destination_account.account_type NOT IN ('cash','palpay')
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
     AND m.movement_type='supplier_return'
     AND m.reference_no=supplier.reference_no;
    IF supplier.reference_no IS NULL
      OR supplier.supplier_return_id IS NULL OR supplier.debit_amount<=0
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
$function$
;
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_subledger_reconciliation(p_tenant_id bigint, p_site_id bigint, p_period text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
 v_cutoff timestamptz;
 g_cash numeric:=0;g_wallet numeric:=0;g_ar numeric:=0;g_ap numeric:=0;g_stock numeric:=0;
 s_cash numeric:=0;s_wallet numeric:=0;s_ar numeric:=0;s_ap numeric:=0;s_stock numeric:=0;
 v_invoice_total numeric:=0;v_invoice_current numeric:=0;v_invoice_paid numeric:=0;v_invoice_credits numeric:=0;
 v_invoice_invalid bigint:=0;v_invoice_changed bigint:=0;v_later_payments bigint:=0;
 v_stock_unknown bigint:=0;v_stock_uncosted bigint:=0;
 v_cash_unknown bigint:=0;v_cash_openings bigint:=0;v_cash_transfer_movements bigint:=0;
 v_verified_transfer_pairs bigint:=0;
 v_rows jsonb; v_bad bigint; v_mismatch bigint; v_gl_entries bigint;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0 OR p_site_id IS NULL OR p_site_id<=0
 OR p_period IS NULL OR p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
 OR NOT EXISTS(SELECT 1 FROM public.sites WHERE tenant_id=p_tenant_id AND id=p_site_id AND status<>'archived')
 THEN RAISE EXCEPTION 'GL_B4_INVALID_SCOPE' USING ERRCODE='22023'; END IF;
 v_cutoff:=(((p_period||'-01')::date+interval '1 month')::timestamp AT TIME ZONE 'Asia/Gaza');
 SELECT count(*) INTO v_gl_entries FROM public.financial_gl_entries
 WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND period<=p_period;
 SELECT coalesce(sum(CASE WHEN l.account_code='1010' THEN (CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END) ELSE 0 END),0),
 coalesce(sum(CASE WHEN l.account_code='1020' THEN (CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END) ELSE 0 END),0),
 coalesce(sum(CASE WHEN l.account_code='1200' THEN (CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END) ELSE 0 END),0),
 coalesce(sum(CASE WHEN l.account_code='2300' THEN (CASE WHEN l.side='credit' THEN l.amount ELSE -l.amount END) ELSE 0 END),0),
 coalesce(sum(CASE WHEN l.account_code='1300' THEN (CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END) ELSE 0 END),0)
 INTO g_cash,g_wallet,g_ar,g_ap,g_stock
 FROM public.financial_gl_entries e JOIN public.financial_gl_lines l
 ON l.entry_id=e.id AND l.tenant_id=e.tenant_id AND l.site_id=e.site_id
 WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id AND e.period<=p_period
 AND l.account_code IN ('1010','1020','1200','2300','1300');
 -- Receivables are independently reconstructed from issued invoices minus completed payments.
 -- Current invoice balance_due is checked for drift; retrospective mutations block certification.
 SELECT coalesce(sum(i.total_amount),0),coalesce(sum(i.balance_due),0),
 count(*) FILTER(WHERE i.status IN ('cancelled','void','voided')),
 count(*) FILTER(WHERE i.updated_at>=v_cutoff),
 coalesce(sum(i.credit_applied_amount),0)
 INTO v_invoice_total,v_invoice_current,v_invoice_invalid,v_invoice_changed,v_invoice_credits
 FROM public.invoices i WHERE i.tenant_id=p_tenant_id AND i.site_id=p_site_id
 AND i.issue_date<v_cutoff;
 SELECT coalesce(sum(p.invoice_applied_amount),0) INTO v_invoice_paid
 FROM public.payments p JOIN public.invoices i
 ON i.id=p.invoice_id AND i.tenant_id=p.tenant_id AND i.site_id=p.site_id
 WHERE p.tenant_id=p_tenant_id AND p.site_id=p_site_id
 AND i.issue_date<v_cutoff AND p.paid_at<v_cutoff AND p.status='completed';
 SELECT count(*) INTO v_later_payments FROM public.payments p
 JOIN public.invoices i ON i.id=p.invoice_id AND i.tenant_id=p.tenant_id AND i.site_id=p.site_id
 WHERE p.tenant_id=p_tenant_id AND p.site_id=p_site_id AND i.issue_date<v_cutoff
 AND p.paid_at>=v_cutoff AND p.status='completed';
 s_ar:=v_invoice_total-v_invoice_paid-v_invoice_credits;
 SELECT coalesce(sum(credit_amount-debit_amount),0) INTO s_ap
 FROM public.supplier_ledger_entries
 WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND occurred_at<v_cutoff;
 SELECT coalesce(sum(CASE
 WHEN movement_type IN ('purchase_receipt','adjustment_in','transfer_in') THEN total_cost_amount
 WHEN movement_type IN ('issue','supplier_return','adjustment_out','transfer_out') THEN -total_cost_amount
 ELSE 0 END),0),
 count(*) FILTER(WHERE movement_type NOT IN
 ('purchase_receipt','adjustment_in','transfer_in','issue','supplier_return','adjustment_out','transfer_out')),
 count(*) FILTER(WHERE total_cost_amount IS NULL)
 INTO s_stock,v_stock_unknown,v_stock_uncosted
 FROM public.inventory_stock_movements
 WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND occurred_at<v_cutoff;
 -- Company account opening balances are tenant-wide and cannot be assigned to a site.
 SELECT count(*) INTO v_cash_openings FROM public.company_accounts
 WHERE tenant_id=p_tenant_id AND opening_balance<>0;
 SELECT coalesce(sum(CASE WHEN a.account_type='cash'
 THEN (CASE WHEN t.transaction_type IN ('collection','transfer_in') THEN t.amount WHEN t.transaction_type IN ('withdrawal','transfer_out') THEN -t.amount ELSE 0 END)
 ELSE 0 END),0),
 coalesce(sum(CASE WHEN a.account_type<>'cash'
 THEN (CASE WHEN t.transaction_type IN ('collection','transfer_in') THEN t.amount WHEN t.transaction_type IN ('withdrawal','transfer_out') THEN -t.amount ELSE 0 END)
 ELSE 0 END),0),
 count(*) FILTER(WHERE t.transaction_type NOT IN ('collection','withdrawal','transfer_in','transfer_out')),
 count(*) FILTER(WHERE t.transaction_type IN ('transfer_in','transfer_out'))
 INTO s_cash,s_wallet,v_cash_unknown,v_cash_transfer_movements
 FROM public.account_transactions t JOIN public.company_accounts a
 ON a.id=t.account_id AND a.tenant_id=t.tenant_id
 WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id AND t.occurred_at<v_cutoff;
 -- Only complete and independently posted two-sided transfers can clear
 -- the previously blocked operational transfer count. No textual match is enough.
 SELECT count(*) INTO v_verified_transfer_pairs
 FROM public.company_account_movement_operations op
 JOIN public.account_transactions outgoing
   ON outgoing.tenant_id=op.tenant_id AND outgoing.id=op.primary_transaction_id
 JOIN public.account_transactions incoming
   ON incoming.tenant_id=op.tenant_id AND incoming.id=op.counterpart_transaction_id
 JOIN public.company_accounts from_ac
   ON from_ac.tenant_id=op.tenant_id AND from_ac.id=outgoing.account_id
 JOIN public.company_accounts to_ac
   ON to_ac.tenant_id=op.tenant_id AND to_ac.id=incoming.account_id
 JOIN public.financial_gl_entries e
   ON e.tenant_id=op.tenant_id AND e.site_id=op.site_id
   AND e.source_type='account_movement'
   AND e.source_id=outgoing.id::text AND e.source_revision=1
   AND e.accounting_policy_version='company-transfer-paired-no-income-or-expense-v1'
   AND e.source_fingerprint=encode(sha256(convert_to(
     jsonb_build_object('operationKey',op.operation_key,'payloadHash',op.payload_hash,
       'fromTransactionId',outgoing.id,'toTransactionId',incoming.id,
       'fromAccount',outgoing.account_id,'toAccount',incoming.account_id,
       'fromAccountType',from_ac.account_type,'toAccountType',to_ac.account_type,
       'fromOccurredAt',outgoing.occurred_at,'toOccurredAt',incoming.occurred_at,
       'sourceAmount',outgoing.amount,'destinationAmount',incoming.amount,
       'actor',op.created_by_user_id)::text,'UTF8')),'hex')
 WHERE op.tenant_id=p_tenant_id AND op.site_id=p_site_id
   AND op.operation_type='transfer' AND e.period<=p_period
   AND outgoing.site_id=p_site_id AND incoming.site_id=p_site_id
   AND outgoing.occurred_at<v_cutoff AND incoming.occurred_at<v_cutoff
   AND outgoing.transaction_type='transfer_out'
   AND incoming.transaction_type='transfer_in'
   AND outgoing.account_id<>incoming.account_id
   AND outgoing.related_account_id=incoming.account_id
   AND incoming.related_account_id=outgoing.account_id
   AND outgoing.amount=incoming.amount AND outgoing.amount>0
   AND outgoing.amount=round(outgoing.amount,2)
   AND outgoing.description=incoming.description
   AND EXISTS (SELECT 1 FROM generate_series(0,6) precision_scale
     WHERE op.payload_hash=md5(jsonb_build_object(
      'tenantId',op.tenant_id,'siteId',op.site_id,
      'userId',op.created_by_user_id,'fromAccountId',outgoing.account_id,
      'toAccountId',incoming.account_id,'amount',round(outgoing.amount,precision_scale),
      'description',btrim(outgoing.description))::text))
   AND (SELECT count(*) FROM public.company_account_movement_operations dup
        WHERE dup.tenant_id=op.tenant_id AND dup.counterpart_transaction_id=incoming.id)=1
   AND outgoing.created_by_user_id=op.created_by_user_id
   AND incoming.created_by_user_id=op.created_by_user_id
   AND (SELECT count(*) FROM public.company_account_movement_operations dup
        WHERE dup.tenant_id=op.tenant_id AND dup.primary_transaction_id=outgoing.id)=1
   AND from_ac.account_type IN ('cash','palpay')
   AND to_ac.account_type IN ('cash','palpay')
   AND to_char(outgoing.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM')=e.period
   AND to_char(incoming.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM')=e.period
   AND (SELECT count(*) FROM public.financial_gl_lines l WHERE l.entry_id=e.id)=2
   AND EXISTS (SELECT 1 FROM public.financial_gl_lines l
     WHERE l.entry_id=e.id AND l.tenant_id=e.tenant_id AND l.site_id=e.site_id
       AND l.side='debit' AND l.amount=outgoing.amount
       AND l.account_code=CASE WHEN to_ac.account_type='cash' THEN '1010' ELSE '1020' END)
   AND EXISTS (SELECT 1 FROM public.financial_gl_lines l
     WHERE l.entry_id=e.id AND l.tenant_id=e.tenant_id AND l.site_id=e.site_id
       AND l.side='credit' AND l.amount=outgoing.amount
       AND l.account_code=CASE WHEN from_ac.account_type='cash' THEN '1010' ELSE '1020' END);
 v_cash_transfer_movements:=greatest(0,v_cash_transfer_movements-2*v_verified_transfer_pairs);
 v_rows:=jsonb_build_array(
 jsonb_build_object('code','1200','label','ذمم المشتركين','glBalance',g_ar,'subledgerBalance',s_ar,
 'difference',g_ar-s_ar,'status',CASE WHEN v_invoice_invalid>0 OR v_invoice_changed>0 OR v_later_payments>0 OR v_invoice_current<>s_ar
 THEN 'BLOCKED_SOURCE_SNAPSHOT' WHEN g_ar=s_ar THEN 'MATCHED' ELSE 'DIFFERENCE' END,
 'source','INVOICES_MINUS_COMPLETED_PAYMENTS','invoiceBalanceCheckDifference',v_invoice_current-s_ar),
 jsonb_build_object('code','2300','label','ذمم الموردين','glBalance',g_ap,'subledgerBalance',s_ap,
 'difference',g_ap-s_ap,'status',CASE WHEN g_ap=s_ap THEN 'MATCHED' ELSE 'DIFFERENCE' END,
 'source','SUPPLIER_LEDGER_CREDIT_MINUS_DEBIT'),
 jsonb_build_object('code','1300','label','المخزون والوقود','glBalance',g_stock,'subledgerBalance',s_stock,
 'difference',g_stock-s_stock,'status',CASE WHEN v_stock_unknown>0 OR v_stock_uncosted>0 THEN 'BLOCKED_UNMAPPED_MOVEMENT'
 WHEN g_stock=s_stock THEN 'MATCHED' ELSE 'DIFFERENCE' END,
 'source','STOCK_MOVEMENT_COST_ROLLFORWARD'),
 jsonb_build_object('code','1010','label','الصندوق','glBalance',g_cash,'subledgerBalance',s_cash,
 'difference',g_cash-s_cash,'status',CASE WHEN v_cash_transfer_movements>0 THEN 'BLOCKED_UNPOSTED_ACCOUNT_TRANSFER'
 WHEN v_cash_unknown>0 OR v_cash_openings>0 THEN 'BLOCKED_COMPANY_ACCOUNT_SCOPE'
 WHEN g_cash=s_cash THEN 'MATCHED' ELSE 'DIFFERENCE' END,'source','SITE_CASH_TRANSACTIONS_NET'),
 jsonb_build_object('code','1020','label','البنوك والمحافظ','glBalance',g_wallet,'subledgerBalance',s_wallet,
 'difference',g_wallet-s_wallet,'status',CASE WHEN v_cash_transfer_movements>0 THEN 'BLOCKED_UNPOSTED_ACCOUNT_TRANSFER'
 WHEN v_cash_unknown>0 OR v_cash_openings>0 THEN 'BLOCKED_COMPANY_ACCOUNT_SCOPE'
 WHEN g_wallet=s_wallet THEN 'MATCHED' ELSE 'DIFFERENCE' END,'source','SITE_NONCASH_TRANSACTIONS_NET')
 );
 SELECT count(*) FILTER(WHERE x->>'status'<>'MATCHED'),
 count(*) FILTER(WHERE (x->>'difference')::numeric<>0)
 INTO v_bad,v_mismatch FROM jsonb_array_elements(v_rows) x;
 RETURN jsonb_build_object('tenantId',p_tenant_id,'siteId',p_site_id,'period',p_period,
 'periodEndExclusive',v_cutoff,'glEntryCount',v_gl_entries,'sourceScope','SITE_OPERATIONAL_SUBLEDGERS',
 'status',CASE WHEN v_bad=0 THEN 'MATCHED_NUMERICALLY_NOT_CERTIFIED' ELSE 'BLOCKED_RECONCILIATION' END,
 'accountingCertification','NOT_CERTIFIED','isFinalBalanceSheet',false,'isApproved',false,
 'isMathematicallyMatched',v_bad=0,'differenceCount',v_mismatch,'unresolvedCount',v_bad,
 'checks',v_rows,
 'diagnostics',jsonb_build_object('invoiceInvalidCount',v_invoice_invalid,
 'invoicesChangedAfterCutoff',v_invoice_changed,'paymentsAfterCutoff',v_later_payments,
 'invoiceCreditsWithoutHistoricalDate',v_invoice_credits,
 'unknownStockMovements',v_stock_unknown,'uncostedStockMovements',v_stock_uncosted,
 'unknownCompanyTransactionTypes',v_cash_unknown,'unpostedTransferMovements',v_cash_transfer_movements,'glVerifiedTransferPairs',v_verified_transfer_pairs,'unallocatableCompanyOpeningAccounts',v_cash_openings),
 'limitations',jsonb_build_array('AGGREGATE_ONLY_NOT_DOCUMENT_LEVEL',
 'NO_SITE_ATTRIBUTABLE_COMPANY_ACCOUNT_OPENINGS','UNPOSTED_COMPANY_TRANSFER_GL_BLOCKS_MATCHING',
 'NO_HISTORICAL_CREDIT_APPLIED_DATES',
 'NOT_A_INDEPENDENT_HUMAN_REVIEW'));
END;
$function$
;
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_cash_transfer_candidates(pt bigint, ps bigint, pp text, p_before_source_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE v_rows jsonb; v_n integer;
BEGIN
 IF pt IS NULL OR pt<=0 OR ps IS NULL OR ps<=0
   OR pp IS NULL OR pp !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
   OR (p_before_source_id IS NOT NULL AND p_before_source_id<=0)
   OR NOT EXISTS(SELECT 1 FROM public.sites s
     WHERE s.tenant_id=pt AND s.id=ps AND s.status<>'archived')
 THEN RAISE EXCEPTION 'GL_TRANSFER_CANDIDATE_SCOPE_INVALID' USING ERRCODE='22023'; END IF;
 WITH src AS (
   SELECT op.primary_transaction_id source_id,
     outgoing.amount,
     outgoing.occurred_at,
     outgoing.transaction_type source_type,
     incoming.transaction_type destination_type,
     outgoing.account_id source_account_id,
     incoming.account_id destination_account_id,
     from_ac.name source_account_name, to_ac.name destination_account_name,
     outgoing.related_account_id,
     incoming.related_account_id destination_related_account_id,
     op.operation_key,
     e.id gl_entry_id
   FROM public.company_account_movement_operations op
   JOIN public.account_transactions outgoing
     ON outgoing.tenant_id=op.tenant_id AND outgoing.id=op.primary_transaction_id
   JOIN public.account_transactions incoming
     ON incoming.tenant_id=op.tenant_id AND incoming.id=op.counterpart_transaction_id
   JOIN public.company_accounts from_ac
     ON from_ac.tenant_id=op.tenant_id AND from_ac.id=outgoing.account_id
   JOIN public.company_accounts to_ac
     ON to_ac.tenant_id=op.tenant_id AND to_ac.id=incoming.account_id
   LEFT JOIN public.financial_gl_entries e
     ON e.tenant_id=op.tenant_id AND e.site_id=op.site_id
       AND e.source_type='account_movement'
       AND e.source_id=outgoing.id::text AND e.source_revision=1
   WHERE op.tenant_id=pt AND op.site_id=ps AND op.operation_type='transfer'
     AND outgoing.site_id=ps AND incoming.site_id=ps
     AND to_char(outgoing.occurred_at AT TIME ZONE 'Asia/Gaza','YYYY-MM')=pp
     AND (p_before_source_id IS NULL OR op.primary_transaction_id<p_before_source_id)
   ORDER BY op.primary_transaction_id DESC
   LIMIT 26
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'sourceId',source_id,'amount',amount,'occurredAt',occurred_at,
   'sourceAccountId',source_account_id,'destinationAccountId',destination_account_id,
   'sourceAccountName',source_account_name,'destinationAccountName',destination_account_name,
   'glEntryId',gl_entry_id,'status',CASE WHEN gl_entry_id IS NULL
     THEN 'PENDING_GL' ELSE 'GL_ENTRY_PRESENT' END)
   ORDER BY source_id DESC) FILTER (WHERE rn<=25),'[]'::jsonb),
   count(*) INTO v_rows,v_n
 FROM (SELECT src.*,row_number() over(order by source_id desc) rn FROM src) numbered;
 RETURN jsonb_build_object(
  'tenantId',pt,'siteId',ps,'period',pp,'items',v_rows,
  'hasMore',v_n>25,
  'nextBeforeSourceId',CASE WHEN v_n>25
    THEN (v_rows->24->>'sourceId')::bigint ELSE NULL END,
  'accountingCertification','NOT_CERTIFIED');
END;$function$
;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_source_plan(bigint,bigint,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_source_plan(bigint,bigint,text,bigint) TO service_role;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_subledger_reconciliation(bigint,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_subledger_reconciliation(bigint,bigint,text) TO service_role;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_cash_transfer_candidates(bigint,bigint,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_cash_transfer_candidates(bigint,bigint,text,bigint) TO service_role;
