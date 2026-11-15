-- D37: READ ONLY final audit of the Staging-only synthetic opening normalization.
BEGIN READ ONLY;
SET LOCAL statement_timeout='45000ms';
DO $d37$
DECLARE v_oct jsonb;v_nov jsonb;v_jan bigint;v_restore bigint;
BEGIN
 IF (SELECT count(*) FROM public.financial_gl_entries)<>27
 OR (SELECT count(*) FROM public.financial_gl_lines)<>55
 OR (SELECT count(*) FROM public.account_transactions)<>361009
 OR (SELECT count(*) FROM public.financial_gl_opening_evidence)<>0
 THEN RAISE EXCEPTION 'D37_STAGING_BASELINE_DRIFT';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.sites WHERE tenant_id=1 AND id=9000000000099
  AND name='STAGING Finance A Isolated Acceptance (TEST ONLY)')
 THEN RAISE EXCEPTION 'D37_WRONG_STAGING_FIXTURE';END IF;
 SELECT id INTO STRICT v_jan FROM public.financial_gl_entries
 WHERE tenant_id=1 AND site_id=9000000000099 AND period='2026-01'
 AND source_type='correction'
 AND operation_key='gl:prelaunch:opening19:jan-correct:v1'
 AND source_id='prelaunch-opening19-january-fixture-net-zero';
 SELECT id INTO STRICT v_restore FROM public.financial_gl_entries
 WHERE tenant_id=1 AND site_id=9000000000099 AND period='2026-11'
 AND source_type='correction' AND reverses_entry_id=890
 AND operation_key='gl:prelaunch:opening19:nov-restore:v1'
 AND source_id='prelaunch-opening19-november-offset-890';
 IF NOT EXISTS(SELECT 1 FROM public.financial_gl_entries WHERE id=890 AND reverses_entry_id=168)
 OR NOT EXISTS(SELECT 1 FROM public.financial_gl_entries WHERE id=168 AND source_type='opening_balance' AND source_id='19')
 OR (SELECT count(*) FROM public.financial_gl_lines WHERE entry_id IN(v_jan,v_restore))<>4
 THEN RAISE EXCEPTION 'D37_CORRECTION_CHAIN_DRIFT';END IF;
 IF EXISTS (
  WITH cuts AS (SELECT unnest(ARRAY['2026-01','2026-10','2026-11']) cutoff),
  accounts AS (SELECT unnest(ARRAY['1010','3100']) code)
  SELECT 1 FROM cuts c CROSS JOIN accounts a
  LEFT JOIN public.financial_gl_entries e
    ON e.tenant_id=1 AND e.site_id=9000000000099 AND e.period<=c.cutoff
  LEFT JOIN public.financial_gl_lines l ON l.entry_id=e.id AND l.account_code=a.code
  GROUP BY c.cutoff,a.code
  HAVING coalesce(sum(CASE l.side WHEN 'debit' THEN l.amount
    WHEN 'credit' THEN -l.amount ELSE 0 END),0)<>0
 ) THEN RAISE EXCEPTION 'D37_HISTORICAL_BALANCES_NONZERO';END IF;
 v_oct:=public.powerhub_financial_gl_opening_evidence_status(1,9000000000099,'2026-10');
 v_nov:=public.powerhub_financial_gl_opening_evidence_status(1,9000000000099,'2026-11');
 IF v_oct->>'status'<>'EVIDENCE_MISSING_OR_UNREVIEWED'
 OR v_nov->>'status'<>'EVIDENCE_MISSING_OR_UNREVIEWED'
 OR v_oct->>'isIndependentlyReconciled'<>'false'
 OR v_nov->>'isIndependentlyReconciled'<>'false'
 THEN RAISE EXCEPTION 'D37_FALSE_ACCOUNTING_CERTIFICATION';END IF;
END $d37$;
ROLLBACK;
SELECT 'D37_STAGING_FIXTURE_PERIOD_ZERO_BALANCE_NOT_CERTIFIED_PASS' result;