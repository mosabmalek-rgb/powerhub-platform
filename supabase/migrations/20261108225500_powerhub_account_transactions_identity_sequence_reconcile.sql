-- Reconcile account_transactions identity after bulk-imported test/legacy rows.
-- The sequence can remain behind existing IDs even while the table contains
-- much larger explicitly assigned IDs, causing manual deposits/withdrawals/
-- transfers and payroll-account postings to fail with account_transactions_pkey.
--
-- Apply atomically through the protected versioned release runner. The table
-- lock prevents competing inserts from taking an identity while the high-water
-- mark is checked. ALTER SEQUENCE RESTART is transactional (unlike setval).
-- No ledger rows are modified and the sequence is never moved backwards.

DO $preflight$
DECLARE
  v_seq text;
  v_inc bigint;
  v_cache bigint;
  v_cycle boolean;
BEGIN
  v_seq := pg_catalog.pg_get_serial_sequence('public.account_transactions','id');
  IF v_seq IS DISTINCT FROM 'public.account_transactions_id_seq' THEN
    RAISE EXCEPTION 'POWERHUB_ACCOUNT_TRANSACTION_IDENTITY_SEQUENCE_DRIFT: %',v_seq;
  END IF;

  SELECT increment_by,cache_size,cycle INTO v_inc,v_cache,v_cycle
  FROM pg_catalog.pg_sequences
  WHERE schemaname='public' AND sequencename='account_transactions_id_seq';
  IF v_inc IS DISTINCT FROM 1 OR v_cache IS DISTINCT FROM 1
     OR v_cycle IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'POWERHUB_ACCOUNT_TRANSACTION_IDENTITY_SEQUENCE_CONFIG_DRIFT';
  END IF;
END
$preflight$;

LOCK TABLE public.account_transactions IN SHARE ROW EXCLUSIVE MODE;

DO $reconcile$
DECLARE
  v_max_id bigint;
  v_last bigint;
  v_is_called boolean;
  v_next bigint;
  v_expected_next bigint;
BEGIN
  SELECT coalesce(max(id),0)
    INTO v_max_id FROM public.account_transactions;
  SELECT last_value,is_called
    INTO v_last,v_is_called FROM public.account_transactions_id_seq;
  IF v_max_id >= 9223372036854775807 OR v_last >= 9223372036854775807 THEN
    RAISE EXCEPTION 'POWERHUB_ACCOUNT_TRANSACTION_IDENTITY_EXHAUSTED';
  END IF;

  v_expected_next := CASE WHEN v_is_called THEN v_last+1 ELSE v_last END;
  v_next := greatest(v_expected_next,v_max_id+1);
  IF v_next > v_expected_next THEN
    EXECUTE pg_catalog.format(
      'ALTER SEQUENCE public.account_transactions_id_seq RESTART WITH %s',v_next
    );
  END IF;

  -- Verify the sequence will generate an ID strictly above every existing row.
  SELECT last_value,is_called
    INTO v_last,v_is_called FROM public.account_transactions_id_seq;
  IF (CASE WHEN v_is_called THEN v_last+1 ELSE v_last END) <= v_max_id THEN
    RAISE EXCEPTION 'POWERHUB_ACCOUNT_TRANSACTION_IDENTITY_RECONCILIATION_FAILED';
  END IF;
END
$reconcile$;
