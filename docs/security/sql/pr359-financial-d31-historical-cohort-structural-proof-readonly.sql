-- D31 — exact structural and content-fingerprint snapshot of the PH-PERF 1K/10K/100K Staging cohort.
-- READ ONLY. This is not generator-source attestation, human review, accounting exclusion,
-- historical transfer-pair proof, cash reconciliation, GL posting, or certification.
-- Fail closed on any change to the three exact batches or their business-side references.
BEGIN READ ONLY;
SET LOCAL statement_timeout='120000ms';
DO $d31$
DECLARE
  v_count bigint;
  v_batches integer;
  v_created_count bigint;
  v_created_min timestamptz;
  v_other_tenant bigint;
  v_external bigint;
  v_expected_n bigint;
  v_expected_sha text;
  r record;
BEGIN
  SELECT count(*),count(DISTINCT created_at),min(created_at)
    INTO v_count,v_created_count,v_created_min
  FROM public.account_transactions WHERE tenant_id=9000000000001;
  IF v_count<>111000 OR v_created_count<>1
     OR v_created_min IS DISTINCT FROM '2026-11-05 13:32:57.404403+00'::timestamptz
     OR (SELECT count(*) FROM public.account_transactions
         WHERE tenant_id=9000000000001 AND occurred_at<
           ('2026-11-01'::timestamp AT TIME ZONE 'Asia/Gaza'))<>105544
     OR (SELECT count(*) FROM public.financial_gl_entries)<>25
     OR (SELECT count(*) FROM public.financial_gl_lines)<>51
     OR (SELECT count(*) FROM public.account_transactions)<>361009
     OR EXISTS(SELECT 1 FROM public.financial_gl_entries
          WHERE tenant_id=9000000000001)
     OR EXISTS(SELECT 1 FROM public.company_account_movement_operations
          WHERE tenant_id=9000000000001)
  THEN RAISE EXCEPTION 'D31_FINANCIAL_BASELINE_OR_COHORT_SCOPE_DRIFT'; END IF;

  SELECT count(*) INTO v_other_tenant FROM public.account_transactions
   WHERE reference_no LIKE 'PH-PERF-%' AND tenant_id<>9000000000001;
  IF v_other_tenant<>0 THEN
    RAISE EXCEPTION 'D31_PREFIX_NOT_EXCLUSIVE_TO_TEST_TENANT'; END IF;

  v_batches:=0;
  FOR r IN
    WITH s AS MATERIALIZED (
      SELECT t.*,
       CASE WHEN id BETWEEN 900000000100001 AND 900000000101000 THEN '1K'
            WHEN id BETWEEN 900000000300001 AND 900000000310000 THEN '10K'
            WHEN id BETWEEN 900000000400001 AND 900000000500000 THEN '100K'
            ELSE 'UNKNOWN' END batch,
       CASE WHEN id BETWEEN 900000000100001 AND 900000000101000
                     THEN id-900000000100000
            WHEN id BETWEEN 900000000300001 AND 900000000310000
                     THEN id-900000000300000
            WHEN id BETWEEN 900000000400001 AND 900000000500000
                     THEN id-900000000400000 END seq
      FROM public.account_transactions t WHERE tenant_id=9000000000001
    )
    SELECT batch,count(*) n,
      encode(extensions.digest(string_agg(
        s.id::text||'='||(to_jsonb(s)-'batch'-'seq')::text,chr(10)
        ORDER BY s.id),'sha256'),'hex') sha256,
      count(*) FILTER(WHERE seq IS NULL OR
        reference_no IS DISTINCT FROM ('PH-PERF-'||batch||'-'||lpad(seq::text,6,'0'))
        OR description IS DISTINCT FROM
           (CASE WHEN seq%97=0 THEN 'تحصيل فاتورة تجريبي — PH PERF'
             ELSE ('PH PERF synthetic '||batch||' ledger movement '||seq::text) END)
        OR amount IS DISTINCT FROM (1+(seq%200))::numeric
        OR transaction_type IS DISTINCT FROM
           (CASE seq%10 WHEN 1 THEN 'transfer_out' WHEN 2 THEN 'transfer_in'
              WHEN 3 THEN 'deposit' WHEN 0 THEN 'withdrawal'
              ELSE 'collection' END)
        OR site_id IS DISTINCT FROM
           (CASE WHEN seq%2=0 THEN 9000000000011 ELSE 9000000000012 END)
        OR account_id IS DISTINCT FROM
           (CASE batch WHEN '1K' THEN 9000000000101
             WHEN '10K' THEN 9000000000102
             WHEN '100K' THEN 9000000000103 END)
        OR occurred_at<'2026-08-07 13:32:57+00'::timestamptz
        OR occurred_at>'2026-11-05 20:11:39+00'::timestamptz
        OR created_by_user_id IS NOT NULL
        OR related_payment_id IS NOT NULL
        OR related_expense_id IS NOT NULL
        OR related_supplier_payment_id IS NOT NULL
        OR related_supplier_return_id IS NOT NULL
        OR related_account_id IS NOT NULL
      ) invalid_rows
    FROM s GROUP BY batch ORDER BY batch
  LOOP
    v_batches:=v_batches+1;
    CASE r.batch
      WHEN '1K' THEN v_expected_n:=1000;
        v_expected_sha:='6c519e110c48d5937e1771909d3806782cc7449ebd00953150547f1f6018b45e';
      WHEN '10K' THEN v_expected_n:=10000;
        v_expected_sha:='4a119559be8b890391a89aacc06bb7951b62f893c10be6ec43ac0dd90a841377';
      WHEN '100K' THEN v_expected_n:=100000;
        v_expected_sha:='a5427ed9245ab9c69fbae2a0154d99a8b7ba5162bb1f8ff8881803ff5637eac7';
      ELSE RAISE EXCEPTION 'D31_UNKNOWN_BATCH';
    END CASE;
    IF r.n<>v_expected_n OR r.invalid_rows<>0 OR r.sha256 IS DISTINCT FROM v_expected_sha
    THEN RAISE EXCEPTION 'D31_BATCH_CONTENT_OR_GENERATOR_PATTERN_DRIFT: %',r.batch; END IF;
  END LOOP;
  IF v_batches<>3 THEN RAISE EXCEPTION 'D31_BATCH_MISSING'; END IF;

  WITH cohort AS MATERIALIZED (
    SELECT id,tenant_id FROM public.account_transactions
    WHERE tenant_id=9000000000001
  )
  SELECT
    (SELECT count(*) FROM public.company_account_movement_operations x
       JOIN cohort c ON x.tenant_id=c.tenant_id AND x.primary_transaction_id=c.id)
   +(SELECT count(*) FROM public.company_account_movement_operations x
       JOIN cohort c ON x.tenant_id=c.tenant_id AND x.counterpart_transaction_id=c.id)
   +(SELECT count(*) FROM public.employee_adjustments x
       JOIN cohort c ON x.disbursement_transaction_id=c.id)
   +(SELECT count(*) FROM public.employee_adjustment_repayments x
       JOIN cohort c ON x.account_transaction_id=c.id)
   +(SELECT count(*) FROM public.powerhub_expense_offline_operation_results x
       JOIN cohort c ON x.transaction_id=c.id)
   +(SELECT count(*) FROM public.supplier_payments x
       JOIN cohort c ON x.tenant_id=c.tenant_id AND x.account_transaction_id=c.id)
   INTO v_external;
  IF v_external<>0 THEN RAISE EXCEPTION 'D31_BUSINESS_SIDE_LINK_ADDED'; END IF;
END $d31$;
ROLLBACK;
SELECT 'D31_STAGING_STRUCTURAL_FINGERPRINT_SCOPED_PASS_PROVENANCE_NOT_CERTIFIED' AS result;