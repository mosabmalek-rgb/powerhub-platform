-- Stable row-level fingerprint makes same-total source edits invalidate a pending settlement.
-- This is a change detector, not an authentication token.
CREATE OR REPLACE FUNCTION public.powerhub_financial_settlement_source_fingerprint(
  p_tenant_id bigint,p_site_id bigint,p_period_start timestamptz,p_period_end timestamptz
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path=public,pg_temp
AS $function$
  SELECT md5(jsonb_build_object(
    'payments',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id',p.id,'amount',p.amount,'invoiceAppliedAmount',p.invoice_applied_amount,
        'subscriberCreditAmount',p.subscriber_credit_amount,'paymentPurpose',p.payment_purpose,
        'status',p.status,'paidAt',p.paid_at
      ) ORDER BY p.id)
      FROM public.payments p
      WHERE p.tenant_id=p_tenant_id AND p.site_id=p_site_id AND p.status='completed'
        AND p.paid_at>=p_period_start AND p.paid_at<=p_period_end
    ),'[]'::jsonb),
    'expenses',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id',e.id,'amount',e.amount,'category',e.category,'occurredAt',e.occurred_at
      ) ORDER BY e.id)
      FROM public.expenses e
      WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
        AND e.occurred_at>=p_period_start AND e.occurred_at<=p_period_end
    ),'[]'::jsonb),
    'accountTransactions',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id',t.id,'accountId',t.account_id,'siteId',t.site_id,
        'transactionType',t.transaction_type,'amount',t.amount,'occurredAt',t.occurred_at,
        'referenceNo',t.reference_no,'relatedPaymentId',t.related_payment_id,
        'relatedExpenseId',t.related_expense_id,'relatedSupplierPaymentId',t.related_supplier_payment_id,
        'relatedSupplierReturnId',t.related_supplier_return_id
      ) ORDER BY t.id)
      FROM public.account_transactions t
      WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id AND t.occurred_at<=p_period_end
    ),'[]'::jsonb),
    'supplierPayments',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id',sp.id,'amount',sp.amount,'paymentDate',sp.payment_date,
        'status',sp.status,'accountTransactionId',sp.account_transaction_id
      ) ORDER BY sp.id)
      FROM public.supplier_payments sp
      WHERE sp.tenant_id=p_tenant_id AND sp.site_id=p_site_id AND sp.status='posted'
        AND sp.payment_date>=(p_period_start AT TIME ZONE 'UTC')::date
        AND sp.payment_date<=(p_period_end AT TIME ZONE 'UTC')::date
    ),'[]'::jsonb),
    'supplierReturns',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id',r.id,'totalCreditAmount',r.total_credit_amount,'refundAmount',r.refund_amount,
        'returnDate',r.return_date,'status',r.status
      ) ORDER BY r.id)
      FROM public.supplier_purchase_returns r
      WHERE r.tenant_id=p_tenant_id AND r.site_id=p_site_id AND r.status='posted'
        AND r.return_date>=(p_period_start AT TIME ZONE 'UTC')::date
        AND r.return_date<=(p_period_end AT TIME ZONE 'UTC')::date
    ),'[]'::jsonb),
    'supplierPurchases',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id',p.id,'totalAmount',p.total_amount,'invoiceDate',p.invoice_date,'status',p.status
      ) ORDER BY p.id)
      FROM public.supplier_purchases p
      WHERE p.tenant_id=p_tenant_id AND p.site_id=p_site_id
        AND p.invoice_date>=(p_period_start AT TIME ZONE 'UTC')::date
        AND p.invoice_date<=(p_period_end AT TIME ZONE 'UTC')::date
        AND p.status IN ('confirmed','partially_received','received')
    ),'[]'::jsonb),
    'companyAccounts',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id',ca.id,'openingBalance',ca.opening_balance,'createdAt',ca.created_at,
        'siteIds',(SELECT COALESCE(jsonb_agg(cas.site_id ORDER BY cas.site_id),'[]'::jsonb)
          FROM public.company_account_sites cas
          WHERE cas.tenant_id=ca.tenant_id AND cas.account_id=ca.id)
      ) ORDER BY ca.id)
      FROM public.company_accounts ca
      WHERE ca.tenant_id=p_tenant_id AND EXISTS (
        SELECT 1 FROM public.company_account_sites cas
        WHERE cas.tenant_id=ca.tenant_id AND cas.account_id=ca.id AND cas.site_id=p_site_id
      )
    ),'[]'::jsonb)
  )::text)
$function$;

REVOKE ALL ON FUNCTION public.powerhub_financial_settlement_source_fingerprint(bigint,bigint,timestamptz,timestamptz)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_settlement_source_fingerprint(bigint,bigint,timestamptz,timestamptz)
  TO service_role;

CREATE OR REPLACE FUNCTION public.powerhub_create_financial_settlement(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_actual_cash numeric DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS TABLE(settlement_id bigint)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_id bigint;
  v_role text;
  v_snapshot jsonb;
  v_total_collected numeric(14,2);
  v_total_expenses numeric(14,2);
  v_book_profit numeric(14,2);
  v_cash_opening_balance numeric(14,2);
  v_cash_inflows numeric(14,2);
  v_cash_outflows numeric(14,2);
  v_book_cash_balance numeric(14,2);
  v_difference numeric(14,2);
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id < 1
     OR p_site_id IS NULL OR p_site_id < 1
     OR p_user_id IS NULL OR p_user_id < 1
     OR p_period_start IS NULL OR p_period_end IS NULL
     OR p_period_start >= p_period_end THEN
    RAISE EXCEPTION 'INVALID_SETTLEMENT_PERIOD' USING ERRCODE = 'P0001';
  END IF;

  IF p_actual_cash IS NOT NULL AND (
    p_actual_cash < 0 OR p_actual_cash > 100000000000
    OR p_actual_cash <> round(p_actual_cash,2)
  ) THEN
    RAISE EXCEPTION 'INVALID_SETTLEMENT_AMOUNT' USING ERRCODE = 'P0001';
  END IF;

  IF p_notes IS NOT NULL AND length(p_notes) > 2000 THEN
    RAISE EXCEPTION 'INVALID_SETTLEMENT_NOTES' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.sites
    WHERE id = p_site_id AND tenant_id = p_tenant_id AND status <> 'archived'
  ) THEN
    RAISE EXCEPTION 'SITE_OUT_OF_SCOPE' USING ERRCODE = 'P0001';
  END IF;

  SELECT platform_role INTO v_role
  FROM public.users WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'powerhub-financial-settlement-site:' || p_tenant_id::text || ':' || p_site_id::text,0
  ));

  IF EXISTS (
    SELECT 1 FROM public.financial_settlements
    WHERE tenant_id = p_tenant_id AND site_id = p_site_id
      AND status = 'locked'
      AND period_start <= p_period_end
      AND period_end >= p_period_start
  ) THEN
    RAISE EXCEPTION 'SETTLEMENT_PERIOD_OVERLAPS_LOCKED' USING ERRCODE = 'P0001';
  END IF;

  v_snapshot := public.powerhub_financial_settlement_preview(
    p_tenant_id,p_site_id,p_period_start,p_period_end
  ) || jsonb_build_object(
    'sourceFingerprint',
    public.powerhub_financial_settlement_source_fingerprint(
      p_tenant_id,p_site_id,p_period_start,p_period_end
    )
  );

  IF COALESCE((v_snapshot->>'isReconciled')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'SETTLEMENT_LEDGER_RECONCILIATION_FAILED' USING ERRCODE = 'P0001';
  END IF;

  v_total_collected := (v_snapshot->>'totalCollected')::numeric(14,2);
  v_total_expenses := (v_snapshot->>'totalExpenses')::numeric(14,2);
  v_book_profit := (v_snapshot->>'bookProfit')::numeric(14,2);
  v_cash_opening_balance := (v_snapshot->>'cashOpeningBalance')::numeric(14,2);
  v_cash_inflows := (v_snapshot->>'cashInflows')::numeric(14,2);
  v_cash_outflows := (v_snapshot->>'cashOutflows')::numeric(14,2);
  v_book_cash_balance := (v_snapshot->>'bookCashBalance')::numeric(14,2);

  v_difference := CASE
    WHEN p_actual_cash IS NULL THEN NULL
    ELSE round(p_actual_cash - v_book_cash_balance,2)
  END;

  v_snapshot := v_snapshot || jsonb_build_object(
    'actualCash',p_actual_cash,
    'difference',v_difference,
    'snapshotVersion',1,
    'capturedAt',now()
  );

  INSERT INTO public.financial_settlements (
    tenant_id,site_id,period_start,period_end,
    total_collected,total_expenses,book_profit,
    actual_cash,difference,notes,created_by_user_id,
    cash_opening_balance,cash_inflows,cash_outflows,book_cash_balance,
    ledger_reconciliation_status,ledger_snapshot
  )
  VALUES (
    p_tenant_id,p_site_id,p_period_start,p_period_end,
    v_total_collected,v_total_expenses,v_book_profit,
    p_actual_cash,v_difference,p_notes,p_user_id,
    v_cash_opening_balance,v_cash_inflows,v_cash_outflows,v_book_cash_balance,
    'reconciled',v_snapshot
  )
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (
    tenant_id,site_id,user_id,actor_platform_role,
    entity_type,entity_id,action,after_data
  )
  VALUES (
    p_tenant_id,p_site_id,p_user_id,v_role,
    'financial_settlement',v_id::text,'create',
    jsonb_build_object(
      'periodStart',p_period_start,
      'periodEnd',p_period_end,
      'totalCollected',v_total_collected,
      'totalExpenses',v_total_expenses,
      'bookProfit',v_book_profit,
      'cashOpeningBalance',v_cash_opening_balance,
      'cashInflows',v_cash_inflows,
      'cashOutflows',v_cash_outflows,
      'bookCashBalance',v_book_cash_balance,
      'actualCash',p_actual_cash,
      'difference',v_difference,
      'snapshotVersion',1
    )
  );

  RETURN QUERY SELECT v_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.powerhub_create_financial_settlement(bigint,bigint,bigint,timestamptz,timestamptz,numeric,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_create_financial_settlement(bigint,bigint,bigint,timestamptz,timestamptz,numeric,text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.powerhub_set_financial_settlement_status(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_settlement_id bigint,
  p_status text
)
RETURNS TABLE(settlement_id bigint)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_settlement public.financial_settlements%rowtype;
  v_role text;
  v_current_snapshot jsonb;
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id < 1
     OR p_site_id IS NULL OR p_site_id < 1
     OR p_user_id IS NULL OR p_user_id < 1
     OR p_settlement_id IS NULL OR p_settlement_id < 1
     OR p_status IS NULL
     OR p_status NOT IN ('submitted','approved','locked') THEN
    RAISE EXCEPTION 'INVALID_SETTLEMENT_STATUS' USING ERRCODE = 'P0001';
  END IF;

  SELECT platform_role INTO v_role
  FROM public.users WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'powerhub-financial-settlement-site:' || p_tenant_id::text || ':' || p_site_id::text,0
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'powerhub-financial-settlement-row:' || p_tenant_id::text || ':' || p_settlement_id::text,0
  ));

  SELECT * INTO v_settlement
  FROM public.financial_settlements
  WHERE id = p_settlement_id
    AND tenant_id = p_tenant_id
    AND site_id = p_site_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SETTLEMENT_OUT_OF_SCOPE' USING ERRCODE = 'P0001';
  END IF;

  IF v_settlement.status = p_status THEN
    RETURN QUERY SELECT v_settlement.id;
    RETURN;
  END IF;

  IF v_settlement.status = 'locked' THEN
    RAISE EXCEPTION 'SETTLEMENT_ALREADY_LOCKED' USING ERRCODE = 'P0001';
  END IF;

  IF p_status = 'submitted' THEN
    IF v_settlement.status <> 'draft' THEN
      RAISE EXCEPTION 'INVALID_SETTLEMENT_TRANSITION' USING ERRCODE = 'P0001';
    END IF;
    IF v_settlement.ledger_reconciliation_status <> 'reconciled'
       OR v_settlement.ledger_snapshot IS NULL
       OR COALESCE((v_settlement.ledger_snapshot->>'isReconciled')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'SETTLEMENT_LEDGER_SNAPSHOT_REQUIRED' USING ERRCODE = 'P0001';
    END IF;
  ELSIF p_status = 'approved' THEN
    IF v_settlement.status <> 'submitted' THEN
      RAISE EXCEPTION 'SETTLEMENT_MUST_BE_SUBMITTED' USING ERRCODE = 'P0001';
    END IF;
    IF v_settlement.created_by_user_id = p_user_id THEN
      RAISE EXCEPTION 'SETTLEMENT_CREATOR_CANNOT_APPROVE' USING ERRCODE = 'P0001';
    END IF;
  ELSIF p_status = 'locked' THEN
    IF v_settlement.status <> 'approved'
       OR v_settlement.approved_by_user_id IS NULL THEN
      RAISE EXCEPTION 'SETTLEMENT_MUST_BE_APPROVED' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Recompute immediately before every non-idempotent transition. A payment,
  -- expense, supplier payment or cash movement may have been backdated after
  -- the draft was created; never approve or lock a stale ledger snapshot.
  IF v_settlement.ledger_reconciliation_status <> 'reconciled'
     OR v_settlement.ledger_snapshot IS NULL
     OR COALESCE((v_settlement.ledger_snapshot->>'isReconciled')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'SETTLEMENT_LEDGER_SNAPSHOT_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  IF NULLIF(v_settlement.ledger_snapshot->>'sourceFingerprint','') IS NULL THEN
    RAISE EXCEPTION 'SETTLEMENT_SOURCE_FINGERPRINT_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  v_current_snapshot := public.powerhub_financial_settlement_preview(
    p_tenant_id,p_site_id,v_settlement.period_start,v_settlement.period_end
  ) || jsonb_build_object(
    'sourceFingerprint',
    public.powerhub_financial_settlement_source_fingerprint(
      p_tenant_id,p_site_id,v_settlement.period_start,v_settlement.period_end
    )
  );

  IF COALESCE((v_current_snapshot->>'isReconciled')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'SETTLEMENT_LEDGER_RECONCILIATION_FAILED' USING ERRCODE = 'P0001';
  END IF;

  IF (v_settlement.ledger_snapshot - ARRAY['actualCash','difference','snapshotVersion','capturedAt'])
      IS DISTINCT FROM v_current_snapshot THEN
    RAISE EXCEPTION 'SETTLEMENT_SOURCE_LEDGER_CHANGED' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.financial_settlements
  SET status = p_status,
      approved_by_user_id = CASE
        WHEN p_status = 'approved' THEN p_user_id
        ELSE approved_by_user_id
      END,
      locked_at = CASE
        WHEN p_status = 'locked' THEN now()
        ELSE locked_at
      END,
      updated_at = now()
  WHERE id = p_settlement_id
    AND tenant_id = p_tenant_id
    AND site_id = p_site_id;

  INSERT INTO public.audit_logs (
    tenant_id,site_id,user_id,actor_platform_role,
    entity_type,entity_id,action,before_data,after_data
  )
  VALUES (
    p_tenant_id,p_site_id,p_user_id,v_role,
    'financial_settlement',p_settlement_id::text,'status_change',
    jsonb_build_object(
      'status',v_settlement.status,
      'approvedByUserId',v_settlement.approved_by_user_id,
      'lockedAt',v_settlement.locked_at
    ),
    jsonb_build_object(
      'status',p_status,
      'approvedByUserId',CASE
        WHEN p_status = 'approved' THEN p_user_id
        ELSE v_settlement.approved_by_user_id
      END,
      'lockedAt',CASE
        WHEN p_status = 'locked' THEN now()
        ELSE v_settlement.locked_at
      END
    )
  );

  RETURN QUERY SELECT p_settlement_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.powerhub_set_financial_settlement_status(bigint,bigint,bigint,bigint,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_set_financial_settlement_status(bigint,bigint,bigint,bigint,text)
  TO service_role;

NOTIFY pgrst,'reload schema';
