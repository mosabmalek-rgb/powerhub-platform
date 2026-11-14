-- Phase A2, transactional regression for an INSTALLED GL foundation.
-- Run ONLY in Staging after 20261110005000 is correctly recorded. ROLLBACK all fixtures.
-- An independent pre-application rehearsal must first BEGIN; run migration SQL;
-- run this fixture (without its BEGIN); ROLLBACK, retaining no schema.
BEGIN;
DO $fixture$
DECLARE
 t bigint; s bigint; u bigint; other_site bigint; eid bigint;
 rejected_balance boolean:=false; rejected_scope boolean:=false;
 rejected_duplicate boolean:=false; rejected_mutation boolean:=false;
BEGIN
 SELECT id,tenant_id INTO s,t FROM public.sites WHERE status<>'archived' ORDER BY id LIMIT 1;
 SELECT id INTO u FROM public.users ORDER BY id LIMIT 1;
 SELECT id INTO other_site FROM public.sites
 WHERE status<>'archived' AND tenant_id<>t ORDER BY id LIMIT 1;
 IF s IS NULL OR u IS NULL OR other_site IS NULL THEN
   RAISE EXCEPTION 'GL_FIXTURE_MISSING_DISTINCT_TENANTS_OR_ACTOR';
 END IF;
 INSERT INTO public.financial_gl_accounts(tenant_id,code,name,account_class,normal_side)
 VALUES(t,'991101','Fixture asset','asset','debit'),
       (t,'991401','Fixture revenue','revenue','credit');
 BEGIN
  INSERT INTO public.financial_gl_entries(tenant_id,site_id,period,source_type,source_id,
    operation_key,source_fingerprint,accounting_policy_version,posted_by_user_id)
  VALUES(t,s,'2026-10','invoice','fixture-unbalanced','fixture-balance-check-2026',
    repeat('b',64),'fixture-v1',u) RETURNING id INTO eid;
  INSERT INTO public.financial_gl_lines(entry_id,tenant_id,site_id,account_code,side,amount)
  VALUES(eid,t,s,'991101','debit',10),(eid,t,s,'991401','credit',9);
  SET CONSTRAINTS ALL IMMEDIATE;
 EXCEPTION WHEN SQLSTATE '23514' THEN rejected_balance:=true;
 END;
 IF NOT rejected_balance THEN RAISE EXCEPTION 'GL_UNBALANCED_ENTRY_ACCEPTED'; END IF;
 BEGIN
  INSERT INTO public.financial_gl_entries(tenant_id,site_id,period,source_type,source_id,
    operation_key,source_fingerprint,accounting_policy_version,posted_by_user_id)
  VALUES(t,other_site,'2026-10','invoice','fixture-cross-tenant','fixture-scope-check-2026',
    repeat('c',64),'fixture-v1',u);
 EXCEPTION WHEN SQLSTATE '22023' THEN rejected_scope:=true;
 END;
 IF NOT rejected_scope THEN RAISE EXCEPTION 'GL_CROSS_TENANT_ENTRY_ACCEPTED'; END IF;
 INSERT INTO public.financial_gl_entries(tenant_id,site_id,period,source_type,source_id,
    operation_key,source_fingerprint,accounting_policy_version,posted_by_user_id)
 VALUES(t,s,'2026-10','invoice','fixture-duplicate','fixture-first-key-2026',
   repeat('d',64),'fixture-v1',u) RETURNING id INTO eid;
 INSERT INTO public.financial_gl_lines(entry_id,tenant_id,site_id,account_code,side,amount)
 VALUES(eid,t,s,'991101','debit',13.24),(eid,t,s,'991401','credit',13.24);
 SET CONSTRAINTS ALL IMMEDIATE;
 BEGIN
  INSERT INTO public.financial_gl_entries(tenant_id,site_id,period,source_type,source_id,
    operation_key,source_fingerprint,accounting_policy_version,posted_by_user_id)
  VALUES(t,s,'2026-10','invoice','fixture-duplicate','fixture-second-key-2026',
    repeat('d',64),'fixture-v1',u);
 EXCEPTION WHEN unique_violation THEN rejected_duplicate:=true;
 END;
 IF NOT rejected_duplicate THEN RAISE EXCEPTION 'GL_DUPLICATE_SOURCE_ACCEPTED'; END IF;
 BEGIN
   UPDATE public.financial_gl_lines SET amount=1 WHERE entry_id=eid;
 EXCEPTION WHEN SQLSTATE '22023' THEN rejected_mutation:=true;
 END;
 IF NOT rejected_mutation THEN RAISE EXCEPTION 'GL_POSTED_LINE_MUTATED'; END IF;
END;
$fixture$;
ROLLBACK;
-- After a successful run, test rows are not retained; schema stays installed.
