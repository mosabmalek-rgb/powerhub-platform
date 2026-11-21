-- A13: align HR payroll approval with source-backed GL maker/checker rules.
-- Prevent approving your own payroll (GL would later reject the source),
-- reject inactive/out-of-tenant approvers, and make identical retries
-- read the same approved state without repeating the audit or changing money.
-- All operations are scoped to tenant/site and serialize by payroll run.
CREATE OR REPLACE FUNCTION public.powerhub_approve_payroll(
 p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_payroll_run_id bigint
) RETURNS TABLE(payroll_run_id bigint)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $approve$
DECLARE
 v_period text;v_status text;v_creator bigint;v_approver bigint;
 v_period_start timestamptz;v_period_end timestamptz;v_role text;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0 OR p_site_id IS NULL OR p_site_id<=0
    OR p_user_id IS NULL OR p_user_id<=0
    OR p_payroll_run_id IS NULL OR p_payroll_run_id<=0 THEN
   RAISE EXCEPTION 'PAYROLL_APPROVAL_INVALID_SCOPE' USING ERRCODE='22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(
   p_tenant_id::text||':payroll-approve:'||p_site_id::text||':'||p_payroll_run_id::text,0));
 SELECT p.period,p.status,p.created_by_user_id,p.approved_by_user_id
 INTO v_period,v_status,v_creator,v_approver
 FROM public.payroll_runs p
 WHERE p.id=p_payroll_run_id AND p.tenant_id=p_tenant_id AND p.site_id=p_site_id
 FOR UPDATE;
 IF NOT FOUND THEN
   RAISE EXCEPTION 'PAYROLL_RUN_OUT_OF_SCOPE' USING ERRCODE='P0001';
 END IF;
 SELECT u.platform_role INTO v_role
 FROM public.users u
 JOIN public.tenant_members m ON m.user_id=u.id
 WHERE u.id=p_user_id AND u.account_status='active'
    AND m.tenant_id=p_tenant_id AND m.is_active
    AND m.membership_status='active'
 LIMIT 1;
 IF NOT FOUND THEN
   RAISE EXCEPTION 'PAYROLL_APPROVER_OUT_OF_TENANT'
     USING ERRCODE='22023';
 END IF;
 IF v_creator=p_user_id THEN
   RAISE EXCEPTION 'PAYROLL_APPROVER_SAME_AS_CREATOR'
     USING ERRCODE='22023';
 END IF;
 -- Network retries return the identical result, with no second audit event.
 -- A different actor cannot silently claim or overwrite an existing approval.
 IF v_status IN ('approved','paid') THEN
   IF v_approver IS DISTINCT FROM p_user_id THEN
     RAISE EXCEPTION 'PAYROLL_APPROVAL_REPLAY_CONFLICT'
       USING ERRCODE='23505';
   END IF;
   RETURN QUERY SELECT p_payroll_run_id;
   RETURN;
 END IF;
 IF v_status<>'draft' THEN
   RAISE EXCEPTION 'PAYROLL_RUN_NOT_DRAFT' USING ERRCODE='P0001';
 END IF;
 v_period_start:=(v_period||'-01')::date;
 v_period_end:=v_period_start+interval '1 month'-interval '1 microsecond';
 IF EXISTS(
   SELECT 1 FROM public.financial_settlements s
   WHERE s.tenant_id=p_tenant_id AND s.site_id=p_site_id
     AND s.status='locked'
     AND s.period_start<=v_period_end AND s.period_end>=v_period_start
 ) THEN
   RAISE EXCEPTION 'FINANCIAL_PERIOD_LOCKED' USING ERRCODE='P0001';
 END IF;
 UPDATE public.payroll_runs
 SET status='approved',approved_by_user_id=p_user_id,updated_at=now()
 WHERE id=p_payroll_run_id AND tenant_id=p_tenant_id AND site_id=p_site_id
   AND status='draft';
 IF NOT FOUND THEN
   RAISE EXCEPTION 'PAYROLL_APPROVAL_CONCURRENT_STATUS_CHANGE'
      USING ERRCODE='23505';
 END IF;
 INSERT INTO public.audit_logs(
   tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data
 ) VALUES(
   p_tenant_id,p_site_id,p_user_id,v_role,'payroll_run',
   p_payroll_run_id::text,'approve',
   jsonb_build_object('period',v_period,'previousStatus',v_status,
     'status','approved','sourceCreatorId',v_creator)
 );
 RETURN QUERY SELECT p_payroll_run_id;
END;
$approve$;
REVOKE ALL ON FUNCTION public.powerhub_approve_payroll(bigint,bigint,bigint,bigint)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_approve_payroll(bigint,bigint,bigint,bigint)
 TO service_role;
NOTIFY pgrst,'reload schema';
