-- B5.7 repeatable, read-only Staging worker for short concurrent GL read sampling.
-- Run this exact SQL in 4 concurrent Staging sessions (or more, based on test plan).
-- Five samples per procedure are a smoke test, NOT a reliable population p95/p99.
-- Do not mistake stable digests within a worker for authenticated browser approval.
BEGIN;
SET LOCAL statement_timeout = '90000ms';
CREATE TEMP TABLE b57_measurements (
  operation text NOT NULL, elapsed_ms numeric NOT NULL,
  result_digest text NOT NULL, certification text
) ON COMMIT DROP;
DO $b57$
DECLARE v jsonb;start_at timestamptz;rep int;
BEGIN
 FOR rep IN 1..5 LOOP
   start_at:=clock_timestamp();
   v:=public.powerhub_financial_gl_company_movement_audit(1,1,'2026-11');
   INSERT INTO b57_measurements VALUES(
     'company_movement_audit',
     round((extract(epoch FROM clock_timestamp()-start_at)*1000)::numeric,3),
     md5(v::text),v->>'accountingCertification');
   start_at:=clock_timestamp();
   v:=public.powerhub_financial_gl_subledger_reconciliation(1,1,'2026-11');
   INSERT INTO b57_measurements VALUES(
     'subledger_reconciliation',
     round((extract(epoch FROM clock_timestamp()-start_at)*1000)::numeric,3),
     md5(v::text),v->>'accountingCertification');
 END LOOP;
END $b57$;
DO $validate$
DECLARE anomalies integer;
BEGIN
 SELECT count(*) INTO anomalies FROM (
   SELECT operation FROM b57_measurements GROUP BY operation
   HAVING count(*)<>5 OR count(DISTINCT result_digest)<>1
     OR count(*) FILTER (WHERE certification IS DISTINCT FROM 'NOT_CERTIFIED')<>0
 ) invalid;
 IF anomalies<>0 OR (SELECT count(*) FROM b57_measurements)<>10 THEN
   RAISE EXCEPTION 'B57_GL_READ_DIGEST_OR_NOT_CERTIFIED_DRIFT';
 END IF;
END $validate$;
SELECT operation,count(*) AS sample_count,
 round(percentile_cont(0.5) WITHIN GROUP (ORDER BY elapsed_ms)::numeric,2) AS sample_p50_ms,
 round(percentile_cont(0.95) WITHIN GROUP (ORDER BY elapsed_ms)::numeric,2) AS sample_p95_ms,
 round(percentile_cont(0.99) WITHIN GROUP (ORDER BY elapsed_ms)::numeric,2) AS sample_p99_ms,
 min(elapsed_ms) AS min_ms,max(elapsed_ms) AS max_ms,
 count(DISTINCT result_digest) AS response_variants,
 array_agg(DISTINCT certification) AS certifications
FROM b57_measurements GROUP BY operation ORDER BY operation;
ROLLBACK;
