-- PowerHub Phase D1. READ-ONLY independent audit. Staging only.
-- Re-runnable against the frozen 2026-11-14 tenant-1 fixture. No data mutation.
DO $d$
DECLARE n bigint; debit numeric; credit numeric; v text;
BEGIN
 SELECT count(*) INTO n FROM public.financial_gl_entries;
 IF n<>25 THEN RAISE EXCEPTION 'D1_FROZEN_GL_ENTRY_COUNT_DRIFT %',n;END IF;
 SELECT count(*),coalesce(sum(amount) FILTER(WHERE side='debit'),0),
                 coalesce(sum(amount) FILTER(WHERE side='credit'),0)
 INTO n,debit,credit FROM public.financial_gl_lines;
 IF n<>51 OR debit<>18073.50 OR debit<>credit
 THEN RAISE EXCEPTION 'D1_FROZEN_BALANCE_DRIFT % % %',n,debit,credit;END IF;
 IF (SELECT count(*) FROM public.financial_accrual_period_reviews)<>0
 THEN RAISE EXCEPTION 'D1_STAGING_UNEXPECTED_PERSISTED_APPROVAL';END IF;
 IF (SELECT count(*) FROM public.financial_accrual_journals)<>2 OR
    (SELECT count(*) FROM public.financial_accrual_journals
      WHERE status='posted' AND created_by_user_id<>approved_by_user_id)<>2
 THEN RAISE EXCEPTION 'D1_MAKER_CHECKER_POSTED_JOURNAL_INVALID';END IF;

 WITH per_entry AS (
  SELECT e.id,e.operation_key,e.source_fingerprint,e.source_revision,
  count(l.id) cnt,
  COALESCE(sum(CASE WHEN l.side='debit' THEN l.amount
                    WHEN l.side='credit' THEN -l.amount ELSE 0 END),0) net,
  count(*) FILTER(WHERE l.id IS NOT NULL AND
     (l.tenant_id IS DISTINCT FROM e.tenant_id
      OR l.site_id IS DISTINCT FROM e.site_id
      OR l.side NOT IN ('debit','credit') OR l.amount<=0)) errors
  FROM public.financial_gl_entries e
  LEFT JOIN public.financial_gl_lines l ON l.entry_id=e.id
  GROUP BY e.id
 )
 SELECT count(*) INTO n FROM per_entry
 WHERE cnt<2 OR net<>0 OR errors<>0 OR coalesce(operation_key,'')=''
    OR coalesce(source_fingerprint,'')='' OR source_revision<1;
 IF n<>0 THEN RAISE EXCEPTION 'D1_UNBALANCED_INVALID_OR_UNPROVEN_GL %',n;END IF;
 IF EXISTS(SELECT 1 FROM public.financial_gl_lines l
  LEFT JOIN public.financial_gl_entries e ON e.id=l.entry_id WHERE e.id IS NULL)
 OR EXISTS(SELECT 1 FROM public.financial_gl_entries
   GROUP BY tenant_id,operation_key HAVING count(*)>1)
 THEN RAISE EXCEPTION 'D1_ORPHAN_OR_DUPLICATE_GL';END IF;

 SELECT count(*) INTO n FROM public.financial_accrual_journals j
 LEFT JOIN public.financial_gl_entries e
  ON e.tenant_id=j.tenant_id AND e.site_id=j.site_id
  AND e.source_type='accrual_adjustment' AND e.source_id=j.id::text
 LEFT JOIN public.financial_gl_entries orig
  ON orig.tenant_id=j.tenant_id AND orig.site_id=j.site_id
  AND orig.source_type='accrual_adjustment' AND orig.source_id=j.reverses_journal_id::text
 WHERE j.status='posted' AND
   (e.id IS NULL OR e.posted_by_user_id IS DISTINCT FROM j.approved_by_user_id
    OR (j.reverses_journal_id IS NOT NULL AND
      (orig.id IS NULL OR e.reverses_entry_id IS DISTINCT FROM orig.id)));
 IF n<>0 THEN RAISE EXCEPTION 'D1_POSTED_GL_SUBLEDGER_LINK_BROKEN %',n;END IF;

 WITH reverse_proof AS (
  SELECT rev.id,orig.id orig_id,
   rev.tenant_id=orig.tenant_id AND rev.site_id=orig.site_id scope_ok,
   coalesce((SELECT jsonb_agg(jsonb_build_object('account',l.account_code,
    'side',l.side,'amount',l.amount) ORDER BY l.account_code,l.side,l.amount)
    FROM public.financial_gl_lines l WHERE l.entry_id=rev.id),'[]'::jsonb) actual,
   coalesce((SELECT jsonb_agg(jsonb_build_object('account',l.account_code,
    'side',CASE WHEN l.side='debit' THEN 'credit' ELSE 'debit' END,'amount',l.amount)
    ORDER BY l.account_code,CASE WHEN l.side='debit' THEN 'credit' ELSE 'debit' END,l.amount)
    FROM public.financial_gl_lines l WHERE l.entry_id=orig.id),'[]'::jsonb) expected
  FROM public.financial_gl_entries rev
  LEFT JOIN public.financial_gl_entries orig ON orig.id=rev.reverses_entry_id
  WHERE rev.reverses_entry_id IS NOT NULL
 )
 SELECT count(*) INTO n FROM reverse_proof
 WHERE orig_id IS NULL OR scope_ok IS DISTINCT FROM true OR actual<>expected;
 IF n<>0 THEN RAISE EXCEPTION 'D1_REVERSAL_NOT_EXACT_MIRROR %',n;END IF;
 IF EXISTS(SELECT 1 FROM public.financial_gl_entries
   WHERE reverses_entry_id IS NOT NULL
   GROUP BY reverses_entry_id HAVING count(*)>1)
 THEN RAISE EXCEPTION 'D1_DOUBLE_REVERSAL';END IF;
 IF EXISTS(SELECT 1 FROM public.financial_accrual_period_reviews r
   LEFT JOIN public.sites s ON s.id=r.site_id AND s.tenant_id=r.tenant_id
   WHERE s.id IS NULL OR r.prepared_by_user_id=r.locked_by_user_id)
 THEN RAISE EXCEPTION 'D1_CROSS_SCOPE_OR_SELF_APPROVED_CLOSE';END IF;

 FOREACH v IN ARRAY ARRAY[
   'public.powerhub_financial_accrual_journal_create(bigint,bigint,bigint,text,text,text,numeric,text,text)',
   'public.powerhub_financial_accrual_journal_post(bigint,bigint,bigint,bigint)',
   'public.powerhub_financial_accrual_journal_reverse(bigint,bigint,bigint,bigint,text,text,text)',
   'public.powerhub_financial_accrual_period_save_review(bigint,bigint,text,bigint,jsonb)',
   'public.powerhub_financial_accrual_period_lock(bigint,bigint,text,bigint)'
 ] LOOP
  IF to_regprocedure(v) IS NULL OR has_function_privilege('anon',v,'EXECUTE')
     OR has_function_privilege('authenticated',v,'EXECUTE')
     OR NOT has_function_privilege('service_role',v,'EXECUTE')
  THEN RAISE EXCEPTION 'D1_WRITER_ACL %',v;END IF;
 END LOOP;

 IF ((DATE '2023-02-01'+INTERVAL '1 month - 1 day')::date -
       DATE '2023-02-01'+1)<>28
 OR ((DATE '2024-02-01'+INTERVAL '1 month - 1 day')::date -
       DATE '2024-02-01'+1)<>29
 OR ((DATE '2026-04-01'+INTERVAL '1 month - 1 day')::date -
       DATE '2026-04-01'+1)<>30
 OR ((DATE '2026-01-01'+INTERVAL '1 month - 1 day')::date -
       DATE '2026-01-01'+1)<>31
 THEN RAISE EXCEPTION 'D1_CALENDAR_MONTH_LENGTH_FAILURE';END IF;

 IF (SELECT count(*) FROM (
  SELECT off,lag(off) OVER(ORDER BY t) before_off
  FROM (SELECT t,(t AT TIME ZONE 'Asia/Gaza')-(t AT TIME ZONE 'UTC') AS off
   FROM generate_series('2026-01-01 00:00+00'::timestamptz,
                        '2027-01-01 00:00+00'::timestamptz,
                        INTERVAL '1 hour') t) offsets
  ) transitions WHERE before_off IS NOT NULL AND off<>before_off)<>2
 THEN RAISE EXCEPTION 'D1_2026_GAZA_TZDATA_TRANSITION_FAILURE';END IF;
 RAISE NOTICE 'D1_STAGING_INDEPENDENT_READ_ONLY_GL_REVERSAL_ACL_GAZA_PASS_NOT_CERTIFIED';
END $d$;
SELECT 'D1_STAGING_INDEPENDENT_READ_ONLY_GL_REVERSAL_ACL_GAZA_PASS_NOT_CERTIFIED' AS acceptance;