-- PostgreSQL 17 disposable integration: apply the EXACT GL migration file, then verify
-- double-entry, security, cross-tenant references, idempotency and immutability.
-- CI runs on a new isolated database. Never run this against Production.
\set ON_ERROR_STOP on
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$roles$;
CREATE TABLE public.tenants (id bigint PRIMARY KEY);
CREATE TABLE public.sites (id bigint PRIMARY KEY, tenant_id bigint NOT NULL REFERENCES public.tenants(id),
                            status text NOT NULL);
CREATE TABLE public.users (id bigint PRIMARY KEY);
INSERT INTO public.tenants VALUES (901),(902);
INSERT INTO public.sites VALUES (9101,901,'active'),(9201,902,'active');
INSERT INTO public.users VALUES (9901);
-- \ir resolves relative to this SQL file, not the current working directory.
\ir ../migrations/20261110005000_powerhub_financial_gl_foundation.sql

DO $permissions$
DECLARE p text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['financial_gl_accounts','financial_gl_entries','financial_gl_lines'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=t AND c.relrowsecurity) THEN
      RAISE EXCEPTION 'GL_RLS_DISABLED_%',t;
    END IF;
    FOREACH p IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF has_table_privilege(p,'public.'||t,'INSERT')
        OR has_table_privilege(p,'public.'||t,'UPDATE')
        OR has_table_privilege(p,'public.'||t,'DELETE') THEN
        RAISE EXCEPTION 'GL_CLIENT_OR_SERVICE_ROLE_DML_GRANTED_%_%',t,p;
      END IF;
    END LOOP;
    IF NOT has_table_privilege('service_role','public.'||t,'SELECT') THEN
      RAISE EXCEPTION 'GL_SERVICE_ROLE_READ_MISSING_%',t;
    END IF;
    IF has_table_privilege('anon','public.'||t,'SELECT')
      OR has_table_privilege('authenticated','public.'||t,'SELECT') THEN
      RAISE EXCEPTION 'GL_BROWSER_READ_LEAK_%',t;
    END IF;
  END LOOP;
END
$permissions$;

BEGIN;
DO $test$
DECLARE
  eid bigint;
  balanced_denied boolean := false;
  scope_denied boolean := false;
  duplicate_denied boolean := false;
  mutation_denied boolean := false;
  reversal_scope_denied boolean := false;
  no_lines_denied boolean := false;
BEGIN
  INSERT INTO public.financial_gl_accounts(tenant_id,code,name,account_class,normal_side)
  VALUES(901,'991101','Staging asset','asset','debit'),
        (901,'991401','Staging revenue','revenue','credit'),
        (902,'991101','Tenant two asset','asset','debit'),
        (902,'991401','Tenant two revenue','revenue','credit');

  BEGIN
    INSERT INTO public.financial_gl_entries(
      tenant_id,site_id,period,source_type,source_id,source_revision,
      operation_key,source_fingerprint,accounting_policy_version,posted_by_user_id)
    VALUES(901,9101,'2026-10','invoice','unbalanced',1,
      'gl-ci-unbalanced-source',repeat('a',64),'test-v1',9901) RETURNING id INTO eid;
    INSERT INTO public.financial_gl_lines(entry_id,tenant_id,site_id,account_code,side,amount)
    VALUES(eid,901,9101,'991101','debit',13.24),(eid,901,9101,'991401','credit',12.24);
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN SQLSTATE '23514' THEN balanced_denied := true;
  END;
  IF NOT balanced_denied THEN RAISE EXCEPTION 'GL_UNBALANCED_ENTRY_ACCEPTED'; END IF;

  BEGIN
    INSERT INTO public.financial_gl_entries(
      tenant_id,site_id,period,source_type,source_id,
      operation_key,source_fingerprint,accounting_policy_version,posted_by_user_id)
    VALUES(901,9101,'2026-10','invoice','no-lines',
      'gl-ci-no-lines-event',repeat('a',64),'test-v1',9901);
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN SQLSTATE '23514' THEN no_lines_denied := true;
  END;
  IF NOT no_lines_denied THEN RAISE EXCEPTION 'GL_HEADER_WITHOUT_LINES_ACCEPTED'; END IF;

  BEGIN
    INSERT INTO public.financial_gl_entries(
      tenant_id,site_id,period,source_type,source_id,
      operation_key,source_fingerprint,accounting_policy_version,posted_by_user_id)
    VALUES(901,9201,'2026-10','invoice','wrong-scope',
      'gl-ci-scope-event',repeat('b',64),'test-v1',9901);
  EXCEPTION WHEN SQLSTATE '22023' THEN scope_denied := true;
  END;
  IF NOT scope_denied THEN RAISE EXCEPTION 'GL_CROSS_TENANT_SITE_ACCEPTED'; END IF;

  INSERT INTO public.financial_gl_entries(
    tenant_id,site_id,period,source_type,source_id,source_revision,
    operation_key,source_fingerprint,accounting_policy_version,posted_by_user_id)
  VALUES(901,9101,'2026-10','invoice','valid-invoice',1,
    'gl-ci-valid-source',repeat('c',64),'test-v1',9901) RETURNING id INTO eid;
  INSERT INTO public.financial_gl_lines(entry_id,tenant_id,site_id,account_code,side,amount)
  VALUES(eid,901,9101,'991101','debit',13.24),
        (eid,901,9101,'991401','credit',13.24);
  SET CONSTRAINTS ALL IMMEDIATE;

  BEGIN
    INSERT INTO public.financial_gl_entries(
      tenant_id,site_id,period,source_type,source_id,source_revision,
      operation_key,source_fingerprint,accounting_policy_version,posted_by_user_id)
    VALUES(901,9101,'2026-10','invoice','valid-invoice',1,
      'gl-ci-another-operation',repeat('c',64),'test-v1',9901);
  EXCEPTION WHEN unique_violation THEN duplicate_denied := true;
  END;
  IF NOT duplicate_denied THEN RAISE EXCEPTION 'GL_DUPLICATE_SOURCE_ACCEPTED'; END IF;

  BEGIN
    UPDATE public.financial_gl_lines SET amount=0.01 WHERE entry_id=eid;
  EXCEPTION WHEN SQLSTATE '22023' THEN mutation_denied := true;
  END;
  IF NOT mutation_denied THEN RAISE EXCEPTION 'GL_IMMUTABLE_LINE_CHANGED'; END IF;

  BEGIN
    INSERT INTO public.financial_gl_entries(
      tenant_id,site_id,period,source_type,source_id,source_revision,
      operation_key,source_fingerprint,accounting_policy_version,posted_by_user_id,
      reverses_entry_id)
    VALUES(902,9201,'2026-11','correction','cross-tenant-reversal',1,
      'gl-ci-reversal-cross',repeat('d',64),'test-v1',9901,eid);
  EXCEPTION WHEN foreign_key_violation THEN reversal_scope_denied := true;
  END;
  IF NOT reversal_scope_denied THEN RAISE EXCEPTION 'GL_CROSS_TENANT_REVERSAL_ACCEPTED'; END IF;

  IF (SELECT sum(CASE WHEN side='debit' THEN amount ELSE -amount END)
      FROM public.financial_gl_lines WHERE entry_id=eid)<>0 THEN
    RAISE EXCEPTION 'GL_FINAL_BALANCE_MISMATCH';
  END IF;
END $test$;
ROLLBACK;
SELECT 'PASS: GL migration applied in isolated database; rollback-only fixtures passed' AS acceptance;
