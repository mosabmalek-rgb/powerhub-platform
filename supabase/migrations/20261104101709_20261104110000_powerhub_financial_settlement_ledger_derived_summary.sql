-- Derive financial settlement figures from tenant/site-scoped ledgers.
-- Operating collections are invoice-applied amounts only. Cash flow is reconciled
-- separately from account_transactions, including opening balances and transfers.
-- Subscriber credit, security deposits, supplier payments and inventory procurement
-- are disclosed separately and are not silently counted as operating profit.

ALTER TABLE public.financial_settlements
  ADD COLUMN IF NOT EXISTS cash_opening_balance numeric(14,2),
  ADD COLUMN IF NOT EXISTS cash_inflows numeric(14,2),
  ADD COLUMN IF NOT EXISTS cash_outflows numeric(14,2),
  ADD COLUMN IF NOT EXISTS book_cash_balance numeric(14,2),
  ADD COLUMN IF NOT EXISTS ledger_reconciliation_status text,
  ADD COLUMN IF NOT EXISTS ledger_snapshot jsonb;

UPDATE public.financial_settlements
SET ledger_reconciliation_status = 'legacy'
WHERE ledger_reconciliation_status IS NULL;

ALTER TABLE public.financial_settlements
  ALTER COLUMN ledger_reconciliation_status SET DEFAULT 'legacy',
  ALTER COLUMN ledger_reconciliation_status SET NOT NULL;

ALTER TABLE public.financial_settlements
  DROP CONSTRAINT IF EXISTS financial_settlements_ledger_reconciliation_status_check;

ALTER TABLE public.financial_settlements
  ADD CONSTRAINT financial_settlements_ledger_reconciliation_status_check
  CHECK (ledger_reconciliation_status IN ('legacy','reconciled','attention_required'));

COMMENT ON COLUMN public.financial_settlements.total_collected IS
  'Invoice-applied collections only; subscriber credit and security deposits are excluded.';
COMMENT ON COLUMN public.financial_settlements.total_expenses IS
  'Operating expenses recorded in public.expenses during the settlement period.';
COMMENT ON COLUMN public.financial_settlements.difference IS
  'Actual closing cash minus derived book cash balance; NULL when no physical count was supplied.';
COMMENT ON COLUMN public.financial_settlements.book_cash_balance IS
  'Derived closing cash from allocated opening balances and site-scoped account movements.';
COMMENT ON COLUMN public.financial_settlements.ledger_snapshot IS
  'Immutable source summary used to create and approve this settlement. Legacy rows remain NULL.';

CREATE OR REPLACE FUNCTION public.powerhub_financial_settlement_preview(
  p_tenant_id bigint,
  p_site_id bigint,
  p_period_start timestamptz,
  p_period_end timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_total_collected numeric(14,2) := 0;
  v_total_expenses numeric(14,2) := 0;
  v_book_profit numeric(14,2) := 0;
  v_subscriber_credit_created numeric(14,2) := 0;
  v_security_deposit_received numeric(14,2) := 0;
  v_security_deposit_refunded numeric(14,2) := 0;
  v_supplier_payment_amount numeric(14,2) := 0;
  v_supplier_purchase_invoice_amount numeric(14,2) := 0;
  v_supplier_return_credit_amount numeric(14,2) := 0;
  v_supplier_return_refund_amount numeric(14,2) := 0;
  v_cash_opening_balance numeric(14,2) := 0;
  v_account_opening_balance_added numeric(14,2) := 0;
  v_unallocated_shared_opening_balance numeric(14,2) := 0;
  v_cash_transaction_inflows numeric(14,2) := 0;
  v_cash_transaction_outflows numeric(14,2) := 0;
  v_cash_inflows numeric(14,2) := 0;
  v_cash_outflows numeric(14,2) := 0;
  v_book_cash_balance numeric(14,2);
  v_collection_cash numeric(14,2) := 0;
  v_other_collection_cash numeric(14,2) := 0;
  v_deposit_cash numeric(14,2) := 0;
  v_security_deposit_cash_in numeric(14,2) := 0;
  v_supplier_return_cash_in numeric(14,2) := 0;
  v_other_deposit_cash numeric(14,2) := 0;
  v_transfer_in_cash numeric(14,2) := 0;
  v_expense_cash_out numeric(14,2) := 0;
  v_supplier_payment_cash_out numeric(14,2) := 0;
  v_security_deposit_refund_cash_out numeric(14,2) := 0;
  v_other_payment_cash_out numeric(14,2) := 0;
  v_other_withdrawal_cash numeric(14,2) := 0;
  v_transfer_out_cash numeric(14,2) := 0;
  v_payment_cash_mismatch_count bigint := 0;
  v_expense_cash_mismatch_count bigint := 0;
  v_supplier_payment_cash_mismatch_count bigint := 0;
  v_supplier_return_cash_mismatch_count bigint := 0;
  v_unlinked_account_movement_count bigint := 0;
  v_orphan_reference_movement_count bigint := 0;
  v_operating_expenses_by_category jsonb := '{}'::jsonb;
  v_cash_balance_complete boolean := false;
  v_is_reconciled boolean := false;
  v_integrity_issue_count bigint := 0;
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id < 1
     OR p_site_id IS NULL OR p_site_id < 1
     OR p_period_start IS NULL OR p_period_end IS NULL
     OR p_period_start >= p_period_end THEN
    RAISE EXCEPTION 'INVALID_SETTLEMENT_PERIOD' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.sites s
    WHERE s.tenant_id = p_tenant_id
      AND s.id = p_site_id
      AND s.status <> 'archived'
  ) THEN
    RAISE EXCEPTION 'SITE_OUT_OF_SCOPE' USING ERRCODE = 'P0001';
  END IF;

  -- Profit-side collections: the part applied to an invoice only.
  SELECT
    COALESCE(SUM(
      CASE WHEN p.payment_purpose IN ('invoice_collection','invoice_collection_with_credit')
        THEN p.invoice_applied_amount ELSE 0 END
    ),0)::numeric(14,2),
    COALESCE(SUM(
      CASE WHEN p.payment_purpose IN ('invoice_collection_with_credit','subscriber_credit')
        THEN p.subscriber_credit_amount ELSE 0 END
    ),0)::numeric(14,2),
    COALESCE(SUM(CASE WHEN p.payment_purpose='security_deposit' THEN p.amount ELSE 0 END),0)::numeric(14,2),
    COALESCE(SUM(CASE WHEN p.payment_purpose='security_deposit_refund' THEN p.amount ELSE 0 END),0)::numeric(14,2)
  INTO
    v_total_collected,
    v_subscriber_credit_created,
    v_security_deposit_received,
    v_security_deposit_refunded
  FROM public.payments p
  WHERE p.tenant_id = p_tenant_id
    AND p.site_id = p_site_id
    AND p.status = 'completed'
    AND p.paid_at >= p_period_start
    AND p.paid_at <= p_period_end;

  SELECT COALESCE(SUM(e.amount),0)::numeric(14,2)
  INTO v_total_expenses
  FROM public.expenses e
  WHERE e.tenant_id = p_tenant_id
    AND e.site_id = p_site_id
    AND e.occurred_at >= p_period_start
    AND e.occurred_at <= p_period_end;

  v_book_profit := round(v_total_collected - v_total_expenses,2);

  SELECT COALESCE(jsonb_object_agg(x.category,x.amount),'{}'::jsonb)
  INTO v_operating_expenses_by_category
  FROM (
    SELECT e.category, SUM(e.amount)::numeric(14,2) AS amount
    FROM public.expenses e
    WHERE e.tenant_id = p_tenant_id
      AND e.site_id = p_site_id
      AND e.occurred_at >= p_period_start
      AND e.occurred_at <= p_period_end
    GROUP BY e.category
  ) x;

  -- Source-to-cash checks prevent a profit or cash snapshot from hiding
  -- completed payments, expenses or supplier settlements that lack their
  -- corresponding company-account movement.
  SELECT count(*)::bigint
  INTO v_payment_cash_mismatch_count
  FROM public.payments p
  WHERE p.tenant_id = p_tenant_id
    AND p.site_id = p_site_id
    AND p.status = 'completed'
    AND p.paid_at >= p_period_start
    AND p.paid_at <= p_period_end
    AND (
      (SELECT count(*) FROM public.account_transactions t
        WHERE t.tenant_id=p.tenant_id AND t.site_id=p.site_id AND t.related_payment_id=p.id) <> 1
      OR NOT EXISTS (
        SELECT 1 FROM public.account_transactions t
        WHERE t.tenant_id=p.tenant_id AND t.site_id=p.site_id
          AND t.related_payment_id=p.id
          AND t.occurred_at >= p_period_start AND t.occurred_at <= p_period_end
          AND t.amount=p.amount
          AND t.transaction_type=CASE
            WHEN p.payment_purpose='security_deposit' THEN 'deposit'
            WHEN p.payment_purpose='security_deposit_refund' THEN 'withdrawal'
            ELSE 'collection'
          END
      )
    );

  SELECT count(*)::bigint
  INTO v_expense_cash_mismatch_count
  FROM public.expenses e
  WHERE e.tenant_id = p_tenant_id
    AND e.site_id = p_site_id
    AND e.occurred_at >= p_period_start
    AND e.occurred_at <= p_period_end
    AND (
      (SELECT count(*) FROM public.account_transactions t
        WHERE t.tenant_id=e.tenant_id AND t.site_id=e.site_id AND t.related_expense_id=e.id) <> 1
      OR NOT EXISTS (
        SELECT 1 FROM public.account_transactions t
        WHERE t.tenant_id=e.tenant_id AND t.site_id=e.site_id
          AND t.related_expense_id=e.id
          AND t.occurred_at >= p_period_start AND t.occurred_at <= p_period_end
          AND t.transaction_type='withdrawal' AND t.amount=e.amount
      )
    );

  SELECT
    (
      SELECT count(*)::bigint
      FROM public.supplier_payments sp
      WHERE sp.tenant_id = p_tenant_id
        AND sp.site_id = p_site_id
        AND sp.status = 'posted'
        AND sp.payment_date >= (p_period_start AT TIME ZONE 'UTC')::date
        AND sp.payment_date <= (p_period_end AT TIME ZONE 'UTC')::date
        AND (
          (SELECT count(*) FROM public.account_transactions t
            WHERE t.tenant_id=sp.tenant_id AND t.site_id=sp.site_id AND t.related_supplier_payment_id=sp.id) <> 1
          OR NOT EXISTS (
            SELECT 1 FROM public.account_transactions t
            WHERE t.id=sp.account_transaction_id AND t.tenant_id=sp.tenant_id AND t.site_id=sp.site_id
              AND t.related_supplier_payment_id=sp.id
              AND t.occurred_at >= p_period_start AND t.occurred_at <= p_period_end
              AND t.transaction_type='withdrawal' AND t.amount=sp.amount
          )
        )
    )::bigint,
    (
      SELECT COALESCE(SUM(sp.amount),0)::numeric(14,2)
      FROM public.supplier_payments sp
      WHERE sp.tenant_id = p_tenant_id
        AND sp.site_id = p_site_id
        AND sp.status = 'posted'
        AND sp.payment_date >= (p_period_start AT TIME ZONE 'UTC')::date
        AND sp.payment_date <= (p_period_end AT TIME ZONE 'UTC')::date
    )
  INTO v_supplier_payment_cash_mismatch_count, v_supplier_payment_amount;

  SELECT
    (
      SELECT count(*)::bigint
      FROM public.supplier_purchase_returns r
      WHERE r.tenant_id = p_tenant_id
        AND r.site_id = p_site_id
        AND r.status = 'posted'
        AND r.return_date >= (p_period_start AT TIME ZONE 'UTC')::date
        AND r.return_date <= (p_period_end AT TIME ZONE 'UTC')::date
        AND r.refund_amount > 0
        AND (
          (SELECT count(*) FROM public.account_transactions t
            WHERE t.tenant_id=r.tenant_id AND t.site_id=r.site_id AND t.related_supplier_return_id=r.id) <> 1
          OR NOT EXISTS (
            SELECT 1 FROM public.account_transactions t
            WHERE t.tenant_id=r.tenant_id AND t.site_id=r.site_id
              AND t.related_supplier_return_id=r.id
              AND t.occurred_at >= p_period_start AND t.occurred_at <= p_period_end
              AND t.transaction_type='deposit' AND t.amount=r.refund_amount
          )
        )
    )::bigint,
    (
      SELECT COALESCE(SUM(r.total_credit_amount),0)::numeric(14,2)
      FROM public.supplier_purchase_returns r
      WHERE r.tenant_id = p_tenant_id
        AND r.site_id = p_site_id
        AND r.status = 'posted'
        AND r.return_date >= (p_period_start AT TIME ZONE 'UTC')::date
        AND r.return_date <= (p_period_end AT TIME ZONE 'UTC')::date
    ),
    (
      SELECT COALESCE(SUM(r.refund_amount),0)::numeric(14,2)
      FROM public.supplier_purchase_returns r
      WHERE r.tenant_id = p_tenant_id
        AND r.site_id = p_site_id
        AND r.status = 'posted'
        AND r.return_date >= (p_period_start AT TIME ZONE 'UTC')::date
        AND r.return_date <= (p_period_end AT TIME ZONE 'UTC')::date
    )
  INTO v_supplier_return_cash_mismatch_count,
       v_supplier_return_credit_amount,
       v_supplier_return_refund_amount;

  SELECT COALESCE(SUM(p.total_amount),0)::numeric(14,2)
  INTO v_supplier_purchase_invoice_amount
  FROM public.supplier_purchases p
  WHERE p.tenant_id = p_tenant_id
    AND p.site_id = p_site_id
    AND p.invoice_date >= (p_period_start AT TIME ZONE 'UTC')::date
    AND p.invoice_date <= (p_period_end AT TIME ZONE 'UTC')::date
    AND p.status IN ('confirmed','partially_received','received');

  -- Attribute account opening balances only when the account belongs to one site.
  -- Non-zero opening balances on shared accounts are unallocated and block reconciliation.
  WITH account_scopes AS (
    SELECT
      ca.id,
      ca.opening_balance,
      ca.created_at,
      count(DISTINCT cas.site_id)::bigint AS linked_site_count,
      COALESCE(bool_or(cas.site_id = p_site_id),false) AS belongs_to_site
    FROM public.company_accounts ca
    LEFT JOIN public.company_account_sites cas
      ON cas.tenant_id = ca.tenant_id
     AND cas.account_id = ca.id
    WHERE ca.tenant_id = p_tenant_id
    GROUP BY ca.id,ca.opening_balance,ca.created_at
  )
  SELECT
    COALESCE(SUM(
      CASE WHEN linked_site_count=1 AND created_at < p_period_start
        THEN opening_balance ELSE 0 END
    ),0)::numeric(14,2),
    COALESCE(SUM(
      CASE WHEN linked_site_count=1
        AND created_at >= p_period_start AND created_at <= p_period_end
        THEN opening_balance ELSE 0 END
    ),0)::numeric(14,2),
    COALESCE(SUM(
      CASE WHEN linked_site_count>1 AND created_at <= p_period_end
        THEN abs(opening_balance) ELSE 0 END
    ),0)::numeric(14,2)
  INTO
    v_cash_opening_balance,
    v_account_opening_balance_added,
    v_unallocated_shared_opening_balance
  FROM account_scopes
  WHERE belongs_to_site;

  SELECT v_cash_opening_balance + COALESCE(SUM(
    CASE WHEN t.transaction_type IN ('deposit','transfer_in','collection')
      THEN t.amount ELSE -t.amount END
  ),0)::numeric(14,2)
  INTO v_cash_opening_balance
  FROM public.account_transactions t
  WHERE t.tenant_id = p_tenant_id
    AND t.site_id = p_site_id
    AND t.occurred_at < p_period_start;

  -- Period cash movements are independent of operating profit. Transfers
  -- affect branch cash only when they cross the selected branch boundary.
  SELECT
    COALESCE(SUM(t.amount) FILTER (WHERE t.transaction_type IN ('deposit','transfer_in','collection')),0)::numeric(14,2),
    COALESCE(SUM(t.amount) FILTER (WHERE t.transaction_type IN ('withdrawal','transfer_out')),0)::numeric(14,2),
    COALESCE(SUM(t.amount) FILTER (
      WHERE t.transaction_type='collection' AND EXISTS (
        SELECT 1 FROM public.payments p
        WHERE p.tenant_id=t.tenant_id AND p.site_id=t.site_id
          AND p.id=t.related_payment_id AND p.status='completed'
          AND p.payment_purpose IN ('invoice_collection','invoice_collection_with_credit','subscriber_credit')
      )
    ),0)::numeric(14,2),
    COALESCE(SUM(t.amount) FILTER (
      WHERE t.transaction_type='collection' AND NOT EXISTS (
        SELECT 1 FROM public.payments p
        WHERE p.tenant_id=t.tenant_id AND p.site_id=t.site_id
          AND p.id=t.related_payment_id AND p.status='completed'
          AND p.payment_purpose IN ('invoice_collection','invoice_collection_with_credit','subscriber_credit')
      )
    ),0)::numeric(14,2),
    COALESCE(SUM(t.amount) FILTER (WHERE t.transaction_type='deposit'),0)::numeric(14,2),
    COALESCE(SUM(t.amount) FILTER (WHERE t.transaction_type='transfer_in'),0)::numeric(14,2),
    COALESCE(SUM(t.amount) FILTER (WHERE t.transaction_type='withdrawal' AND t.related_expense_id IS NOT NULL),0)::numeric(14,2),
    COALESCE(SUM(t.amount) FILTER (WHERE t.transaction_type='withdrawal' AND t.related_supplier_payment_id IS NOT NULL),0)::numeric(14,2),
    COALESCE(SUM(t.amount) FILTER (WHERE t.transaction_type='transfer_out'),0)::numeric(14,2),
    COALESCE(SUM(t.amount) FILTER (
      WHERE t.transaction_type='withdrawal'
        AND t.related_expense_id IS NULL
        AND t.related_supplier_payment_id IS NULL
        AND t.related_payment_id IS NULL
        AND t.related_supplier_return_id IS NULL
    ),0)::numeric(14,2)
  INTO
    v_cash_transaction_inflows,
    v_cash_transaction_outflows,
    v_collection_cash,
    v_other_collection_cash,
    v_deposit_cash,
    v_transfer_in_cash,
    v_expense_cash_out,
    v_supplier_payment_cash_out,
    v_transfer_out_cash,
    v_other_withdrawal_cash
  FROM public.account_transactions t
  WHERE t.tenant_id = p_tenant_id
    AND t.site_id = p_site_id
    AND t.occurred_at >= p_period_start
    AND t.occurred_at <= p_period_end;

  SELECT
    COALESCE(SUM(t.amount) FILTER (
      WHERE t.transaction_type='deposit'
        AND t.related_payment_id IS NOT NULL
        AND p.payment_purpose='security_deposit'
    ),0)::numeric(14,2),
    COALESCE(SUM(t.amount) FILTER (
      WHERE t.transaction_type='deposit' AND t.related_supplier_return_id IS NOT NULL
    ),0)::numeric(14,2),
    COALESCE(SUM(t.amount) FILTER (
      WHERE t.transaction_type='withdrawal'
        AND t.related_payment_id IS NOT NULL
        AND p.payment_purpose='security_deposit_refund'
    ),0)::numeric(14,2),
    COALESCE(SUM(t.amount) FILTER (
      WHERE t.transaction_type='deposit'
        AND NOT (t.related_payment_id IS NOT NULL AND p.payment_purpose='security_deposit')
        AND t.related_supplier_return_id IS NULL
    ),0)::numeric(14,2),
    COALESCE(SUM(t.amount) FILTER (
      WHERE t.transaction_type='withdrawal'
        AND t.related_payment_id IS NOT NULL
        AND COALESCE(p.payment_purpose,'') <> 'security_deposit_refund'
    ),0)::numeric(14,2)
  INTO
    v_security_deposit_cash_in,
    v_supplier_return_cash_in,
    v_security_deposit_refund_cash_out,
    v_other_deposit_cash,
    v_other_payment_cash_out
  FROM public.account_transactions t
  LEFT JOIN public.payments p
    ON p.tenant_id = t.tenant_id
   AND p.site_id = t.site_id
   AND p.id = t.related_payment_id
  WHERE t.tenant_id = p_tenant_id
    AND t.site_id = p_site_id
    AND t.occurred_at >= p_period_start
    AND t.occurred_at <= p_period_end;

  SELECT count(*)::bigint
  INTO v_orphan_reference_movement_count
  FROM public.account_transactions t
  WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id
    AND t.occurred_at >= p_period_start AND t.occurred_at <= p_period_end
    AND (
      num_nonnulls(t.related_payment_id,t.related_expense_id,t.related_supplier_payment_id,t.related_supplier_return_id) > 1
      OR (t.related_payment_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.payments p
        WHERE p.tenant_id=t.tenant_id AND p.site_id=t.site_id AND p.id=t.related_payment_id
          AND p.status='completed' AND p.paid_at >= p_period_start AND p.paid_at <= p_period_end
      ))
      OR (t.related_expense_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.expenses e
        WHERE e.tenant_id=t.tenant_id AND e.site_id=t.site_id AND e.id=t.related_expense_id
          AND e.occurred_at >= p_period_start AND e.occurred_at <= p_period_end
      ))
      OR (t.related_supplier_payment_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.supplier_payments sp
        WHERE sp.tenant_id=t.tenant_id AND sp.site_id=t.site_id
          AND sp.id=t.related_supplier_payment_id AND sp.status='posted'
          AND sp.payment_date >= (p_period_start AT TIME ZONE 'UTC')::date
          AND sp.payment_date <= (p_period_end AT TIME ZONE 'UTC')::date
      ))
      OR (t.related_supplier_return_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.supplier_purchase_returns r
        WHERE r.tenant_id=t.tenant_id AND r.site_id=t.site_id
          AND r.id=t.related_supplier_return_id AND r.status='posted' AND r.refund_amount>0
          AND r.return_date >= (p_period_start AT TIME ZONE 'UTC')::date
          AND r.return_date <= (p_period_end AT TIME ZONE 'UTC')::date
      ))
    );

  SELECT count(*)::bigint
  INTO v_unlinked_account_movement_count
  FROM public.account_transactions t
  WHERE t.tenant_id = p_tenant_id
    AND t.site_id = p_site_id
    AND t.occurred_at <= p_period_end
    AND NOT EXISTS (
      SELECT 1
      FROM public.company_account_sites cas
      WHERE cas.tenant_id = t.tenant_id
        AND cas.account_id = t.account_id
        AND cas.site_id = t.site_id
    );

  v_cash_inflows := round(v_cash_transaction_inflows + v_account_opening_balance_added,2);
  v_cash_outflows := v_cash_transaction_outflows;

  v_cash_balance_complete :=
    v_unallocated_shared_opening_balance = 0
    AND v_unlinked_account_movement_count = 0
    AND v_orphan_reference_movement_count = 0
    AND v_payment_cash_mismatch_count = 0
    AND v_expense_cash_mismatch_count = 0
    AND v_supplier_payment_cash_mismatch_count = 0
    AND v_supplier_return_cash_mismatch_count = 0;

  v_integrity_issue_count :=
    v_payment_cash_mismatch_count
    + v_expense_cash_mismatch_count
    + v_supplier_payment_cash_mismatch_count
    + v_supplier_return_cash_mismatch_count
    + v_unlinked_account_movement_count
    + v_orphan_reference_movement_count
    + CASE WHEN v_unallocated_shared_opening_balance <> 0 THEN 1 ELSE 0 END;

  v_is_reconciled := v_cash_balance_complete;

  IF v_cash_balance_complete THEN
    v_book_cash_balance := round(v_cash_opening_balance + v_cash_inflows - v_cash_outflows,2);
  ELSE
    v_book_cash_balance := NULL;
  END IF;

  RETURN jsonb_build_object(
    'tenantId',p_tenant_id,
    'siteId',p_site_id,
    'periodStart',p_period_start,
    'periodEnd',p_period_end,
    'totalCollected',v_total_collected,
    'totalExpenses',v_total_expenses,
    'bookProfit',v_book_profit,
    'cashOpeningBalance',v_cash_opening_balance,
    'cashInflows',v_cash_inflows,
    'cashOutflows',v_cash_outflows,
    'bookCashBalance',v_book_cash_balance,
    'cashBalanceComplete',v_cash_balance_complete,
    'isReconciled',v_is_reconciled,
    'subscriberCreditCreated',v_subscriber_credit_created,
    'securityDepositReceived',v_security_deposit_received,
    'securityDepositRefunded',v_security_deposit_refunded,
    'supplierPaymentAmount',v_supplier_payment_amount,
    'supplierPurchaseInvoiceAmount',v_supplier_purchase_invoice_amount,
    'supplierReturnCreditAmount',v_supplier_return_credit_amount,
    'supplierReturnRefundAmount',v_supplier_return_refund_amount,
    'operatingExpensesByCategory',v_operating_expenses_by_category,
    'cashBreakdown',jsonb_build_object(
      'inflows',jsonb_build_object(
        'subscriberCollections',v_collection_cash,
        'otherCollections',v_other_collection_cash,
        'securityDepositReceipts',v_security_deposit_cash_in,
        'supplierReturnRefunds',v_supplier_return_cash_in,
        'otherDeposits',v_other_deposit_cash,
        'transfersIn',v_transfer_in_cash,
        'accountOpeningBalanceAdded',v_account_opening_balance_added
      ),
      'outflows',jsonb_build_object(
        'operatingExpenses',v_expense_cash_out,
        'supplierPayments',v_supplier_payment_cash_out,
        'securityDepositRefunds',v_security_deposit_refund_cash_out,
        'otherPaymentRefunds',v_other_payment_cash_out,
        'otherWithdrawals',v_other_withdrawal_cash,
        'transfersOut',v_transfer_out_cash
      )
    ),
    'reconciliation',jsonb_build_object(
      'paymentCashMismatchCount',v_payment_cash_mismatch_count,
      'expenseCashMismatchCount',v_expense_cash_mismatch_count,
      'supplierPaymentCashMismatchCount',v_supplier_payment_cash_mismatch_count,
      'supplierReturnCashMismatchCount',v_supplier_return_cash_mismatch_count,
      'unlinkedAccountMovementCount',v_unlinked_account_movement_count,
      'orphanReferenceMovementCount',v_orphan_reference_movement_count,
      'unallocatedSharedOpeningBalance',v_unallocated_shared_opening_balance,
      'issueCount',v_integrity_issue_count,
      'status',CASE WHEN v_is_reconciled THEN 'reconciled' ELSE 'attention_required' END
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.powerhub_financial_settlement_preview(bigint,bigint,timestamptz,timestamptz)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_settlement_preview(bigint,bigint,timestamptz,timestamptz)
  TO service_role;

-- Remove the service-only manual-total entry point. New settlements are derived
-- again inside this transaction, so a stale or tampered preview cannot set totals.
DROP FUNCTION IF EXISTS public.powerhub_create_financial_settlement(
  bigint,bigint,bigint,timestamptz,timestamptz,numeric,numeric,numeric,text
);

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

REVOKE ALL ON FUNCTION public.powerhub_create_financial_settlement(
  bigint,bigint,bigint,timestamptz,timestamptz,numeric,text
) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_create_financial_settlement(
  bigint,bigint,bigint,timestamptz,timestamptz,numeric,text
) TO service_role;

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

  v_current_snapshot := public.powerhub_financial_settlement_preview(
    p_tenant_id,p_site_id,v_settlement.period_start,v_settlement.period_end
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

REVOKE ALL ON FUNCTION public.powerhub_set_financial_settlement_status(
  bigint,bigint,bigint,bigint,text
) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_set_financial_settlement_status(
  bigint,bigint,bigint,bigint,text
) TO service_role;

NOTIFY pgrst, 'reload schema';
