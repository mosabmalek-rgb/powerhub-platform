-- A2.1 rollback-only SQL acceptance for an installed 20261110010000 migration.
-- Must run on dedicated Staging only; tests write temporary records inside
-- transaction and then ROLLBACK. No real approvals or payments.
BEGIN;
DO $fixture$
DECLARE
 t bigint;s bigint;a bigint;b bigint;other_t bigint;other_s bigint;
 j bigint;draft_id bigint;entry_id bigint;
 result jsonb;retry jsonb;
 rejected boolean:=false;
BEGIN
 SELECT tenant_id,id INTO t,s FROM public.sites WHERE status<>'archived' ORDER BY id LIMIT 1;
 SELECT id INTO a FROM public.users ORDER BY id LIMIT 1;
 SELECT id INTO b FROM public.users WHERE id<>a ORDER BY id LIMIT 1;
 SELECT tenant_id,id INTO other_t,other_s FROM public.sites
  WHERE status<>'archived' AND tenant_id<>t ORDER BY id LIMIT 1;
 IF s IS NULL OR b IS NULL OR other_s IS NULL THEN
   RAISE EXCEPTION 'GL_A21_FIXTURE_MISSING_USERS_OR_SECOND_TENANT';
 END IF;
 -- Only approved source can be projected. Self-approval is denied atomically.
 draft_id:=public.powerhub_financial_accrual_journal_create(
   t,s,a,'2026-09','1100','4100',1.23,
   'Staging rollback-only draft to test denied GL posting',
   'gl-a21-draft-'||txid_current()::text);
 BEGIN
   PERFORM public.powerhub_financial_accrual_post_and_gl(t,s,draft_id,a);
 EXCEPTION WHEN SQLSTATE '22023' THEN rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'GL_A21_SELF_APPROVAL_ACCEPTED'; END IF;
 IF EXISTS (SELECT 1 FROM public.financial_gl_entries
   WHERE tenant_id=t AND site_id=s AND source_type='accrual_adjustment'
   AND source_id=draft_id::text)
 THEN RAISE EXCEPTION 'GL_A21_DENIED_DRAFT_PROJECTED'; END IF;
 j:=public.powerhub_financial_accrual_journal_create(
   t,s,a,'2026-09','5100','2100',39.25,
   'Staging rollback-only approved accrual GL posting fixture',
   'gl-a21-approved-'||txid_current()::text);
 result:=public.powerhub_financial_accrual_post_and_gl(t,s,j,b);
 retry:=public.powerhub_financial_accrual_post_and_gl(t,s,j,b);
 IF result->>'status'<>'posted'
   OR (result->>'alreadyPosted')::boolean
   OR (result->>'glAlreadyPosted')::boolean
   OR NOT (retry->>'alreadyPosted')::boolean
   OR NOT (retry->>'glAlreadyPosted')::boolean
   OR result->>'glEntryId' IS DISTINCT FROM retry->>'glEntryId'
 THEN RAISE EXCEPTION 'GL_A21_RETRY_INCONSISTENT'; END IF;
 entry_id:=(result->>'glEntryId')::bigint;
 IF (SELECT count(*) FROM public.financial_gl_lines WHERE entry_id=entry_id)<>2
 THEN RAISE EXCEPTION 'GL_A21_DUPLICATED_OR_MISSING_LINES'; END IF;
 IF (SELECT coalesce(sum(CASE WHEN side='debit' THEN amount ELSE -amount END),0)
    FROM public.financial_gl_lines WHERE entry_id=entry_id)<>0
 THEN RAISE EXCEPTION 'GL_A21_UNBALANCED'; END IF;
 rejected:=false;
 BEGIN
   PERFORM public.powerhub_financial_accrual_post_and_gl(other_t,other_s,j,b);
 EXCEPTION WHEN SQLSTATE '22023' THEN rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'GL_A21_CROSS_TENANT_ACCEPTED'; END IF;
 SET CONSTRAINTS ALL IMMEDIATE;
END;$fixture$;
ROLLBACK;
-- This fixture retains no rows (or schema changes) when successful.
