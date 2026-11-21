-- Phase A2.1 approved accrual reversal → GL reversal, rollback-only.
-- Requires the 20261110010000 migration installed on Staging.
BEGIN;
DO $test$
DECLARE t bigint;s bigint;a bigint;b bigint;j bigint;r bigint;old_gl bigint;new_gl bigint;
 original jsonb;reversal jsonb;
BEGIN
 SELECT tenant_id,id INTO t,s FROM public.sites WHERE status<>'archived' ORDER BY id LIMIT 1;
 SELECT id INTO a FROM public.users ORDER BY id LIMIT 1;
 SELECT id INTO b FROM public.users WHERE id<>a ORDER BY id LIMIT 1;
 IF s IS NULL OR b IS NULL THEN
   RAISE EXCEPTION 'GL_REVERSAL_FIXTURE_MISSING_ACTORS';
 END IF;
 j:=public.powerhub_financial_accrual_journal_create(
  t,s,a,'2026-09','1100','4100',82.19,
  'Reversal fixture: initial approved accrued service',
  'gl-a21-reversal-original-'||txid_current()::text);
 original:=public.powerhub_financial_accrual_post_and_gl(t,s,j,b);
 old_gl:=(original->>'glEntryId')::bigint;
 r:=public.powerhub_financial_accrual_journal_reverse(
  t,s,j,a,'2026-10','Reversal fixture: correct original accrued service',
  'gl-a21-reversal-adjustment-'||txid_current()::text);
 reversal:=public.powerhub_financial_accrual_post_and_gl(t,s,r,b);
 new_gl:=(reversal->>'glEntryId')::bigint;
 IF old_gl IS NULL OR new_gl IS NULL OR new_gl=old_gl THEN
   RAISE EXCEPTION 'GL_REVERSAL_ENTRIES_NOT_DISTINCT';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.financial_gl_entries
   WHERE id=new_gl AND tenant_id=t AND site_id=s
     AND reverses_entry_id=old_gl AND period='2026-10') THEN
   RAISE EXCEPTION 'GL_REVERSAL_LINK_NOT_PROVEN';
 END IF;
 IF EXISTS(SELECT account_code,
    sum(CASE WHEN side='debit' THEN amount ELSE -amount END) AS balance
   FROM public.financial_gl_lines WHERE entry_id IN (old_gl,new_gl)
   GROUP BY account_code HAVING sum(CASE WHEN side='debit' THEN amount ELSE -amount END)<>0)
 THEN RAISE EXCEPTION 'GL_REVERSAL_AMOUNT_NOT_NET_ZERO'; END IF;
 IF (SELECT count(*) FROM public.financial_gl_lines
   WHERE entry_id IN (old_gl,new_gl))<>4 THEN
   RAISE EXCEPTION 'GL_REVERSAL_UNEXPECTED_LINE_COUNT';
 END IF;
 SET CONSTRAINTS ALL IMMEDIATE;
END;
$test$;
ROLLBACK;
