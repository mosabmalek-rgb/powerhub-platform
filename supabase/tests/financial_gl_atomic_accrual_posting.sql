-- A2.1 isolated PostgreSQL 17 CI. Uses real source and GL migrations,
-- actual accrual post/reverse functions, NOT mocked financial RPCs.
-- Disposable database only; never run on Production.
\set ON_ERROR_STOP on
DO $roles$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END;$roles$;
CREATE TABLE public.tenants(id bigint PRIMARY KEY);
CREATE TABLE public.sites(id bigint PRIMARY KEY,tenant_id bigint NOT NULL REFERENCES public.tenants(id),status text NOT NULL);
CREATE TABLE public.users(id bigint PRIMARY KEY);
INSERT INTO public.tenants VALUES(901),(902);
INSERT INTO public.sites VALUES(9101,901,'active'),(9201,902,'active');
INSERT INTO public.users VALUES(9901),(9902);
\ir ../migrations/20261109190000_powerhub_financial_accrual_adjustment_journal.sql
\ir ../migrations/20261110001000_powerhub_financial_accrual_journal_serialization.sql
-- Locking review lookup used by the GL projection; no review is closed in this fixture.
CREATE TABLE public.financial_accrual_period_reviews(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tenant_id bigint NOT NULL,site_id bigint NOT NULL,period text NOT NULL,
 status text NOT NULL
);
\ir ../migrations/20261110005000_powerhub_financial_gl_foundation.sql
\ir ../migrations/20261110010000_powerhub_financial_gl_post_approved_accrual.sql
\ir ../migrations/20261110011000_powerhub_financial_gl_opening_balances.sql
\ir ../migrations/20261110012000_powerhub_financial_gl_source_coverage.sql
\ir ../migrations/20261110013000_powerhub_financial_gl_trial_balance.sql

DO $permissions$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['financial_gl_accounts','financial_gl_entries','financial_gl_lines']
 LOOP
  IF NOT has_table_privilege('service_role','public.'||t,'SELECT') OR
     NOT has_table_privilege('service_role','public.'||t,'INSERT') OR
     has_table_privilege('service_role','public.'||t,'UPDATE') OR
     has_table_privilege('service_role','public.'||t,'DELETE') OR
     has_table_privilege('service_role','public.'||t,'TRUNCATE') OR
     has_table_privilege('authenticated','public.'||t,'SELECT') OR
     has_table_privilege('authenticated','public.'||t,'INSERT') OR
     has_table_privilege('anon','public.'||t,'SELECT')
  THEN RAISE EXCEPTION 'GL_A21_ACL_FAILURE_%',t; END IF;
 END LOOP;
 IF has_function_privilege('anon',
    'public.powerhub_financial_accrual_post_and_gl(bigint,bigint,bigint,bigint)',
    'EXECUTE') OR
    has_function_privilege('authenticated',
    'public.powerhub_financial_gl_post_accrual(bigint,bigint,bigint)','EXECUTE')
 THEN RAISE EXCEPTION 'GL_A21_RPC_BROWSER_EXECUTION_GRANTED'; END IF;
END;$permissions$;

BEGIN;
DO $assertions$
DECLARE
 j bigint;r bigint;orig jsonb;again jsonb;rev jsonb;
 e bigint;reverse_entry bigint;denied boolean:=false;
BEGIN
 j:=public.powerhub_financial_accrual_journal_create(
 901,9101,9901,'2026-09','1100','4100',53.27,
 'Isolated PostgreSQL staged adjustment original source',
 'ci-a21-accrual-original');
 BEGIN
  PERFORM public.powerhub_financial_accrual_post_and_gl(901,9101,j,9901);
 EXCEPTION WHEN SQLSTATE '22023' THEN denied:=true;
 END;
 IF NOT denied THEN RAISE EXCEPTION 'GL_A21_SELF_APPROVAL_ACCEPTED'; END IF;
 IF EXISTS(SELECT 1 FROM public.financial_gl_entries
    WHERE source_type='accrual_adjustment' AND source_id=j::text) THEN
  RAISE EXCEPTION 'GL_A21_GL_POSTED_AFTER_DENIED_APPROVAL';
 END IF;
 orig:=public.powerhub_financial_accrual_post_and_gl(901,9101,j,9902);
 again:=public.powerhub_financial_accrual_post_and_gl(901,9101,j,9902);
 e:=(orig->>'glEntryId')::bigint;
 IF e IS NULL OR orig->>'status'<>'posted' OR
   (orig->>'alreadyPosted')::boolean OR
   NOT (again->>'alreadyPosted')::boolean OR
   NOT (again->>'glAlreadyPosted')::boolean OR
   e<>(again->>'glEntryId')::bigint
 THEN RAISE EXCEPTION 'GL_A21_POST_REPLAY_UNSAFE'; END IF;
 r:=public.powerhub_financial_accrual_journal_reverse(
  901,9101,j,9901,'2026-10',
  'Isolated PostgreSQL reverses original posted accrual',
  'ci-a21-accrual-reversal');
 rev:=public.powerhub_financial_accrual_post_and_gl(901,9101,r,9902);
 reverse_entry:=(rev->>'glEntryId')::bigint;
 IF NOT EXISTS(SELECT 1 FROM public.financial_gl_entries
   WHERE id=reverse_entry AND reverses_entry_id=e AND site_id=9101
      AND tenant_id=901 AND period='2026-10')
 THEN RAISE EXCEPTION 'GL_A21_REVERSAL_SCOPE_OR_LINK_FAILURE'; END IF;
 IF EXISTS(SELECT account_code
  FROM public.financial_gl_lines WHERE entry_id IN(e,reverse_entry)
  GROUP BY account_code
  HAVING SUM(CASE WHEN side='debit' THEN amount ELSE -amount END)<>0)
 THEN RAISE EXCEPTION 'GL_A21_REVERSAL_FAILED_TO_ZERO_ACCOUNTS'; END IF;
 IF (SELECT count(*) FROM public.financial_gl_lines
     WHERE entry_id IN(e,reverse_entry))<>4
 THEN RAISE EXCEPTION 'GL_A21_EXTRA_LINES_OR_MISSING_LINES'; END IF;
 denied:=false;
 BEGIN
  PERFORM public.powerhub_financial_accrual_post_and_gl(902,9201,j,9902);
 EXCEPTION WHEN SQLSTATE '22023' THEN denied:=true;
 END;
 IF NOT denied THEN RAISE EXCEPTION 'GL_A21_WRONG_TENANT_PERMITTED'; END IF;
 SET CONSTRAINTS ALL IMMEDIATE;
END;$assertions$;
ROLLBACK;
SELECT 'PASS: A2.1 atomic approved accrual and reversal GL integration' AS acceptance;


-- Opening balances use the identical GL structure with two approvers.
BEGIN;
DO $opening$
DECLARE j jsonb;p jsonb;r jsonb; oid bigint;eid bigint;denied boolean:=false;
BEGIN
 j:=public.powerhub_financial_gl_opening_create(901,9101,9901,'2026-01-01',
 'CI-OPENING-BOOK-01','Independent opening balance documentation',
 'ci-opening-balances-v1',
 '[{"accountCode":"1010","side":"debit","amount":123.45,"evidenceReference":"CASH-01"},
   {"accountCode":"3100","side":"credit","amount":123.45,"evidenceReference":"CAPITAL-01"}]'::jsonb);
 oid:=(j->>'openingId')::bigint;
 BEGIN
   PERFORM public.powerhub_financial_gl_opening_post(901,9101,oid,9901);
 EXCEPTION WHEN SQLSTATE '22023' THEN denied:=true;
 END;
 IF NOT denied THEN RAISE EXCEPTION 'OPENING_SELF_APPROVAL_NOT_REJECTED'; END IF;
 p:=public.powerhub_financial_gl_opening_post(901,9101,oid,9902);
 r:=public.powerhub_financial_gl_opening_post(901,9101,oid,9902);
 eid:=(p->>'entryId')::bigint;
 IF eid IS NULL OR p->>'status'<>'posted' OR
 (p->>'alreadyPosted')::boolean OR NOT (r->>'alreadyPosted')::boolean OR
 eid<>(r->>'entryId')::bigint
 THEN RAISE EXCEPTION 'OPENING_ATOMIC_RETRY_FAILED'; END IF;
 IF (SELECT count(*) FROM public.financial_gl_lines WHERE entry_id=eid)<>2
 THEN RAISE EXCEPTION 'OPENING_WRONG_LINE_COUNT'; END IF;
 denied:=false;
 BEGIN
   INSERT INTO public.financial_gl_opening_lines
     (opening_id,tenant_id,site_id,sequence_number,account_code,side,amount,evidence_reference)
   VALUES(oid,901,9101,3,'1010','debit',1,'CI-AFTER-POST');
 EXCEPTION WHEN SQLSTATE '22023' THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'OPENING_POSTED_LINES_NOT_SEALED'; END IF;
 denied:=false;
 BEGIN
   PERFORM public.powerhub_financial_gl_opening_post(902,9201,oid,9902);
 EXCEPTION WHEN SQLSTATE '22023' THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'OPENING_CROSS_TENANT_POST_ACCEPTED'; END IF;
 SET CONSTRAINTS ALL IMMEDIATE;
END;
$opening$;
ROLLBACK;
SELECT 'PASS: A2.2 documented, balanced, immutable opening balances' AS acceptance;


DO $coverage$
DECLARE report jsonb;
BEGIN
  report:=public.powerhub_financial_gl_source_coverage(901,9101,'2026-10');
  IF report->>'accountingCertification'<>'NOT_CERTIFIED'
     OR (report->>'isFinalProfit')::boolean
     OR (report->>'isCompleteAccrualStatement')::boolean
     OR (report->'opening'->>'postedCount')::integer<>0
     OR (report->>'isOpeningReconciled')::boolean
  THEN RAISE EXCEPTION 'GL_A3_COVERAGE_FALSE_CERTIFICATION'; END IF;
  IF NOT (report ? 'unreconciledSourceCount') OR NOT (report ? 'sources')
     OR NOT (report ? 'gl') OR NOT (report ? 'opening')
  THEN RAISE EXCEPTION 'GL_A3_COVERAGE_PARTIAL_RESULT'; END IF;
END;
$coverage$;

DO $trial$
DECLARE report jsonb;
BEGIN
  report:=public.powerhub_financial_gl_trial_balance(901,9101,'2026-10');
  IF report->>'accountingCertification'<>'NOT_CERTIFIED'
    OR (report->>'isFinalBalanceSheet')::boolean
    OR NOT (report->>'isMathematicallyBalanced')::boolean
    OR (report->>'difference')::numeric<>0
    OR NOT (report ? 'sourceCoverage')
  THEN RAISE EXCEPTION 'GL_A4_TRIAL_BALANCE_CERTIFICATION_MISMATCH'; END IF;
END;
$trial$;
