-- A29: installed Staging SQL-only custody and independent-review acceptance.
-- DO NOT mistake these synthetic SQL rows for actual bytes in private Storage.
-- Full file-byte validation is implemented by the privileged server route.
-- Always runs BEGIN/ROLLBACK; deliberately does not certify accounting.
BEGIN;
CREATE TEMP TABLE a29_test_results(name text, verdict text) ON COMMIT DROP;
DO $accept$
DECLARE v_open jsonb; v_post jsonb; v_id bigint; l record;
 v_review jsonb; v_status jsonb; denied boolean;
BEGIN
 IF EXISTS (SELECT 1 FROM public.financial_gl_entries WHERE tenant_id=1 AND site_id=1)
 OR EXISTS (SELECT 1 FROM public.financial_gl_opening_batches WHERE tenant_id=1 AND site_id=1 AND status<>'void')
 THEN RAISE EXCEPTION 'A29_TEST_SCOPE_ALREADY_HAS_POSTED_DATA';END IF;
 INSERT INTO auth.users(id,email) VALUES
 ('a2900000-0000-4000-8000-000000000001','stg-a29-maker1@invalid.example'),
 ('a2900000-0000-4000-8000-000000000002','stg-a29-poster@invalid.example'),
 ('a2900000-0000-4000-8000-000000000003','stg-a29-evidence@invalid.example'),
 ('a2900000-0000-4000-8000-000000000004','stg-a29-checker@invalid.example');
 INSERT INTO public.users(id,auth_user_id,name,role) VALUES
 (90000000002901,'a2900000-0000-4000-8000-000000000001','A29 TEST MAKER','user'),
 (90000000002902,'a2900000-0000-4000-8000-000000000002','A29 TEST POSTER','user'),
 (90000000002903,'a2900000-0000-4000-8000-000000000003','A29 TEST EVIDENCE','user'),
 (90000000002904,'a2900000-0000-4000-8000-000000000004','A29 TEST CHECKER','user');
 INSERT INTO public.tenant_members(id,tenant_id,user_id,role,is_active,membership_status)
 VALUES (90000000002901,1,90000000002901,'owner',true,'active'),
 (90000000002902,1,90000000002902,'owner',true,'active'),
 (90000000002903,1,90000000002903,'owner',true,'active'),
 (90000000002904,1,90000000002904,'owner',true,'active');
 v_open:=public.powerhub_financial_gl_opening_create(
   1,1,90000000002901,'2026-01-01',
   'CI-A29-SYNTHETIC-OPENING',
   'A29 synthetic opening for rollback-only database custody test',
   'staging-a29-rollback-opening',
   '[{"accountCode":"1010","side":"debit","amount":35,"evidenceReference":"CI-A29-CASH"},
     {"accountCode":"3100","side":"credit","amount":35,"evidenceReference":"CI-A29-EQUITY"}]'::jsonb);
 v_post:=public.powerhub_financial_gl_opening_post(
   1,1,(v_open->>'openingId')::bigint,90000000002902);
 IF v_post->>'status'<>'posted' THEN RAISE EXCEPTION 'A29_OPENING_NOT_POSTED';END IF;
 FOR l IN SELECT id,side,amount,account_code FROM public.financial_gl_opening_lines
 WHERE opening_id=(v_open->>'openingId')::bigint LOOP
 v_id:=public.powerhub_financial_gl_opening_evidence_submit(
   1,1,(v_open->>'openingId')::bigint,l.id,
   CASE WHEN l.account_code='1010' THEN 'company_account_statement' ELSE 'equity_confirmation' END,
   'CI-A29-STATEMENT-'||l.account_code,repeat('a',64),
   '2026-01-01',l.side,l.amount,90000000002903);
 denied:=false;
 BEGIN
   PERFORM public.powerhub_financial_gl_opening_evidence_review(
     1,1,v_id,90000000002904,true,'A29 independent test review');
 EXCEPTION WHEN SQLSTATE '23514' THEN
   IF SQLERRM='GL_OPENING_DOCUMENT_CUSTODY_REQUIRED' THEN denied:=true;ELSE RAISE;END IF;
 END;
 IF NOT denied THEN RAISE EXCEPTION 'A29_DOCUMENTLESS_APPROVAL_ACCEPTED';END IF;
 denied:=false;
 BEGIN
   INSERT INTO public.financial_gl_opening_document_custody(
     evidence_id,tenant_id,site_id,opening_id,opening_line_id,
     storage_key,document_sha256,mime_type,byte_size,recorded_by_user_id)
   VALUES(v_id,1,1,(v_open->>'openingId')::bigint,l.id,
     'financial-opening-evidence/1/1/'||(v_open->>'openingId')||'/'||l.id||'/'||v_id||'.pdf',
     repeat('b',64),'application/pdf',128,90000000002903);
 EXCEPTION WHEN SQLSTATE '23514' THEN
   IF SQLERRM='GL_OPENING_DOCUMENT_CUSTODY_HASH_MISMATCH' THEN denied:=true;ELSE RAISE;END IF;
 END;
 IF NOT denied THEN RAISE EXCEPTION 'A29_WRONG_SHA_ACCEPTED';END IF;
 INSERT INTO public.financial_gl_opening_document_custody(
   evidence_id,tenant_id,site_id,opening_id,opening_line_id,
   storage_key,document_sha256,mime_type,byte_size,recorded_by_user_id)
 VALUES(v_id,1,1,(v_open->>'openingId')::bigint,l.id,
   'financial-opening-evidence/1/1/'||(v_open->>'openingId')||'/'||l.id||'/'||v_id||'.pdf',
   repeat('a',64),'application/pdf',128,90000000002903);
 denied:=false;
 BEGIN
  PERFORM public.powerhub_financial_gl_opening_evidence_review(
    1,1,v_id,90000000002903,true,'A29 self review must fail');
 EXCEPTION WHEN SQLSTATE '22023' THEN
  IF SQLERRM='GL_OPENING_EVIDENCE_REVIEW_NOT_INDEPENDENT' THEN denied:=true;ELSE RAISE;END IF;
 END;
 IF NOT denied THEN RAISE EXCEPTION 'A29_SELF_REVIEW_ACCEPTED';END IF;
 v_review:=public.powerhub_financial_gl_opening_evidence_review(
   1,1,v_id,90000000002904,true,'A29 independent review test');
 IF v_review->>'status'<>'verified' THEN RAISE EXCEPTION 'A29_VALID_CUSTODY_REVIEW_FAILED';END IF;
 END LOOP;
 v_status:=public.powerhub_financial_gl_opening_evidence_status(1,1,'2026-11');
 IF (v_status->>'allLinesAttested')::boolean IS DISTINCT FROM true
 OR (v_status->>'sourceSubledgersIndependentlyVerified')::boolean IS DISTINCT FROM false
 OR (v_status->>'isIndependentlyReconciled')::boolean IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'A29_FALSE_ACCOUNTING_CERTIFICATION';END IF;
 INSERT INTO a29_test_results VALUES
 ('documentless_review_rejected','PASS'),
 ('mismatched_hash_rejected','PASS'),
 ('self_review_rejected','PASS'),
 ('independent_reviewer_accepted_sql_only','PASS'),
 ('independent_subledger_certification_blocked','PASS');
END;
$accept$;
SELECT * FROM a29_test_results ORDER BY name;
ROLLBACK;