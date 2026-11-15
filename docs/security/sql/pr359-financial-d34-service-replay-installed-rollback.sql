-- D34 installed Staging behavioral verification, only writes within rollback.
-- Do not mark expiry-path runtime-tested: immutable bootstrap prevents clock simulation.
BEGIN;
SET LOCAL statement_timeout='60000ms';
DO $check$
DECLARE j jsonb; err text; o jsonb;
BEGIN
 j:=public.powerhub_financial_gl_recognize_billed_service(1,1,31,'2026-10',4);
 IF j->>'alreadyPosted' IS DISTINCT FROM 'true'
 OR (j->>'entryId')::bigint<>867
 OR (j->>'amountMinor')::bigint<>247150
 OR j->>'accountingCertification'<>'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'D34_REPLAY_FAILED: %',j; END IF;
 BEGIN
  PERFORM public.powerhub_financial_gl_recognize_billed_service(1,1,31,'2026-09',4);
  RAISE EXCEPTION 'D34_WRONG_MONTH_NOT_REJECTED';
 EXCEPTION WHEN SQLSTATE '22023' THEN
  GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
  IF err NOT IN ('GL_SERVICE_MONTH_OUTSIDE_CYCLE','GL_SERVICE_OPENING_REQUIRED')
  THEN RAISE EXCEPTION 'D34_WRONG_MONTH_ERROR: %',err; END IF;
 END;
 IF (SELECT count(*) FROM public.financial_gl_entries)<>25
 OR (SELECT count(*) FROM public.financial_gl_lines)<>51
 OR (SELECT count(*) FROM public.account_transactions)<>361009
 THEN RAISE EXCEPTION 'D34_BASELINE_DRIFT'; END IF;
 IF NOT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE
  version='20261115190409' AND name='powerhub_financial_d34_service_replay_after_prelaunch_expiry') THEN
   RAISE EXCEPTION 'D34_INSTALL_NOT_REGISTERED'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.powerhub_financial_gl_recognize_billed_service(bigint,bigint,bigint,text,bigint)'::regprocedure AND p.prosecdef)
 OR has_function_privilege('anon','public.powerhub_financial_gl_recognize_billed_service(bigint,bigint,bigint,text,bigint)','EXECUTE')
 OR has_function_privilege('authenticated','public.powerhub_financial_gl_recognize_billed_service(bigint,bigint,bigint,text,bigint)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.powerhub_financial_gl_recognize_billed_service(bigint,bigint,bigint,text,bigint)','EXECUTE')
 THEN RAISE EXCEPTION 'D34_RPC_ACL_DRIFT';END IF;
 IF (SELECT count(*) FROM public.financial_gl_entries e
 WHERE e.id=890 AND e.reverses_entry_id=168 AND e.source_type='correction')<>1
 THEN RAISE EXCEPTION 'D34_OPENING_REVERSAL_NOT_PROVEN'; END IF;
 o:=public.powerhub_financial_gl_opening_evidence_status(1,9000000000099,'2026-11');
 IF o->>'status'<>'EVIDENCE_MISSING_OR_UNREVIEWED'
 OR o->>'isIndependentlyReconciled'<>'false' THEN
 RAISE EXCEPTION 'D34_OPENING_EVIDENCE_FALSELY_APPROVED: %',o; END IF;
END $check$;
ROLLBACK;
SELECT 'D34_INSTALLED_SERVICE_REPLAY_CUTOFF_ACL_ROLLBACK_PASS' result;
