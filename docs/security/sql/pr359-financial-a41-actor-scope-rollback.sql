-- A41 site membership + actor authorization. All mutations ROLLBACK.
BEGIN;
SET LOCAL statement_timeout='65000ms';
DO $qa$
DECLARE msg text; opening_id bigint; v jsonb;
BEGIN
 IF EXISTS(SELECT 1 FROM public.financial_gl_opening_batches WHERE tenant_id=1 AND site_id=1)
 OR EXISTS(SELECT 1 FROM public.financial_gl_entries WHERE tenant_id=1 AND site_id=1)
 OR public.powerhub_financial_gl_authorized_actor(1,1,2) IS DISTINCT FROM false
 OR public.powerhub_financial_gl_authorized_actor(1,1,4) IS DISTINCT FROM true
 OR public.powerhub_financial_gl_authorized_actor(1,1,260) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'A41_SCOPE_INVALID'; END IF;
 BEGIN
  PERFORM public.powerhub_financial_gl_opening_create(1,1,2,'2026-09-30',
    'QA-A41-OUTSIDER','Rollback-only test of unauthorized GL opening',
    'qa-a41-outsider',
    '[{"accountCode":"1010","side":"debit","amount":0.01,"evidenceReference":"QA-A41"},{"accountCode":"3100","side":"credit","amount":0.01,"evidenceReference":"QA-A41"}]'::jsonb);
  RAISE EXCEPTION 'A41_UNAUTHORIZED_CREATE_ACCEPTED';
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
  IF msg<>'GL_OPENING_ACTOR_FORBIDDEN' THEN RAISE EXCEPTION 'A41_CREATE_%',msg; END IF;
 END;
 v:=public.powerhub_financial_gl_opening_create(1,1,4,'2026-09-30',
  'QA-A41-VALID','Rollback-only valid GL opening approval',
  'qa-a41-valid',
  '[{"accountCode":"1010","side":"debit","amount":0.01,"evidenceReference":"QA-A41"},{"accountCode":"3100","side":"credit","amount":0.01,"evidenceReference":"QA-A41"}]'::jsonb);
 opening_id:=(v->>'openingId')::bigint;
 BEGIN
  PERFORM public.powerhub_financial_gl_opening_void(1,1,opening_id,2,'Rollback outsider void');
  RAISE EXCEPTION 'A41_UNAUTHORIZED_VOID_ACCEPTED';
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
  IF msg<>'GL_OPENING_VOID_ACTOR_FORBIDDEN' THEN RAISE EXCEPTION 'A41_VOID_%',msg;END IF;
 END;
 BEGIN
  PERFORM public.powerhub_financial_gl_opening_post(1,1,opening_id,2);
  RAISE EXCEPTION 'A41_UNAUTHORIZED_POST_ACCEPTED';
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
  IF msg<>'GL_OPENING_APPROVER_FORBIDDEN' THEN RAISE EXCEPTION 'A41_POST_%',msg;END IF;
 END;
 BEGIN
  PERFORM public.powerhub_financial_gl_post_source(1,1,'invoice',18,2);
  RAISE EXCEPTION 'A41_UNAUTHORIZED_SOURCE_ACCEPTED';
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
  IF msg<>'GL_SOURCE_ACTOR_FORBIDDEN' THEN RAISE EXCEPTION 'A41_SOURCE_%',msg;END IF;
 END;
 BEGIN
  PERFORM public.powerhub_financial_gl_recognize_billed_service(1,1,18,'2026-10',2);
  RAISE EXCEPTION 'A41_UNAUTHORIZED_RECOGNITION_ACCEPTED';
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
  IF msg<>'GL_SERVICE_ACTOR_FORBIDDEN' THEN RAISE EXCEPTION 'A41_RECOGNITION_%',msg;END IF;
 END;
 UPDATE public.tenant_members SET is_active=false WHERE tenant_id=1 AND user_id=260;
 IF public.powerhub_financial_gl_authorized_actor(1,1,260) IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'A41_REVOKED_ACCEPTED';END IF;
 BEGIN
  PERFORM public.powerhub_financial_gl_opening_post(1,1,opening_id,260);
  RAISE EXCEPTION 'A41_REVOKED_POST_ACCEPTED';
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
  IF msg<>'GL_OPENING_APPROVER_FORBIDDEN' THEN RAISE EXCEPTION 'A41_REVOKED_%',msg;END IF;
 END;
 UPDATE public.tenant_members SET is_active=true,expires_at=statement_timestamp()-interval '1 day'
 WHERE tenant_id=1 AND user_id=260;
 IF public.powerhub_financial_gl_authorized_actor(1,1,260) IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'A41_EXPIRED_ACCEPTED';END IF;
 UPDATE public.tenant_members SET expires_at=NULL WHERE tenant_id=1 AND user_id=260;
 v:=public.powerhub_financial_gl_opening_post(1,1,opening_id,260);
 IF v->>'status'<>'posted' OR (v->>'alreadyPosted')::boolean IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'A41_VALID_APPROVAL_FAILED';END IF;
 v:=public.powerhub_financial_gl_opening_post(1,1,opening_id,260);
 IF (v->>'alreadyPosted')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'A41_VALID_REPLAY_FAILED';END IF;
 BEGIN
  PERFORM public.powerhub_financial_gl_opening_post(1,1,opening_id,2);
  RAISE EXCEPTION 'A41_REPLAY_BYPASS_ACCEPTED';
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
  IF msg<>'GL_OPENING_APPROVER_FORBIDDEN' THEN RAISE EXCEPTION 'A41_REPLAY_%',msg;END IF;
 END;
END;$qa$;
SELECT 'PASS_ROLLBACK_ONLY' status, false unauthorizedActorAccepted;
ROLLBACK;
