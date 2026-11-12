-- B3.10 real source RPC, 12.3 precision, idempotency, maker/checker and B3.9 GL audit.
-- All site mapping changes and financial operations are rolled back.
BEGIN;
SET LOCAL statement_timeout='120000ms';
DO $qa$
DECLARE source jsonb;retry_source jsonb;posted jsonb;posted_retry jsonb;proof jsonb;
 base_gl bigint; base_lines bigint; maker_blocked boolean:=false;
 draft jsonb;approved jsonb;retry_approval jsonb;denied boolean:=false;
BEGIN
 SELECT count(*) INTO base_gl FROM public.financial_gl_entries WHERE tenant_id=1;
 SELECT count(*) INTO base_lines FROM public.financial_gl_lines WHERE tenant_id=1;
 IF base_gl<>25 OR base_lines<>51 THEN RAISE EXCEPTION 'B310_STAGING_BASELINE_CHANGED'; END IF;
 UPDATE public.company_account_sites SET site_id=9000000000099
 WHERE tenant_id=1 AND account_id=6 AND site_id=1;
 IF NOT FOUND THEN RAISE EXCEPTION 'B310_SOURCE_ACCOUNT_SITE_MAPPING_MISSING'; END IF;
 source:=public.powerhub_transfer_company_accounts_inter_site_idempotent(
  1,1,9000000000099,4,5,6,12.3,'B3.10 real RPC synthetic transfer',
  '16e75825-64ed-4110-bd9c-666f39d6fac8');
 retry_source:=public.powerhub_transfer_company_accounts_inter_site_idempotent(
  1,1,9000000000099,4,5,6,12.3,'B3.10 real RPC synthetic transfer',
  '16e75825-64ed-4110-bd9c-666f39d6fac8');
 IF source->>'alreadyCreated'<>'false' OR retry_source->>'alreadyCreated'<>'true'
 OR source->>'sourceId' IS DISTINCT FROM retry_source->>'sourceId'
 OR source->>'counterpartId' IS DISTINCT FROM retry_source->>'counterpartId'
 THEN RAISE EXCEPTION 'B310_SOURCE_REPLAY_INVALID'; END IF;
 BEGIN
 PERFORM public.powerhub_financial_gl_post_inter_site_source(
   1,1,(source->>'sourceId')::bigint,4);
 EXCEPTION WHEN insufficient_privilege THEN maker_blocked:=true; END;
 IF NOT maker_blocked THEN RAISE EXCEPTION 'B310_MAKER_POSTED_OWN_GL'; END IF;
 posted:=public.powerhub_financial_gl_post_inter_site_source(
  1,1,(source->>'sourceId')::bigint,260);
 posted_retry:=public.powerhub_financial_gl_post_inter_site_source(
  1,1,(source->>'sourceId')::bigint,260);
 draft:=public.powerhub_financial_gl_inter_site_elimination_prepare(
   1,(source->>'sourceId')::bigint,4,
   'B3.11 synthetic elimination document reference','7b42d806-5e7a-47b4-b2aa-ea96566e52ce');
 IF draft->>'status'<>'draft' OR draft->>'alreadyPrepared'<>'false'
 THEN RAISE EXCEPTION 'B311_ELIMINATION_DRAFT_FAILED'; END IF;
 BEGIN
 PERFORM public.powerhub_financial_gl_inter_site_elimination_approve(
  1,(draft->>'eliminationId')::bigint,4);
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'B311_MAKER_SELF_APPROVED'; END IF;
 approved:=public.powerhub_financial_gl_inter_site_elimination_approve(
   1,(draft->>'eliminationId')::bigint,260);
 retry_approval:=public.powerhub_financial_gl_inter_site_elimination_approve(
   1,(draft->>'eliminationId')::bigint,260);
 IF approved->>'status'<>'approved' OR approved->>'alreadyApproved'<>'false'
 OR retry_approval->>'alreadyApproved'<>'true'
 OR (approved->>'amount')::numeric<>12.3
 OR (SELECT count(*) FROM public.financial_gl_inter_site_eliminations
 WHERE tenant_id=1 AND status='approved')<>1
 THEN RAISE EXCEPTION 'B311_ELIMINATION_APPROVAL_INVALID'; END IF;
  proof:=public.powerhub_financial_gl_inter_site_posting_audit(1,'2026-11');
 IF posted->>'alreadyPosted'<>'false'
 OR posted_retry->>'alreadyPosted'<>'true'
 OR posted->>'fromEntryId' IS DISTINCT FROM posted_retry->>'fromEntryId'
 OR posted->>'toEntryId' IS DISTINCT FROM posted_retry->>'toEntryId'
 OR proof->>'status'<>'MATCHED_DUE_FROM_TO_PRELIMINARY_ONLY'
 OR (proof->>'matchedPairCount')::bigint<>1
 OR (proof->>'matchedDueFrom')::numeric<>12.3
 OR (proof->>'matchedDueTo')::numeric<>12.3
 OR proof->>'accountingCertification'<>'NOT_CERTIFIED'
 OR (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>base_gl+2
 OR (SELECT count(*) FROM public.financial_gl_lines WHERE tenant_id=1)<>base_lines+4
 THEN RAISE EXCEPTION 'B310_SOURCE_GL_AUDIT_MISMATCH'; END IF;
END;$qa$;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'B311_INDEPENDENT_ELIMINATION_APPROVAL_PASS_ROLLBACK' result;
ROLLBACK;