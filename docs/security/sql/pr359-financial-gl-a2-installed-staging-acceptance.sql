-- PowerHub A2 staging installed-migrations acceptance (2026-11-09).
-- Run on Staging only after exact-version migrations 20261110010000, 20261110011000.
-- Reads ACL, exercises accounting flows with synthetic rollback-only rows.
-- NEVER run in Production.
BEGIN;
DO $accept$
DECLARE t bigint;s bigint;u bigint;reviewer bigint;other_t bigint;other_s bigint;
 j bigint;r bigint; o jsonb;approved jsonb;replayed jsonb;rev jsonb;
 entry bigint; opening_id bigint; opening_entry bigint;blocked boolean;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations
 WHERE version='20261110010000' AND name='powerhub_financial_gl_post_approved_accrual')
 OR NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations
 WHERE version='20261110011000' AND name='powerhub_financial_gl_opening_balances') THEN
 RAISE EXCEPTION 'A2_STAGING_MIGRATION_HISTORY_MISSING' USING ERRCODE='22023'; END IF;
 IF to_regprocedure('public.powerhub_financial_accrual_post_and_gl(bigint,bigint,bigint,bigint)') IS NULL
 OR to_regprocedure('public.powerhub_financial_gl_opening_post(bigint,bigint,bigint,bigint)') IS NULL
 THEN RAISE EXCEPTION 'A2_STAGING_RPCS_MISSING' USING ERRCODE='22023'; END IF;
 IF has_function_privilege('authenticated',
 'public.powerhub_financial_accrual_post_and_gl(bigint,bigint,bigint,bigint)','EXECUTE')
 OR has_function_privilege('anon',
 'public.powerhub_financial_gl_opening_post(bigint,bigint,bigint,bigint)','EXECUTE')
 THEN RAISE EXCEPTION 'A2_STAGING_PUBLIC_RPC_EXECUTE' USING ERRCODE='42501'; END IF;
 IF has_table_privilege('service_role','public.financial_gl_entries','UPDATE')
 OR has_table_privilege('service_role','public.financial_gl_entries','DELETE')
 OR has_table_privilege('authenticated','public.financial_gl_entries','SELECT')
 OR has_table_privilege('authenticated','public.financial_gl_opening_batches','SELECT')
 THEN RAISE EXCEPTION 'A2_STAGING_WRONG_TABLE_PRIVILEGES' USING ERRCODE='42501'; END IF;

 SELECT tenant_id,id INTO t,s FROM public.sites WHERE status<>'archived' ORDER BY id LIMIT 1;
 SELECT id INTO u FROM public.users ORDER BY id LIMIT 1;
 SELECT id INTO reviewer FROM public.users WHERE id<>u ORDER BY id LIMIT 1;
 SELECT tenant_id,id INTO other_t,other_s
 FROM public.sites WHERE status<>'archived' AND tenant_id<>t ORDER BY id LIMIT 1;
 IF t IS NULL OR reviewer IS NULL OR other_s IS NULL
 THEN RAISE EXCEPTION 'A2_STAGING_FIXTURE_MISSING_TWO_TENANTS'; END IF;

 o:=public.powerhub_financial_gl_opening_create(t,s,u,'2026-01-01',
 'A2-STAGING-OPENING-EVIDENCE','Synthetic rollback-only opening with separate reviewer',
 'a2-installed-opening-'||txid_current()::text,
 '[{"accountCode":"1010","side":"debit","amount":41.27,"evidenceReference":"TEST-CASH"},
   {"accountCode":"3100","side":"credit","amount":41.27,"evidenceReference":"TEST-EQUITY"}]'::jsonb);
 opening_id:=(o->>'openingId')::bigint;
 blocked:=false;
 BEGIN
   PERFORM public.powerhub_financial_gl_opening_post(t,s,opening_id,u);
 EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'A2_STAGING_OPENING_SELF_APPROVAL_ALLOWED'; END IF;
 blocked:=false;
 BEGIN
  UPDATE public.financial_gl_opening_batches
  SET status='posted',approved_by_user_id=reviewer,approved_at=now()
  WHERE id=opening_id;
  SET CONSTRAINTS ALL IMMEDIATE;
 EXCEPTION WHEN SQLSTATE '23514' THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'A2_STAGING_OPENING_POST_WITHOUT_GL'; END IF;

 approved:=public.powerhub_financial_gl_opening_post(t,s,opening_id,reviewer);
 replayed:=public.powerhub_financial_gl_opening_post(t,s,opening_id,reviewer);
 opening_entry:=(approved->>'entryId')::bigint;
 IF opening_entry IS NULL OR approved->>'status'<>'posted'
 OR (approved->>'alreadyPosted')::boolean OR NOT (replayed->>'alreadyPosted')::boolean
 OR (replayed->>'entryId')::bigint<>opening_entry THEN
 RAISE EXCEPTION 'A2_STAGING_OPENING_REPLAY_FAILED'; END IF;
 blocked:=false;
 BEGIN
   INSERT INTO public.financial_gl_opening_lines
    (opening_id,tenant_id,site_id,sequence_number,account_code,side,amount,evidence_reference)
   VALUES(opening_id,t,s,3,'1010','debit',1,'AFTER-APPROVAL');
 EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'A2_STAGING_POSTED_OPENING_MUTABLE'; END IF;

 j:=public.powerhub_financial_accrual_journal_create(t,s,u,'2026-09',
 '5100','2100',79.31,'Synthetic isolated accrual approval and GL projection',
 'a2-installed-accrual-'||txid_current()::text);
 blocked:=false;
 BEGIN
  PERFORM public.powerhub_financial_accrual_post_and_gl(t,s,j,u);
 EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'A2_STAGING_ACCRUAL_SELF_APPROVAL_ALLOWED'; END IF;
 approved:=public.powerhub_financial_accrual_post_and_gl(t,s,j,reviewer);
 replayed:=public.powerhub_financial_accrual_post_and_gl(t,s,j,reviewer);
 entry:=(approved->>'glEntryId')::bigint;
 IF entry IS NULL OR (approved->>'glAlreadyPosted')::boolean
 OR NOT (replayed->>'glAlreadyPosted')::boolean
 OR (replayed->>'glEntryId')::bigint<>entry THEN
 RAISE EXCEPTION 'A2_STAGING_ACCRUAL_DUPLICATE'; END IF;
 blocked:=false;
 BEGIN
  PERFORM public.powerhub_financial_accrual_post_and_gl(other_t,other_s,j,reviewer);
 EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'A2_STAGING_CROSS_TENANT_APPROVAL_ALLOWED'; END IF;
 r:=public.powerhub_financial_accrual_journal_reverse(t,s,j,u,'2026-10',
 'Rollback-only reversal of the preceding approved accrual',
 'a2-installed-reversal-'||txid_current()::text);
 rev:=public.powerhub_financial_accrual_post_and_gl(t,s,r,reviewer);
 IF NOT EXISTS(SELECT 1 FROM public.financial_gl_entries e
  WHERE e.id=(rev->>'glEntryId')::bigint AND e.tenant_id=t AND e.site_id=s
  AND e.reverses_entry_id=entry) THEN
  RAISE EXCEPTION 'A2_STAGING_REVERSAL_NOT_LINKED'; END IF;
 IF EXISTS(SELECT account_code FROM public.financial_gl_lines
  WHERE entry_id IN (entry,(rev->>'glEntryId')::bigint)
  GROUP BY account_code
  HAVING SUM(CASE WHEN side='debit' THEN amount ELSE -amount END)<>0) THEN
 RAISE EXCEPTION 'A2_STAGING_REVERSAL_NOT_ZERO'; END IF;
 SET CONSTRAINTS ALL IMMEDIATE;
END;$accept$;
ROLLBACK;
-- The source tables must remain unchanged. The BEGIN/ROLLBACK check proves
-- no transaction rows persist, but sequences may advance as in PostgreSQL.
