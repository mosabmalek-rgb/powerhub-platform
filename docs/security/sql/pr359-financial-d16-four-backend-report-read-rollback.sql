-- D16 Staging-only, scoped concurrent report read-worker.
-- Orchestrate FOUR independent SQL sessions externally using this exact file.
-- Verify backend PID uniqueness AND actual firstStart/lastFinish interval overlap;
-- passing four separate invocations alone is NOT proof of concurrency.
-- Bounded diagnostic: three repeats per procedure (36 calls across four sessions),
-- NOT representative p95/p99 or financial certification.
-- No financial writes or migrations; all local temp results disappear at ROLLBACK.
BEGIN;
SET LOCAL statement_timeout = '90000ms';
SET LOCAL lock_timeout = '8000ms';
CREATE TEMP TABLE d16_report_measurements(
  operation text NOT NULL,
  iteration integer NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  elapsed_ms numeric NOT NULL,
  result_digest text NOT NULL,
  status text NOT NULL,
  PRIMARY KEY(operation,iteration)
) ON COMMIT DROP;
DO $d16$
DECLARE
  iteration integer;
  result jsonb;
  started timestamptz;
  finished timestamptz;
  base_entries bigint;
  base_lines bigint;
  base_movements bigint;
BEGIN
  IF current_database() IS NULL OR
     to_regclass('public.financial_gl_entries') IS NULL OR
     to_regclass('public.financial_gl_lines') IS NULL
  THEN RAISE EXCEPTION 'D16_FINANCIAL_STAGING_SCHEMA_REQUIRED'; END IF;
  SELECT count(*) INTO base_entries FROM public.financial_gl_entries;
  SELECT count(*) INTO base_lines FROM public.financial_gl_lines;
  SELECT count(*) INTO base_movements FROM public.account_transactions;
  IF base_entries<>25 OR base_lines<>51 OR base_movements<>361009
  THEN RAISE EXCEPTION 'D16_TEST_BASELINE_CHANGED e=% l=% a=%',
    base_entries,base_lines,base_movements; END IF;
  -- Allow the orchestrator to launch the other SQL sessions concurrently.
  PERFORM pg_sleep(1.5);
  FOR iteration IN 1..3 LOOP
    started:=clock_timestamp();
    result:=public.powerhub_financial_gl_company_movement_audit(1,1,'2026-11');
    finished:=clock_timestamp();
    IF result->>'status' IS DISTINCT FROM 'LINKED_ACCOUNT_MOVEMENTS_MATCH_NOT_CERTIFIED'
      OR result->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
      OR (result->>'mismatchCount')::bigint<>0
      OR (result->>'aggregateUnresolvedCount')::bigint<>0
    THEN RAISE EXCEPTION 'D16_CASH_REPORT_MISMATCH';END IF;
    INSERT INTO d16_report_measurements VALUES
      ('company_movement_audit',iteration,started,finished,
       round(extract(epoch FROM finished-started)::numeric*1000,3),
       md5(result::text),result->>'status');

    started:=clock_timestamp();
    result:=public.powerhub_financial_gl_subledger_reconciliation(1,1,'2026-11');
    finished:=clock_timestamp();
    IF result->>'status' IS DISTINCT FROM 'MATCHED_NUMERICALLY_NOT_CERTIFIED'
      OR result->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
      OR result->>'isMathematicallyMatched' IS DISTINCT FROM 'true'
      OR (result->>'differenceCount')::bigint<>0
      OR (result->>'unresolvedCount')::bigint<>0
    THEN RAISE EXCEPTION 'D16_SUBLEDGER_MISMATCH';END IF;
    INSERT INTO d16_report_measurements VALUES
      ('subledger_reconciliation',iteration,started,finished,
       round(extract(epoch FROM finished-started)::numeric*1000,3),
       md5(result::text),result->>'status');

    started:=clock_timestamp();
    result:=public.powerhub_financial_gl_source_integrity(1,1,'2026-11');
    finished:=clock_timestamp();
    IF result->>'isClean' IS DISTINCT FROM 'true'
      OR (result->>'driftedEntries')::bigint<>0
      OR (result->>'invalidSources')::bigint<>0
      OR (result->>'unauditedEntries')::bigint<>0
    THEN RAISE EXCEPTION 'D16_GL_SOURCE_INTEGRITY_MISMATCH';END IF;
    INSERT INTO d16_report_measurements VALUES
      ('source_integrity',iteration,started,finished,
       round(extract(epoch FROM finished-started)::numeric*1000,3),
       md5(result::text),'SOURCE_CLEAN_NOT_CERTIFIED');
  END LOOP;
  IF (SELECT count(*) FROM public.financial_gl_entries)<>base_entries
     OR (SELECT count(*) FROM public.financial_gl_lines)<>base_lines
     OR (SELECT count(*) FROM public.account_transactions)<>base_movements
  THEN RAISE EXCEPTION 'D16_GL_OR_CASH_BASELINE_CHANGED';END IF;
END $d16$;
DO $proof$
BEGIN
 IF (SELECT count(*) FROM d16_report_measurements)<>9 OR EXISTS(
   SELECT 1 FROM d16_report_measurements
   GROUP BY operation
   HAVING count(*)<>3 OR count(DISTINCT result_digest)<>1 OR
      count(DISTINCT status)<>1)
 THEN RAISE EXCEPTION 'D16_INTRA_WORKER_RESULT_DRIFT';END IF;
END $proof$;
SELECT jsonb_build_object(
  'backendPid',pg_backend_pid(),
  'firstStart',(SELECT min(started_at) FROM d16_report_measurements),
  'lastFinish',(SELECT max(finished_at) FROM d16_report_measurements),
  'operations',(SELECT jsonb_agg(jsonb_build_object(
    'operation',operation,'samples',samples,'p50ms',p50,'sampleP95ms',p95,
    'sampleP99ms',p99,'maximumMs',max_ms,'digest',digest,'status',status)
    ORDER BY operation)
    FROM (SELECT operation,count(*) samples,
      round(percentile_cont(.5) WITHIN GROUP(ORDER BY elapsed_ms)::numeric,2) p50,
      round(percentile_cont(.95) WITHIN GROUP(ORDER BY elapsed_ms)::numeric,2) p95,
      round(percentile_cont(.99) WITHIN GROUP(ORDER BY elapsed_ms)::numeric,2) p99,
      round(max(elapsed_ms),2) max_ms,
      min(result_digest) digest,min(status) status
      FROM d16_report_measurements GROUP BY operation) q),
  'acceptance','D16_STAGING_SQL_READ_ONLY_EFFECTS_ROLLBACK_WORKER_PASS',
  'accountingCertification','NOT_CERTIFIED'
) AS result;
ROLLBACK;