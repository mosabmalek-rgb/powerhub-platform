-- A24 installed Staging, rollback-only chain, never a certified opening.
BEGIN;
CREATE TEMP TABLE a24_results(seq int GENERATED ALWAYS AS IDENTITY,source_type text,source_id bigint,period text,state text,entry_id bigint) ON COMMIT DROP;
DO $test$
DECLARE op jsonb;first_post jsonb;repeat_post jsonb;source record;trial jsonb;blocked boolean;
BEGIN
 IF EXISTS(SELECT 1 FROM public.financial_gl_entries WHERE tenant_id=1 AND site_id=1)
 OR EXISTS(SELECT 1 FROM public.financial_gl_opening_batches WHERE tenant_id=1 AND site_id=1 AND status<>'void')
 THEN RAISE EXCEPTION 'A24_SOURCE_SITE_ALREADY_POSTED';END IF;
 INSERT INTO auth.users(id,email) VALUES
 ('a2400000-0000-4000-8000-000000000001','stg-a24-maker@invalid.example'),
 ('a2400000-0000-4000-8000-000000000002','stg-a24-reviewer@invalid.example');
 INSERT INTO public.users(id,auth_user_id,name,role) VALUES
 (90000000002001,'a2400000-0000-4000-8000-000000000001','A24 TEMP MAKER','user'),
 (90000000002002,'a2400000-0000-4000-8000-000000000002','A24 TEMP REVIEWER','user');
 INSERT INTO public.tenant_members(id,tenant_id,user_id,role,is_active,membership_status)
 VALUES (90000000002001,1,90000000002001,'owner',true,'active'),
 (90000000002002,1,90000000002002,'owner',true,'active');
 op:=public.powerhub_financial_gl_opening_create(1,1,90000000002001,'2026-01-01',
 'STG-A24-TEST-NOT-CERTIFIED','A24 synthetic opening for rollback-only source chain',
 'stg-a24-rollback-opening-1-1',
 '[{"accountCode":"1010","side":"debit","amount":200000,"evidenceReference":"STG-A24-TEST"},
   {"accountCode":"1300","side":"debit","amount":10000,"evidenceReference":"STG-A24-TEST"},
   {"accountCode":"1700","side":"debit","amount":10000,"evidenceReference":"STG-A24-TEST"},
   {"accountCode":"3100","side":"credit","amount":220000,"evidenceReference":"STG-A24-TEST"}]'::jsonb);
 first_post:=public.powerhub_financial_gl_opening_post(1,1,(op->>'openingId')::bigint,90000000002002);
 IF first_post->>'status'<>'posted' THEN RAISE EXCEPTION 'A24_OPENING_POST_FAILED';END IF;
 INSERT INTO a24_results(source_type,source_id,period,state,entry_id)
 VALUES('opening_balance',(op->>'openingId')::bigint,'2026-01','POSTED_SYNTHETIC_ROLLBACK_ONLY',(first_post->>'entryId')::bigint);
 FOR source IN SELECT * FROM (VALUES
 ('invoice'::text,18::bigint),('invoice',19),('invoice',31),('invoice',32),
 ('supplier_ledger',16),('supplier_ledger',19),('supplier_ledger',17),
 ('supplier_ledger',18),('supplier_ledger',20),
 ('payment',2),('payment',3),('payment',4),('payment',5),('payment',7),('payment',8),
 ('expense',1),('stock_movement',25),('payroll',1)
 ) s(kind,id) LOOP
 first_post:=public.powerhub_financial_gl_post_source(1,1,source.kind,source.id,90000000002001);
 repeat_post:=public.powerhub_financial_gl_post_source(1,1,source.kind,source.id,90000000002001);
 IF first_post->>'status'<>'posted' OR (first_post->>'alreadyPosted')::boolean
 OR (repeat_post->>'alreadyPosted')::boolean IS DISTINCT FROM true
 OR first_post->>'entryId' IS DISTINCT FROM repeat_post->>'entryId'
 THEN RAISE EXCEPTION 'A24_DUPLICATE_SOURCE_POST';END IF;
 INSERT INTO a24_results(source_type,source_id,period,state,entry_id)
 VALUES(source.kind,source.id,NULL,'POSTED_IDEMPOTENT_ROLLBACK_ONLY',(first_post->>'entryId')::bigint);
 END LOOP;
 -- All three invoices start on October 1 in the Asia/Gaza calendar.
 FOR source IN SELECT * FROM (VALUES (18::bigint,'2026-10'::text),
 (19::bigint,'2026-10'),(31::bigint,'2026-10')) s(id,month) LOOP
 first_post:=public.powerhub_financial_gl_recognize_billed_service(1,1,source.id,source.month,90000000002001);
 repeat_post:=public.powerhub_financial_gl_recognize_billed_service(1,1,source.id,source.month,90000000002001);
 IF first_post->>'status'<>'posted' OR (first_post->>'alreadyPosted')::boolean
 OR (repeat_post->>'alreadyPosted')::boolean IS DISTINCT FROM true
 OR first_post->>'entryId' IS DISTINCT FROM repeat_post->>'entryId'
 THEN RAISE EXCEPTION 'A24_SERVICE_REPLAY_INVALID';END IF;
 INSERT INTO a24_results(source_type,source_id,period,state,entry_id)
 VALUES('service_recognition',source.id,source.month,'POSTED_IDEMPOTENT_ROLLBACK_ONLY',(first_post->>'entryId')::bigint);
 END LOOP;
 blocked:=false;
 BEGIN
 PERFORM public.powerhub_financial_gl_recognize_billed_service(1,1,18,'2026-09',90000000002001);
 EXCEPTION WHEN SQLSTATE '22023' THEN
   IF SQLERRM='GL_SERVICE_MONTH_OUTSIDE_CYCLE' THEN blocked:=true; ELSE RAISE; END IF;
 END;
 IF NOT blocked THEN RAISE EXCEPTION 'A24_OUT_OF_CYCLE_RECOGNITION_ACCEPTED';END IF;
 blocked:=false;
 BEGIN
 PERFORM public.powerhub_financial_gl_recognize_billed_service(1,1,32,'2026-11',90000000002001);
 EXCEPTION WHEN SQLSTATE '22023' THEN
   IF SQLERRM='GL_SERVICE_MONTH_NOT_COMPLETED' THEN blocked:=true; ELSE RAISE;END IF;
 END;
 IF NOT blocked THEN RAISE EXCEPTION 'A24_INCOMPLETE_SERVICE_MONTH_ACCEPTED';END IF;
 trial:=public.powerhub_financial_gl_trial_balance(1,1,'2026-11');
 IF (trial->>'difference')::numeric<>0 OR trial->>'accountingCertification'<>'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'A24_FALSE_ACCOUNTING_CERTIFICATION_OR_TRIAL_DRIFT';END IF;
 INSERT INTO a24_results(source_type,source_id,state)
 VALUES('trial_balance',1,'BALANCED_NOT_CERTIFIED');
END;
$test$;
SELECT source_type,source_id,period,state,entry_id FROM a24_results ORDER BY seq;
ROLLBACK;