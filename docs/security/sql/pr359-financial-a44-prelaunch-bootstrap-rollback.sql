-- A44: run AFTER applying the migration, on Staging only.
-- It verifies 18 operational entries + 3 earned-service recognitions.
-- No permanent rows, no fake human attestation, no Production writes.
BEGIN;
SET LOCAL statement_timeout='120000ms';
DO $qa$ DECLARE err text;
BEGIN
 IF EXISTS(SELECT 1 FROM public.financial_gl_entries WHERE tenant_id=1 AND site_id=1)
  OR EXISTS(SELECT 1 FROM public.financial_gl_opening_batches WHERE tenant_id=1 AND site_id=1)
  OR EXISTS(SELECT 1 FROM public.financial_gl_prelaunch_technical_bootstrap WHERE tenant_id=1 AND site_id=1)
 THEN RAISE EXCEPTION 'A44_NOT_FRESH_PRELAUNCH_SCOPE'; END IF;
 BEGIN
  PERFORM public.powerhub_financial_gl_post_source(1,1,'invoice',18,4);
  RAISE EXCEPTION 'A44_NO_BOOTSTRAP_ALLOWED';
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
  IF err<>'GL_DOCUMENTED_OPENING_REQUIRED'
  THEN RAISE EXCEPTION 'A44_UNEXPECTED_%',err; END IF;
 END;
END;$qa$;
INSERT INTO public.financial_gl_prelaunch_technical_bootstrap
(tenant_id,site_id,as_of_date,cohort_key,manifest_sha256,fixture_row_count,expires_at)
VALUES(1,1,'2026-09-30','STG-PERF-20261105',
'f1b25e8562328a0f6e916beb4d54b2ee88366e78b4459c5d0ebc444616997df9',
250000,'2026-11-30T23:59:00+02');
DO $batch$ DECLARE v jsonb;item record;counter integer:=0;
BEGIN
 IF public.powerhub_financial_gl_prelaunch_tech_valid(1,1,'2026-11') IS DISTINCT FROM true
 OR public.powerhub_financial_gl_prelaunch_tech_valid(1,2,'2026-11') IS DISTINCT FROM false
 OR public.powerhub_financial_gl_prelaunch_tech_valid(2,1,'2026-11') IS DISTINCT FROM false
 OR public.powerhub_financial_gl_prelaunch_tech_valid(1,1,'2026-09') IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'A44_BOOTSTRAP_SCOPE_BYPASS'; END IF;
 FOR item IN SELECT * FROM (VALUES 
 ('invoice'::text,18::bigint,1),('invoice',19,2),('invoice',31,3),('invoice',32,4),
 ('supplier_ledger',16,5),('supplier_ledger',19,6),('supplier_ledger',17,7),
 ('payroll',1,8),('expense',1,9),('supplier_ledger',18,10),
 ('supplier_ledger',20,11),('stock_movement',25,12),
 ('payment',2,13),('payment',3,14),('payment',4,15),
 ('payment',5,16),('payment',7,17),('payment',8,18)
 ) desired(source_type,source_id,sort_order) ORDER BY sort_order LOOP
  v:=public.powerhub_financial_gl_post_source(1,1,item.source_type,item.source_id,4);
  IF v->>'status'<>'posted' OR v->>'postingMode'<>'PRELAUNCH_TECHNICAL'
   OR (v->>'alreadyPosted')::boolean IS DISTINCT FROM false
  THEN RAISE EXCEPTION 'A44_POST_FAIL_%,%',item.source_type,item.source_id;END IF;
  v:=public.powerhub_financial_gl_post_source(1,1,item.source_type,item.source_id,4);
  IF (v->>'alreadyPosted')::boolean IS DISTINCT FROM true
  THEN RAISE EXCEPTION 'A44_REPLAY_FAIL_%',item.source_id;END IF;
  counter:=counter+1;
 END LOOP;
 IF counter<>18 THEN RAISE EXCEPTION 'A44_BAD_SOURCE_COUNT';END IF;
 FOR item IN SELECT * FROM (VALUES (18::bigint),(19::bigint),(31::bigint)) q(invoice_id) LOOP
  v:=public.powerhub_financial_gl_recognize_billed_service(1,1,item.invoice_id,'2026-10',4);
  IF v->>'status'<>'posted' OR (v->>'alreadyPosted')::boolean IS DISTINCT FROM false
  THEN RAISE EXCEPTION 'A44_SERVICE_FAIL_%',item.invoice_id;END IF;
  v:=public.powerhub_financial_gl_recognize_billed_service(1,1,item.invoice_id,'2026-10',4);
  IF (v->>'alreadyPosted')::boolean IS DISTINCT FROM true
  THEN RAISE EXCEPTION 'A44_SERVICE_REPLAY_FAIL_%',item.invoice_id;END IF;
 END LOOP;
 IF (public.powerhub_financial_gl_source_coverage(1,1,'2026-11')->>'unreconciledSourceCount')::bigint<>0
 OR (public.powerhub_financial_gl_trial_balance(1,1,'2026-11')->>'difference')::numeric<>0
 OR (public.powerhub_financial_gl_source_integrity(1,1,'2026-11')->>'isClean')::boolean IS DISTINCT FROM true
 OR (public.powerhub_financial_gl_source_coverage(1,1,'2026-11')->>'accountingCertification')<>'NOT_CERTIFIED'
 OR (public.powerhub_financial_gl_source_coverage(1,1,'2026-11')->>'isOpeningReconciled')::boolean IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'A44_ENGINEERING_NOT_CLEAN';END IF;
END;$batch$;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT jsonb_build_object('status','ENGINEERING_PASS_ROLLBACK_ONLY',
 'postedGL',(SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1 AND site_id=1),
 'missingSources',(public.powerhub_financial_gl_source_coverage(1,1,'2026-11')->>'unreconciledSourceCount')::bigint,
 'balanceDifference',(public.powerhub_financial_gl_trial_balance(1,1,'2026-11')->>'difference')::numeric,
 'financialCertification',public.powerhub_financial_gl_source_coverage(1,1,'2026-11')->>'accountingCertification') AS a44;
ROLLBACK;
