-- B2.1: Staging-only two-distinct-actor maker/checker negative acceptance.
-- Tests SQL authorization, idempotency conflicts and GL nonposting.
-- This is NOT an authenticated-browser E2E test or a real human approval.
BEGIN;
SET LOCAL statement_timeout='115000ms';
DO $qa$
DECLARE v jsonb; pid bigint; denied boolean;
  baseline_gl bigint; baseline_lines bigint; baseline_audit bigint;
  weights jsonb:='[{"siteId":1,"basisPoints":6000},{"siteId":9000000000099,"basisPoints":4000}]'::jsonb;
BEGIN
 IF EXISTS(SELECT 1 FROM public.financial_gl_central_allocation_policies
   WHERE tenant_id=1 AND period='2026-11') THEN
   RAISE EXCEPTION 'B2_1_POLICY_SCOPE_OCCUPIED'; END IF;
 SELECT count(*) INTO baseline_gl FROM public.financial_gl_entries WHERE tenant_id=1;
 SELECT count(*) INTO baseline_lines FROM public.financial_gl_lines WHERE tenant_id=1;
 SELECT count(*) INTO baseline_audit FROM public.audit_logs
   WHERE tenant_id=1 AND action IN ('GL_B2_POLICY_PREPARED','GL_B2_POLICY_APPROVED');
 IF NOT public.powerhub_financial_gl_authorized_actor(1,1,4)
 OR NOT public.powerhub_financial_gl_authorized_actor(1,1,260)
 OR public.powerhub_financial_gl_authorized_actor(1,1,999999999999)
 THEN RAISE EXCEPTION 'B2_1_ACTOR_SCOPE_INVALID'; END IF;

 denied:=false;
 BEGIN
   PERFORM public.powerhub_financial_gl_central_policy_prepare(
     1,1,'2026-11',999999999999,'B2.1 TEST EVIDENCE',
     'b2-1-neg-actor',ARRAY[855]::bigint[],weights);
 EXCEPTION WHEN SQLSTATE '42501' THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'B2_1_UNAUTHORIZED_PREPARE_ACCEPTED';END IF;

 v:=public.powerhub_financial_gl_central_policy_prepare(
   1,1,'2026-11',4,'B2.1 SYNTHETIC SOURCE DOCUMENT',
   'b2-1-stable-operation',ARRAY[855]::bigint[],weights);
 pid:=(v->>'policyId')::bigint;
 IF v->>'status'<>'draft' OR (v->>'pool')::numeric<>85
 OR v->>'accountingCertification'<>'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'B2_1_DRAFT_FAILED'; END IF;
 v:=public.powerhub_financial_gl_central_policy_prepare(
   1,1,'2026-11',4,'B2.1 SYNTHETIC SOURCE DOCUMENT',
   'b2-1-stable-operation',ARRAY[855]::bigint[],weights);
 IF (v->>'alreadyPrepared')::boolean IS DISTINCT FROM true
 OR (v->>'policyId')::bigint<>pid
 THEN RAISE EXCEPTION 'B2_1_IDEMPOTENT_RETRY_FAILED';END IF;

 denied:=false;
 BEGIN
   PERFORM public.powerhub_financial_gl_central_policy_prepare(
     1,1,'2026-11',4,'B2.1 ALTERED DOCUMENT REFERENCE',
     'b2-1-stable-operation',ARRAY[855]::bigint[],weights);
 EXCEPTION WHEN SQLSTATE '23505' THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'B2_1_IDEMPOTENCY_PAYLOAD_DRIFT_ACCEPTED';END IF;

 denied:=false;
 BEGIN
   PERFORM public.powerhub_financial_gl_central_policy_prepare(
     1,1,'2026-11',4,'B2.1 SYNTHETIC SOURCE DOCUMENT',
     'b2-1-replaced-key',ARRAY[855]::bigint[],weights);
 EXCEPTION WHEN SQLSTATE '23505' THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'B2_1_SECOND_POLICY_ACCEPTED';END IF;

 denied:=false;
 BEGIN
   PERFORM public.powerhub_financial_gl_central_policy_approve(1,1,pid,4);
 EXCEPTION WHEN SQLSTATE '23514' THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'B2_1_SELF_APPROVAL_ACCEPTED';END IF;

 denied:=false;
 BEGIN
   PERFORM public.powerhub_financial_gl_central_policy_approve(1,1,pid,999999999999);
 EXCEPTION WHEN SQLSTATE '42501' THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'B2_1_UNAUTHORIZED_APPROVAL_ACCEPTED';END IF;

 IF (public.powerhub_financial_gl_central_policy_preview(1,1,'2026-11',1)->>'status')
    IS DISTINCT FROM 'DRAFT_NOT_APPROVED'
 THEN RAISE EXCEPTION 'B2_1_DRAFT_LEAKED_INTO_REPORT';END IF;
 v:=public.powerhub_financial_gl_central_policy_approve(1,1,pid,260);
 IF v->>'status'<>'approved'
 OR v->>'accountingCertification'<>'NOT_CERTIFIED'
 OR (v->>'alreadyApproved')::boolean IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'B2_1_DISTINCT_REVIEWER_FAILED';END IF;

 denied:=false;
 BEGIN
   PERFORM public.powerhub_financial_gl_central_policy_approve(1,1,pid,4);
 EXCEPTION WHEN SQLSTATE '23514' THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'B2_1_SELF_APPROVAL_REPLAY_ACCEPTED';END IF;

 IF (SELECT count(*) FROM public.financial_gl_central_allocation_policies
    WHERE tenant_id=1 AND period='2026-11' AND status='approved'
      AND prepared_by=4 AND approved_by=260)<>1

 THEN RAISE EXCEPTION 'B2_1_APPROVAL_IDENTITY_INVALID';END IF;

 IF (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>baseline_gl
 OR (SELECT count(*) FROM public.financial_gl_lines WHERE tenant_id=1)<>baseline_lines
 OR (public.powerhub_financial_gl_central_policy_preview(1,1,'2026-11',1)->>'doesNotPostGL')::boolean IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'B2_1_GL_MUTATED_BY_MANAGERIAL_POLICY';END IF;
END;$qa$;
SELECT 'B2_1_TWO_ACTOR_NEGATIVE_PASS_ROLLBACK' result;
ROLLBACK;