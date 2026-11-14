\set ON_ERROR_STOP on
DO $verify$
DECLARE n int;sessions int;first_posts int;replays int;approved int;audits int;violation int;
BEGIN
 IF current_database()<>'powerhub_b5_synthetic_payroll_test' THEN
   RAISE EXCEPTION 'B5_PAYROLL_NOT_DISPOSABLE_DB'; END IF;
 SELECT count(*),count(DISTINCT backend_pid),count(*) FILTER (WHERE NOT replay),
   count(*) FILTER (WHERE replay)
 INTO n,sessions,first_posts,replays FROM public.b5_payroll_samples;
 IF n<>404 OR sessions<4 OR first_posts<>400 OR replays<>4
 THEN RAISE EXCEPTION 'B5_PAYROLL_SAMPLE_COUNTS_FAILED n=% sessions=% first=% replays=%',
   n,sessions,first_posts,replays; END IF;
 SELECT count(*) INTO approved FROM public.payroll_runs
 WHERE tenant_id=901 AND site_id=9101 AND status='approved'
 AND created_by_user_id=9901 AND approved_by_user_id=9902;
 SELECT count(*) INTO audits FROM public.audit_logs
 WHERE tenant_id=901 AND site_id=9101 AND action='approve' AND entity_type='payroll_run';
 IF approved<>400 OR audits<>400 THEN
   RAISE EXCEPTION 'B5_PAYROLL_APPROVAL_OR_AUDIT_NOT_EXACTLY_ONCE % %',approved,audits; END IF;
 SELECT count(*) INTO violation FROM
 (SELECT entity_id FROM public.audit_logs WHERE tenant_id=901 AND action='approve'
 GROUP BY entity_id HAVING count(*)<>1) t;
 IF violation<>0 THEN RAISE EXCEPTION 'B5_PAYROLL_DUPLICATE_APPROVAL_AUDIT'; END IF;

 -- Fault injection MUST fail closed, without changing any persisted approval or audit.
 BEGIN
   PERFORM public.powerhub_approve_payroll(901,9101,9901,10002);
   RAISE EXCEPTION 'B5_PAYROLL_SELF_APPROVAL_ACCEPTED' USING ERRCODE='XX000';
 EXCEPTION WHEN SQLSTATE '22023' THEN
   IF SQLERRM<>'PAYROLL_APPROVER_SAME_AS_CREATOR' THEN RAISE; END IF;
 END;
 BEGIN
   PERFORM public.powerhub_approve_payroll(901,9101,9910,10002);
   RAISE EXCEPTION 'B5_PAYROLL_FOREIGN_APPROVER_ACCEPTED' USING ERRCODE='XX000';
 EXCEPTION WHEN SQLSTATE '22023' THEN
   IF SQLERRM<>'PAYROLL_APPROVER_OUT_OF_TENANT' THEN RAISE; END IF;
 END;
 BEGIN
   PERFORM public.powerhub_approve_payroll(901,9101,9903,10002);
   RAISE EXCEPTION 'B5_PAYROLL_FORGED_REPLAY_ACCEPTED' USING ERRCODE='XX000';
 EXCEPTION WHEN SQLSTATE '23505' THEN
   IF SQLERRM<>'PAYROLL_APPROVAL_REPLAY_CONFLICT' THEN RAISE; END IF;
 END;
 BEGIN
   PERFORM public.powerhub_approve_payroll(901,9102,9902,10002);
   RAISE EXCEPTION 'B5_PAYROLL_WRONG_SITE_ACCEPTED' USING ERRCODE='XX000';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
   IF SQLERRM<>'PAYROLL_RUN_OUT_OF_SCOPE' THEN RAISE; END IF;
 END;
 IF (SELECT count(*) FROM public.audit_logs WHERE action='approve' AND tenant_id=901)<>400
 THEN RAISE EXCEPTION 'B5_PAYROLL_REJECTED_REQUEST_WROTE_AUDIT'; END IF;
 IF has_function_privilege('anon','public.powerhub_approve_payroll(bigint,bigint,bigint,bigint)','EXECUTE')
  OR has_function_privilege('authenticated','public.powerhub_approve_payroll(bigint,bigint,bigint,bigint)','EXECUTE')
 THEN RAISE EXCEPTION 'B5_PAYROLL_BROWSER_RPC_GRANT'; END IF;
END $verify$;
SELECT count(*) request_count, round(percentile_cont(.5) WITHIN GROUP(ORDER BY elapsed_ms)::numeric,2) p50_ms,
 round(percentile_cont(.95) WITHIN GROUP(ORDER BY elapsed_ms)::numeric,2) sample_p95_ms,
 round(percentile_cont(.99) WITHIN GROUP(ORDER BY elapsed_ms)::numeric,2) sample_p99_ms,
 max(elapsed_ms) maximum_ms
FROM public.b5_payroll_samples;
SELECT 'B5_PAYROLL_400_FIRST_4_REPLAYS_FOUR_SESSIONS_MAKER_CHECKER_PASS' AS result;
