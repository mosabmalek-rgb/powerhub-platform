-- C1: Staging-only read-only financial month-end preflight.
-- Locks/certification/posting are expressly outside this check.
-- Review periods are known synthetic Staging fixtures, not Production accounts.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout='30000ms';
DO $c1$
DECLARE
  oct_review jsonb;
  nov_review jsonb;
  oct_stmt jsonb;
  nov_stmt jsonb;
  gl_total bigint;
  gl_lines bigint;
  bad_gl bigint;
BEGIN
  SELECT count(*) INTO gl_total FROM public.financial_gl_entries WHERE tenant_id=1;
  SELECT count(*) INTO gl_lines FROM public.financial_gl_lines WHERE tenant_id=1;
  IF gl_total<>25 OR gl_lines<>51 THEN
    RAISE EXCEPTION 'C1_STAGING_FINANCIAL_BASELINE_CHANGED';
  END IF;

  SELECT count(*) INTO bad_gl FROM (
    SELECT e.id FROM public.financial_gl_entries e
    LEFT JOIN public.financial_gl_lines l
      ON l.entry_id=e.id AND l.tenant_id=e.tenant_id AND l.site_id=e.site_id
    WHERE e.tenant_id=1
    GROUP BY e.id
    HAVING count(l.entry_id)<2
      OR coalesce(sum(CASE WHEN l.side='debit' THEN l.amount
                             WHEN l.side='credit' THEN -l.amount
                             ELSE 0 END),0)<>0
  ) bad;
  IF bad_gl<>0 THEN RAISE EXCEPTION 'C1_UNBALANCED_LEDGER'; END IF;

  oct_review:=public.powerhub_financial_accrual_period_review_status(1,1,'2026-10');
  nov_review:=public.powerhub_financial_accrual_period_review_status(1,1,'2026-11');
  oct_stmt:=public.powerhub_financial_accrual_month_statement(1,1,'2026-10',now());
  nov_stmt:=public.powerhub_financial_accrual_month_statement(1,1,'2026-11',now());

  IF oct_review->>'status' IS DISTINCT FROM 'unprepared'
     OR nov_review->>'status' IS DISTINCT FROM 'unprepared'
     OR (oct_review->>'isCertifiedProfit')::boolean IS DISTINCT FROM false
     OR (nov_review->>'isCertifiedProfit')::boolean IS DISTINCT FROM false
  THEN RAISE EXCEPTION 'C1_REVIEW_STATUS_MISREPRESENTED'; END IF;

  IF oct_stmt->>'period' IS DISTINCT FROM '2026-10'
     OR nov_stmt->>'period' IS DISTINCT FROM '2026-11'
     OR (oct_stmt->>'scopeTenantId')::bigint IS DISTINCT FROM 1
     OR (nov_stmt->>'scopeTenantId')::bigint IS DISTINCT FROM 1
     OR (oct_stmt->>'scopeSiteId')::bigint IS DISTINCT FROM 1
     OR (nov_stmt->>'scopeSiteId')::bigint IS DISTINCT FROM 1
     OR (oct_stmt->>'isFinalProfit')::boolean IS DISTINCT FROM false
     OR (nov_stmt->>'isFinalProfit')::boolean IS DISTINCT FROM false
     OR (oct_stmt->>'isCompleteAccrualStatement')::boolean IS DISTINCT FROM false
     OR (nov_stmt->>'isCompleteAccrualStatement')::boolean IS DISTINCT FROM false
  THEN RAISE EXCEPTION 'C1_PERIOD_SCOPE_OR_NONFINAL_GUARD_FAILED'; END IF;

  -- Real synthetic Staging blockers, not fabricated values or a close authorization.
  IF coalesce((nov_stmt->>'uncompletedInvoiceCount')::int,-1)<1
     OR coalesce((nov_stmt->>'unclassifiedInventoryIssueCount')::int,-1)<1
  THEN RAISE EXCEPTION 'C1_EXPECTED_STAGING_CLOSE_BLOCKERS_MISSING'; END IF;

  IF (oct_stmt->'journalAdjustments'->>'balancedDebits')::numeric IS DISTINCT FROM
     (oct_stmt->'journalAdjustments'->>'balancedCredits')::numeric
     OR (nov_stmt->'journalAdjustments'->>'balancedDebits')::numeric IS DISTINCT FROM
        (nov_stmt->'journalAdjustments'->>'balancedCredits')::numeric
  THEN RAISE EXCEPTION 'C1_JOURNAL_DEBIT_CREDIT_MISMATCH'; END IF;

  IF (now() AT TIME ZONE 'Asia/Gaza')::date < date '2026-12-01'
     AND nov_review->>'status'='locked'
  THEN RAISE EXCEPTION 'C1_IN_PROGRESS_MONTH_LOCKED'; END IF;
END $c1$;
SELECT 'C1_STAGING_READ_ONLY_CLOSE_BLOCKERS_PASS_NOT_CERTIFIED' AS acceptance;
ROLLBACK;
