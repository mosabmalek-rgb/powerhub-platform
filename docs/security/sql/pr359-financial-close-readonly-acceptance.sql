-- PowerHub financial close acceptance: READ-ONLY integrity gate.
-- Run in Staging as an administrative auditor. Does not certify P&L or balance sheet.
-- Zero rows of journal/review evidence means NOT TESTED, not a successful acceptance.
WITH journal AS (
 SELECT count(*)::bigint AS total,
        count(*) FILTER (WHERE status='posted')::bigint AS posted,
        count(*) FILTER (WHERE status='draft')::bigint AS drafts,
        count(*) FILTER (WHERE status='void')::bigint AS voided,
        count(*) FILTER (WHERE amount IS NULL OR amount<=0 OR debit_account=credit_account)::bigint AS invalid_pairs,
        count(*) FILTER (WHERE status='posted' AND
          (approved_by_user_id IS NULL OR approved_by_user_id=created_by_user_id OR approved_at IS NULL))::bigint AS invalid_approvals,
        count(*) FILTER (WHERE status='void' AND
          (void_reason IS NULL OR btrim(void_reason)='' OR voided_at IS NULL))::bigint AS invalid_voids,
        coalesce(sum(amount) FILTER (WHERE status='posted'),0)::numeric AS posted_debits,
        coalesce(sum(amount) FILTER (WHERE status='posted'),0)::numeric AS posted_credits
 FROM public.financial_accrual_journals
), review AS (
 SELECT count(*)::bigint AS total,
        count(*) FILTER (WHERE status='locked')::bigint AS locked,
        count(*) FILTER (WHERE status='locked' AND
          (prepared_by_user_id IS NULL OR locked_by_user_id IS NULL
           OR prepared_by_user_id=locked_by_user_id OR locked_at IS NULL
           OR source_fingerprint IS NULL OR locked_snapshot IS NULL))::bigint AS invalid_locks
 FROM public.financial_accrual_period_reviews
)
SELECT journal.*, review.total AS review_total, review.locked AS locked_reviews,
       review.invalid_locks,
       CASE WHEN journal.total=0 OR review.total=0 THEN 'NOT_TESTED_NO_PERSISTED_FIXTURES'
            WHEN journal.invalid_pairs<>0 OR journal.invalid_approvals<>0 OR journal.invalid_voids<>0
              OR review.invalid_locks<>0 OR journal.posted_debits<>journal.posted_credits
              THEN 'FAIL_INTEGRITY'
            ELSE 'PASS_STRUCTURAL_ONLY_NOT_CERTIFIED' END AS acceptance_status
FROM journal CROSS JOIN review;
