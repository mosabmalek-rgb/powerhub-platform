-- D35 — immutable time-slice audit of test-only opening 19, READ ONLY.
-- A later reversal nets out in November but cannot retroactively fix Jan–Oct.
BEGIN READ ONLY;
SET LOCAL statement_timeout='45000ms';
DO $d35$
DECLARE oct_cash numeric;nov_cash numeric;oct_equity numeric;nov_equity numeric;
  evidence_oct jsonb;evidence_nov jsonb;
BEGIN
  IF (SELECT count(*) FROM public.financial_gl_entries)<>25
   OR (SELECT count(*) FROM public.financial_gl_lines)<>51
   OR (SELECT count(*) FROM public.account_transactions)<>361009
   OR (SELECT count(*) FROM public.financial_gl_opening_evidence)<>0
  THEN RAISE EXCEPTION 'D35_STAGING_BASELINE_DRIFT'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.financial_gl_opening_batches
    WHERE id=19 AND tenant_id=1 AND site_id=9000000000099
      AND period='2026-01' AND status='posted' AND expected_line_count=2
      AND evidence_reference='STG-FIN-A-OPENING-TEST-20261109')
  THEN RAISE EXCEPTION 'D35_TEST_OPENING_IDENTITY_DRIFT'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.financial_gl_entries
    WHERE id=168 AND tenant_id=1 AND site_id=9000000000099
     AND period='2026-01' AND source_type='opening_balance'
     AND source_id='19' AND reverses_entry_id IS NULL)
   OR NOT EXISTS(SELECT 1 FROM public.financial_gl_entries
    WHERE id=890 AND tenant_id=1 AND site_id=9000000000099
     AND period='2026-11' AND source_type='correction'
     AND source_id='staging-opening19-technical' AND reverses_entry_id=168)
   OR (SELECT count(*) FROM public.financial_gl_entries WHERE reverses_entry_id=168)<>1
  THEN RAISE EXCEPTION 'D35_OPENING_REVERSAL_LINK_DRIFT'; END IF;
  IF (SELECT count(*) FROM public.financial_gl_lines WHERE entry_id IN(168,890))<>4
   OR EXISTS(SELECT 1 FROM public.financial_gl_lines l WHERE l.entry_id=168
     AND NOT EXISTS(SELECT 1 FROM public.financial_gl_lines r
      WHERE r.entry_id=890 AND r.tenant_id=l.tenant_id AND r.site_id=l.site_id
        AND r.account_code=l.account_code AND r.amount=l.amount
        AND r.side=CASE l.side WHEN 'debit' THEN 'credit' ELSE 'debit' END))
   OR EXISTS(SELECT 1 FROM public.financial_gl_lines r WHERE r.entry_id=890
     AND NOT EXISTS(SELECT 1 FROM public.financial_gl_lines l
      WHERE l.entry_id=168 AND l.tenant_id=r.tenant_id AND l.site_id=r.site_id
        AND l.account_code=r.account_code AND l.amount=r.amount
        AND l.side=CASE r.side WHEN 'debit' THEN 'credit' ELSE 'debit' END))
  THEN RAISE EXCEPTION 'D35_NOT_EXACT_BILATERAL_REVERSAL'; END IF;
  WITH vals AS (
    SELECT l.account_code,
      coalesce(sum(CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END)
        FILTER(WHERE e.period<='2026-10'),0) oct,
      coalesce(sum(CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END)
        FILTER(WHERE e.period<='2026-11'),0) nov
    FROM public.financial_gl_entries e
    JOIN public.financial_gl_lines l ON l.entry_id=e.id
    WHERE e.id IN (168,890) AND e.tenant_id=1 AND e.site_id=9000000000099
    GROUP BY l.account_code
  )
  SELECT max(oct) FILTER(WHERE account_code='1010'),
   max(nov) FILTER(WHERE account_code='1010'),
   max(oct) FILTER(WHERE account_code='3100'),
   max(nov) FILTER(WHERE account_code='3100')
  INTO oct_cash,nov_cash,oct_equity,nov_equity FROM vals;
  IF oct_cash IS DISTINCT FROM 2000 OR nov_cash IS DISTINCT FROM 0
   OR oct_equity IS DISTINCT FROM -2000 OR nov_equity IS DISTINCT FROM 0
  THEN RAISE EXCEPTION 'D35_CROSS_PERIOD_EFFECT_CHANGED';END IF;
  IF EXISTS(SELECT 1 FROM public.account_transactions WHERE tenant_id=1
    AND site_id=9000000000099)
  THEN RAISE EXCEPTION 'D35_UNEXPECTED_ACCOUNT_SOURCE';END IF;
  evidence_oct:=public.powerhub_financial_gl_opening_evidence_status(1,9000000000099,'2026-10');
  evidence_nov:=public.powerhub_financial_gl_opening_evidence_status(1,9000000000099,'2026-11');
  IF evidence_oct->>'status'<>'EVIDENCE_MISSING_OR_UNREVIEWED'
   OR evidence_nov->>'status'<>'EVIDENCE_MISSING_OR_UNREVIEWED'
   OR evidence_oct->>'isIndependentlyReconciled'<>'false'
   OR evidence_nov->>'isIndependentlyReconciled'<>'false'
  THEN RAISE EXCEPTION 'D35_FALSE_RECONCILIATION_AFTER_REVERSAL';END IF;
END $d35$;
ROLLBACK;
SELECT 'D35_TEMPORAL_REVERSAL_OCT_BLOCKED_NOV_NET_ZERO_NOT_CERTIFIED_SCOPED_PASS' AS result;