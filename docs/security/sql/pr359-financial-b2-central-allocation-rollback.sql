-- B2 acceptance: test-only policies, actor checks, isolation, no GL mutation.
BEGIN;SET LOCAL statement_timeout='115000ms';
DO $qa$ DECLARE r jsonb;pid bigint;central jsonb;other jsonb;
BEGIN
 IF EXISTS(SELECT 1 FROM public.financial_gl_central_allocation_policies WHERE tenant_id=1 AND period='2026-11')
 THEN RAISE EXCEPTION 'B2_TEST_SCOPE_OCCUPIED';END IF;
 r:=public.powerhub_financial_gl_central_policy_preview(1,1,'2026-11',1);
 IF r->>'status'<>'NOT_CONFIGURED' OR r->'allocatedCost'<>'null'::jsonb
 THEN RAISE EXCEPTION 'B2_UNCONFIGURED_MUST_BE_NULL';END IF;
 BEGIN PERFORM public.powerhub_financial_gl_central_policy_prepare(1,1,'2026-11',4,
  'QA-B2-FINANCE','qa-b2-test-key-01',ARRAY[855]::bigint[],
  '[{"siteId":1,"basisPoints":7000},{"siteId":9000000000099,"basisPoints":2000}]'::jsonb);
  RAISE EXCEPTION 'B2_BAD_WEIGHTS_ACCEPTED';
 EXCEPTION WHEN SQLSTATE '23514' THEN NULL;END;
 r:=public.powerhub_financial_gl_central_policy_prepare(1,1,'2026-11',4,
 'QA-B2-FINANCE','qa-b2-test-key-01',ARRAY[855]::bigint[],
 '[{"siteId":1,"basisPoints":6000},{"siteId":9000000000099,"basisPoints":4000}]'::jsonb);
 pid:=(r->>'policyId')::bigint;
 IF r->>'status'<>'draft' THEN RAISE EXCEPTION 'B2_DRAFT_INVALID';END IF;
 r:=public.powerhub_financial_gl_central_policy_prepare(1,1,'2026-11',4,
 'QA-B2-FINANCE','qa-b2-test-key-01',ARRAY[855]::bigint[],
 '[{"siteId":1,"basisPoints":6000},{"siteId":9000000000099,"basisPoints":4000}]'::jsonb);
 IF (r->>'alreadyPrepared')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'B2_NOT_IDEMPOTENT';END IF;
 IF (public.powerhub_financial_gl_central_policy_preview(1,1,'2026-11',1)->>'status')<>'DRAFT_NOT_APPROVED'
 THEN RAISE EXCEPTION 'B2_DRAFT_VISIBLE';END IF;
 BEGIN PERFORM public.powerhub_financial_gl_central_policy_approve(1,1,pid,4);
 RAISE EXCEPTION 'B2_SELF_APPROVED';EXCEPTION WHEN SQLSTATE '23514' THEN NULL;END;
 r:=public.powerhub_financial_gl_central_policy_approve(1,1,pid,260);
 IF r->>'status'<>'approved' THEN RAISE EXCEPTION 'B2_APPROVAL_FAILED';END IF;
 r:=public.powerhub_financial_gl_central_policy_approve(1,1,pid,260);
 IF (r->>'alreadyApproved')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'B2_APPROVAL_REPLAY';END IF;
 BEGIN UPDATE public.financial_gl_central_allocation_policies pol SET weights='[]'::jsonb WHERE pol.id=pid;
 RAISE EXCEPTION 'B2_EDIT_ALLOWED';EXCEPTION WHEN SQLSTATE '23514' THEN NULL;END;
 central:=public.powerhub_financial_gl_central_policy_preview(1,1,'2026-11',1);
 other:=public.powerhub_financial_gl_central_policy_preview(1,9000000000099,'2026-11',1);
 IF (central->>'pool')::numeric<>85 OR (central->>'allocatedCost')::numeric<>51
 OR (other->>'allocatedCost')::numeric<>34 OR (central->>'managerialResult')::numeric<>-86
 OR (other->>'managerialResult')::numeric<>-34
 OR (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>24
 THEN RAISE EXCEPTION 'B2_MATH_OR_LEDGER_MISMATCH';END IF;
 BEGIN PERFORM public.powerhub_financial_gl_central_policy_preview(9000000000001,1,'2026-11',1);
 RAISE EXCEPTION 'B2_TENANT_BYPASS';EXCEPTION WHEN SQLSTATE '22023' THEN NULL;END;
 IF EXISTS(SELECT 1 FROM pg_proc f WHERE f.pronamespace='public'::regnamespace AND
 f.proname IN ('powerhub_financial_gl_central_policy_prepare','powerhub_financial_gl_central_policy_approve',
 'powerhub_financial_gl_central_policy_preview') AND
 (has_function_privilege('anon',f.oid,'EXECUTE') OR has_function_privilege('authenticated',f.oid,'EXECUTE')))
 THEN RAISE EXCEPTION 'B2_PUBLIC_EXECUTE';END IF;
END;$qa$;
SELECT 'B2_PASS_ROLLBACK_ONLY' AS result;
ROLLBACK;