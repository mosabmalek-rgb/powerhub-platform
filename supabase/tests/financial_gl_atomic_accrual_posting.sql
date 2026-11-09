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
