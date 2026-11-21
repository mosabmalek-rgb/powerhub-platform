-- D28 source-backed cash -> document -> GL preflight, installed Staging only.
-- Exact tenant-1 fixture as of 2026-11, NOT a general certification.
-- Unsupported/unlinked legacy movements remain explicitly outside positive coverage.
-- Read-only; no DDL, DML, re-posting or inferred transfer pair creation.
BEGIN READ ONLY;
SET LOCAL statement_timeout='120000ms';
DO $d28$
DECLARE
 v_linked bigint;v_verified bigint;v_payment bigint;v_expense bigint;v_supplier bigint;
 v_duplicate bigint;v_mismatch bigint;v_unlinked bigint;v_gl bigint;v_lines bigint;v_tx bigint;
 v_supplier_amount numeric;v_payment_amount numeric;v_expense_amount numeric;
BEGIN
 SELECT count(*) INTO v_gl FROM public.financial_gl_entries;
 SELECT count(*) INTO v_lines FROM public.financial_gl_lines;
 SELECT count(*) INTO v_tx FROM public.account_transactions;
 IF v_gl<>25 OR v_lines<>51 OR v_tx<>361009
 OR NOT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations
   WHERE version='20261115193000' AND name='powerhub_financial_d27_transfer_operation_pair_provenance')
 THEN RAISE EXCEPTION 'D28_STAGING_FIXTURE_OR_D27_VERSION_CHANGED';END IF;

 WITH linked AS (
  SELECT t.*,ca.account_type,
   CASE WHEN t.related_payment_id IS NOT NULL THEN 'payment'
        WHEN t.related_expense_id IS NOT NULL THEN 'expense'
        WHEN t.related_supplier_payment_id IS NOT NULL THEN 'supplier_payment'
        WHEN t.related_supplier_return_id IS NOT NULL THEN 'supplier_return' END AS kind,
   (t.related_payment_id IS NOT NULL)::int+
   (t.related_expense_id IS NOT NULL)::int+
   (t.related_supplier_payment_id IS NOT NULL)::int+
   (t.related_supplier_return_id IS NOT NULL)::int AS link_count,
   coalesce(t.related_payment_id,t.related_expense_id,t.related_supplier_payment_id,
     t.related_supplier_return_id) AS document_id,
   CASE WHEN ca.account_type='cash' THEN '1010'
        WHEN ca.account_type IN ('jawwal_pay','palpay','bank_of_palestine','other')
          THEN '1020' END AS expected_cash_gl_code
  FROM public.account_transactions t
  LEFT JOIN public.company_accounts ca ON ca.id=t.account_id AND ca.tenant_id=t.tenant_id
  WHERE t.tenant_id=1 AND t.occurred_at<
    ('2026-12-01'::timestamp AT TIME ZONE 'Asia/Gaza')
   AND (t.related_payment_id IS NOT NULL OR t.related_expense_id IS NOT NULL
     OR t.related_supplier_payment_id IS NOT NULL OR t.related_supplier_return_id IS NOT NULL)
 ), source_and_gl AS (
  SELECT t.*,p.id payment_exists,p.status payment_status,p.amount payment_amount,
    x.id expense_exists,x.amount expense_amount,x.company_account_id expense_account,
    sp.id supplier_exists,sp.amount supplier_amount,sp.status supplier_status,
    sp.account_transaction_id supplier_transaction,sp.company_account_id supplier_account,
    sl.id supplier_ledger_id,sl.debit_amount supplier_ledger_debit,
    sl.credit_amount supplier_ledger_credit,
    e.id gl_entry_id,e.period gl_period,e.reverses_entry_id,
    count(*) OVER (PARTITION BY t.id) AS joined_rows_for_movement,
    count(*) OVER (PARTITION BY t.kind,t.document_id) AS source_link_uses,
    gl.exact_cash_lines,gl.cash_lines,gl.total_debit,gl.total_credit
  FROM linked t
  LEFT JOIN public.payments p ON t.kind='payment' AND p.id=t.related_payment_id
    AND p.tenant_id=t.tenant_id AND p.site_id=t.site_id
  LEFT JOIN public.expenses x ON t.kind='expense' AND x.id=t.related_expense_id
    AND x.tenant_id=t.tenant_id AND x.site_id=t.site_id
  LEFT JOIN public.supplier_payments sp ON t.kind='supplier_payment'
    AND sp.id=t.related_supplier_payment_id
    AND sp.tenant_id=t.tenant_id AND sp.site_id=t.site_id
  LEFT JOIN public.supplier_ledger_entries sl ON t.kind='supplier_payment'
    AND sl.supplier_payment_id=sp.id AND sl.tenant_id=sp.tenant_id
    AND sl.site_id=sp.site_id AND sl.entry_type='payment'
  LEFT JOIN public.financial_gl_entries e ON e.tenant_id=t.tenant_id
    AND e.site_id=t.site_id AND e.source_revision=1
    AND e.source_type=CASE WHEN t.kind='supplier_payment' THEN 'supplier_ledger'
                           ELSE t.kind END
    AND e.source_id=CASE WHEN t.kind='supplier_payment' THEN sl.id::text
                         ELSE t.document_id::text END
  LEFT JOIN LATERAL (
   SELECT count(*) FILTER(WHERE l.account_code IN ('1010','1020')) cash_lines,
    count(*) FILTER(WHERE l.account_code=t.expected_cash_gl_code
       AND l.side=CASE WHEN t.kind='payment' THEN 'debit' ELSE 'credit' END
       AND l.amount=t.amount) exact_cash_lines,
    coalesce(sum(l.amount) FILTER(WHERE l.side='debit'),0) total_debit,
    coalesce(sum(l.amount) FILTER(WHERE l.side='credit'),0) total_credit
   FROM public.financial_gl_lines l
   WHERE l.entry_id=e.id AND l.tenant_id=t.tenant_id AND l.site_id=t.site_id
  ) gl ON true
 ), proven AS (
  SELECT s.*,
   (s.link_count=1 AND s.source_link_uses=1 AND s.joined_rows_for_movement=1
    AND s.amount>0 AND s.amount=round(s.amount,2)
    AND s.expected_cash_gl_code IS NOT NULL
    AND (CASE WHEN s.kind='payment' THEN
      s.transaction_type='collection' AND s.payment_exists IS NOT NULL
      AND s.payment_status='completed' AND s.payment_amount=s.amount
     WHEN s.kind='expense' THEN
      s.transaction_type='withdrawal' AND s.expense_exists IS NOT NULL
      AND s.expense_amount=s.amount AND s.expense_account=s.account_id
     WHEN s.kind='supplier_payment' THEN
      s.transaction_type='withdrawal' AND s.supplier_exists IS NOT NULL
      AND s.supplier_status='posted' AND s.supplier_amount=s.amount
      AND s.supplier_transaction=s.id AND s.supplier_account=s.account_id
      AND s.supplier_ledger_id IS NOT NULL AND s.supplier_ledger_debit=s.amount
      AND s.supplier_ledger_credit=0
     ELSE false END)
    AND s.gl_entry_id IS NOT NULL AND s.gl_period<='2026-11'
    AND s.reverses_entry_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM public.financial_gl_entries reversal
      WHERE reversal.reverses_entry_id=s.gl_entry_id)
    AND s.cash_lines=1 AND s.exact_cash_lines=1
    AND s.total_debit=s.total_credit AND s.total_debit>0
   ) IS TRUE AS source_cash_gl_proven
  FROM source_and_gl s
 )
 SELECT count(*),count(*) FILTER(WHERE source_cash_gl_proven),
  count(*) FILTER(WHERE kind='payment' AND source_cash_gl_proven),
  count(*) FILTER(WHERE kind='expense' AND source_cash_gl_proven),
  count(*) FILTER(WHERE kind='supplier_payment' AND source_cash_gl_proven),
  count(*) FILTER(WHERE source_link_uses<>1 OR joined_rows_for_movement<>1),
  count(*) FILTER(WHERE NOT source_cash_gl_proven),
  coalesce(sum(amount) FILTER(WHERE kind='payment' AND source_cash_gl_proven),0),
  coalesce(sum(amount) FILTER(WHERE kind='expense' AND source_cash_gl_proven),0),
  coalesce(sum(amount) FILTER(WHERE kind='supplier_payment' AND source_cash_gl_proven),0)
 INTO v_linked,v_verified,v_payment,v_expense,v_supplier,v_duplicate,v_mismatch,
  v_payment_amount,v_expense_amount,v_supplier_amount
 FROM proven;
 IF v_linked<>9 OR v_verified<>9 OR v_payment<>6 OR v_expense<>1
 OR v_supplier<>2 OR v_duplicate<>0 OR v_mismatch<>0
 OR v_payment_amount<>667 OR v_expense_amount<>85 OR v_supplier_amount<>360
 THEN RAISE EXCEPTION 'D28_LINKED_SOURCE_CASH_GL_CHAIN_DRIFT linked=% proven=% duplicate=% mismatch=%',
   v_linked,v_verified,v_duplicate,v_mismatch; END IF;

 SELECT count(*) INTO v_unlinked FROM public.account_transactions t
 WHERE t.tenant_id=1 AND t.occurred_at<
  ('2026-12-01'::timestamp AT TIME ZONE 'Asia/Gaza')
 AND t.transaction_type NOT IN ('transfer_in','transfer_out')
 AND t.related_payment_id IS NULL AND t.related_expense_id IS NULL
 AND t.related_supplier_payment_id IS NULL AND t.related_supplier_return_id IS NULL;
 IF v_unlinked=0 THEN RAISE EXCEPTION 'D28_UNLINKED_LEGACY_MOVEMENTS_UNEXPECTEDLY_CLEARED';END IF;
 IF (public.powerhub_financial_company_transfer_pair_provenance(9000000000001,'2026-10')->>'status')
   IS DISTINCT FROM 'BLOCKED_TRANSFER_PROVENANCE'
 THEN RAISE EXCEPTION 'D28_D27_TRANSFER_BLOCKER_MISSING';END IF;

 IF (SELECT count(*) FROM public.financial_gl_entries)<>v_gl
  OR (SELECT count(*) FROM public.financial_gl_lines)<>v_lines
  OR (SELECT count(*) FROM public.account_transactions)<>v_tx
 THEN RAISE EXCEPTION 'D28_FINANCIAL_BASELINE_CHANGED';END IF;
END $d28$;
SELECT 'D28_INSTALLED_STAGING_SOURCE_LINKED_CASH_GL_CHAIN_SCOPED_PASS' AS result;
ROLLBACK;
