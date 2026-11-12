-- B5.3 negative proof: new, unrelated, non-fixture historical cash
-- movements must NEVER be filtered out by the fast Staging benchmark path.
-- Run ONLY on synthetic Staging. Every insertion is rolled back.
BEGIN;
SET LOCAL statement_timeout='90000ms';
DO $qa$
DECLARE raw_before jsonb; filtered_before jsonb; raw_after jsonb; filtered_after jsonb; n bigint;
BEGIN
 raw_before:=public.powerhub_financial_gl_prior_operational_gaps_raw(1,1,'2026-11');
 filtered_before:=public.powerhub_financial_gl_prior_operational_gaps(1,1,'2026-11');
 SELECT count(*) INTO n FROM public.financial_gl_entries WHERE tenant_id=1;
 INSERT INTO public.account_transactions(id,tenant_id,site_id,account_id,transaction_type,amount,description,reference_no,created_by_user_id,occurred_at)
 VALUES(900000000009799,1,1,5,'collection',1.01,
   'B5.3 synthetic unclassified historical source','B5-3-UNLINKED-HISTORICAL',
   4,'2026-06-05T12:00:00+00');
 raw_after:=public.powerhub_financial_gl_prior_operational_gaps_raw(1,1,'2026-11');
 filtered_after:=public.powerhub_financial_gl_prior_operational_gaps(1,1,'2026-11');
 IF (raw_after->>'unclassifiedAccountMovements')::bigint
    -(raw_before->>'unclassifiedAccountMovements')::bigint<>1
 OR (raw_after->>'performanceFixtureTagged')::bigint
    <>(raw_before->>'performanceFixtureTagged')::bigint
 OR (filtered_after->>'unclassifiedAccountMovements')::bigint
    -(filtered_before->>'unclassifiedAccountMovements')::bigint<>1
 OR (filtered_after->>'unreconciledCount')::bigint
    -(filtered_before->>'unreconciledCount')::bigint<>1
 OR (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>n
 THEN RAISE EXCEPTION 'B5_3_NONFIXTURE_HIDDEN_OR_MUTATED'; END IF;
END;$qa$;
SELECT 'B5_3_NONFIXTURE_MOVEMENT_VISIBLE_PASS_ROLLBACK' result;
ROLLBACK;
