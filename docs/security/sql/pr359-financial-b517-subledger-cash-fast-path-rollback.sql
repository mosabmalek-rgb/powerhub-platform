-- Synthetic Staging-only acceptance for B5.17.
-- Run against prelaunch staging after migration 20261112224000; NO permanent writes.
BEGIN;
SET LOCAL statement_timeout='110s';
DO $check$
DECLARE v_period text;v_report jsonb;v_raw_cash numeric;v_raw_wallet numeric;
 v_raw_unknown bigint;v_raw_transfer bigint;v_saved jsonb;v_proof jsonb;
 v_scope bigint;v_site bigint;v_before_gl bigint;v_before_lines bigint;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20261112224000')
 OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.proname='powerhub_financial_gl_subledger_reconciliation'
    AND pg_get_functiondef(p.oid) LIKE '%B5.17:%')
 THEN RAISE EXCEPTION 'B517_VERSION_OR_FUNCTION_MISSING'; END IF;
 SELECT count(*) INTO v_before_gl FROM public.financial_gl_entries WHERE tenant_id=1;
 SELECT count(*) INTO v_before_lines FROM public.financial_gl_lines WHERE tenant_id=1;
 FOR v_period IN SELECT unnest(ARRAY['2026-05','2026-06','2026-07','2026-09','2026-10','2026-11']) LOOP
  v_report:=public.powerhub_financial_gl_subledger_reconciliation(1,1,v_period);
  IF v_report->>'accountingCertification'<>'NOT_CERTIFIED'
   OR v_report->>'tenantId'<>'1' OR v_report->>'siteId'<>'1'
  THEN RAISE EXCEPTION 'B517_WRONG_SCOPE_OR_CERTIFICATION_%',v_period;END IF;
  SELECT
    coalesce(sum(CASE WHEN a.account_type='cash'
      THEN CASE WHEN t.transaction_type IN ('collection','transfer_in') THEN t.amount
      WHEN t.transaction_type IN ('withdrawal','transfer_out') THEN -t.amount ELSE 0 END ELSE 0 END),0),
    coalesce(sum(CASE WHEN a.account_type<>'cash'
      THEN CASE WHEN t.transaction_type IN ('collection','transfer_in') THEN t.amount
      WHEN t.transaction_type IN ('withdrawal','transfer_out') THEN -t.amount ELSE 0 END ELSE 0 END),0),
    count(*) FILTER(WHERE t.transaction_type NOT IN ('collection','withdrawal','transfer_in','transfer_out')),
    count(*) FILTER(WHERE t.transaction_type IN ('transfer_in','transfer_out'))
  INTO v_raw_cash,v_raw_wallet,v_raw_unknown,v_raw_transfer
  FROM public.account_transactions t
  JOIN public.company_accounts a ON a.id=t.account_id AND a.tenant_id=t.tenant_id
  WHERE t.tenant_id=1 AND t.site_id=1
   AND t.occurred_at<(((v_period||'-01')::date+interval '1 month')::timestamp AT TIME ZONE 'Asia/Gaza');
  IF (SELECT (x->>'subledgerBalance')::numeric
      FROM jsonb_array_elements(v_report->'checks') x WHERE x->>'code'='1010') IS DISTINCT FROM v_raw_cash
   OR (SELECT (x->>'subledgerBalance')::numeric
      FROM jsonb_array_elements(v_report->'checks') x WHERE x->>'code'='1020') IS DISTINCT FROM v_raw_wallet
   OR (v_report->'diagnostics'->>'unknownCompanyTransactionTypes')::bigint<>v_raw_unknown
  THEN RAISE EXCEPTION 'B517_RAW_LEDGER_COMPARISON_FAILED_%',v_period; END IF;
  IF v_raw_transfer=0 AND (v_report->'diagnostics'->>'unpostedTransferMovements')::bigint<>0
  THEN RAISE EXCEPTION 'B517_FALSE_UNPOSTED_TRANSFER_%',v_period; END IF;
 END LOOP;
 v_saved:=public.powerhub_financial_gl_subledger_reconciliation(1,1,'2026-11');
 -- Transaction-local trigger interruption MUST force the unoptimized path.
 ALTER TABLE public.account_transactions DISABLE TRIGGER powerhub_financial_gl_fixture_freeze_write;
 v_proof:=public.powerhub_financial_gl_fast_staging_fixture_proof(1,1);
 IF (v_proof->>'verified')::boolean IS NOT FALSE
  OR v_saved::text IS DISTINCT FROM public.powerhub_financial_gl_subledger_reconciliation(1,1,'2026-11')::text
 THEN RAISE EXCEPTION 'B517_DISABLED_FREEZE_FAST_PATH_NOT_REJECTED'; END IF;
 ALTER TABLE public.account_transactions ENABLE TRIGGER powerhub_financial_gl_fixture_freeze_write;
 IF (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>v_before_gl
 OR (SELECT count(*) FROM public.financial_gl_lines WHERE tenant_id=1)<>v_before_lines
 OR has_function_privilege('anon','public.powerhub_financial_gl_subledger_reconciliation(bigint,bigint,text)','EXECUTE')
 OR has_function_privilege('authenticated','public.powerhub_financial_gl_subledger_reconciliation(bigint,bigint,text)','EXECUTE')
 THEN RAISE EXCEPTION 'B517_GL_CHANGED_OR_BROWSER_FUNCTION_EXPOSED'; END IF;
END;$check$;
SELECT 'B517_STAGING_FULL_RAW_MATCH_AND_PROOF_FAILURE_PASS_ROLLBACK' AS result;
ROLLBACK;
