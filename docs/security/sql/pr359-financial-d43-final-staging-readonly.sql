-- D43: Staging-only final D engineering invariant audit. READ ONLY.
-- Verifies exact migration identity, GL integrity, temporal fixture isolation,
-- owner-to-owner scope snapshots, and direct financial-RPC grants.
-- This is NOT an accounting certification and NOT an HTTPS non-owner role test.
BEGIN READ ONLY;
SET LOCAL statement_timeout='120000ms';

DO $d43$
DECLARE
  v_owner_a bigint;
  v_owner_b bigint;
  v_aa jsonb;
  v_ab jsonb;
  v_ba jsonb;
  v_bb jsonb;
  v_oct jsonb;
  v_nov jsonb;
  v_bad bigint;
BEGIN
  -- Refuse to interpret an arbitrary environment as the named test baseline.
  IF NOT EXISTS(
    SELECT 1 FROM public.sites WHERE id=9000000000099 AND tenant_id=1
    AND name='STAGING Finance A Isolated Acceptance (TEST ONLY)'
  ) OR NOT EXISTS(
    SELECT 1 FROM public.sites WHERE id=13 AND tenant_id=13
  ) THEN
    RAISE EXCEPTION 'D43_STAGING_ISOLATED_FIXTURE_NOT_FOUND';
  END IF;

  IF (SELECT count(*) FROM public.financial_gl_entries)<>27
    OR (SELECT count(*) FROM public.financial_gl_lines)<>55
    OR (SELECT count(*) FROM public.account_transactions)<>361009
    OR (SELECT count(*) FROM public.financial_gl_opening_evidence)<>0
    OR (SELECT count(*) FROM public.company_account_movement_operations)<>0
  THEN
    RAISE EXCEPTION 'D43_PRELAUNCH_FINANCIAL_BASELINE_DRIFT';
  END IF;

  -- Every installed D-series migration must match Git by version AND name.
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('20261114120000','powerhub_financial_d3_source_period_guard'),
      ('20261114130000','powerhub_financial_d4_operational_source_period_guard'),
      ('20261114191500','powerhub_financial_d5_inventory_item_accrual_classification_guard'),
      ('20261114203000','powerhub_financial_d6_versioned_accrual_fingerprint'),
      ('20261115110000','powerhub_financial_d10_supplier_return_cash_and_valuation'),
      ('20261115133000','powerhub_financial_d11_supplier_refund_subledger_cash_reconciliation'),
      ('20261115160000','powerhub_financial_d12_supplier_correction_cash_subledger'),
      ('20261115174500','powerhub_financial_d26_tenant_company_accounts_preliminary_reconciliation'),
      ('20261115190409','powerhub_financial_d34_service_replay_after_prelaunch_expiry'),
      ('20261115193000','powerhub_financial_d27_transfer_operation_pair_provenance'),
      ('20261115230000','powerhub_financial_d28_cash_source_gl_chain'),
      ('20261115233000','powerhub_financial_d29_fixture_evidence_partition'),
      ('20261116001000','powerhub_financial_d36_trial_balance_postgrest_transaction_mode')
    ) expected(version,name)
    LEFT JOIN supabase_migrations.schema_migrations m ON m.version=expected.version
    WHERE m.version IS NULL OR m.name IS DISTINCT FROM expected.name
  ) THEN RAISE EXCEPTION 'D43_MIGRATION_VERSION_NAME_DRIFT'; END IF;

  SELECT count(*) INTO v_bad FROM public.financial_gl_entries e
  LEFT JOIN LATERAL (
    SELECT count(*) n,
      coalesce(sum(l.amount) FILTER(WHERE l.side='debit'),0) debit,
      coalesce(sum(l.amount) FILTER(WHERE l.side='credit'),0) credit,
      count(*) FILTER(WHERE l.tenant_id<>e.tenant_id OR l.site_id<>e.site_id) foreign_lines
    FROM public.financial_gl_lines l WHERE l.entry_id=e.id
  ) l ON true
  WHERE l.n<2 OR l.debit IS DISTINCT FROM l.credit
    OR l.debit<=0 OR l.foreign_lines>0;
  IF v_bad<>0 THEN RAISE EXCEPTION 'D43_UNBALANCED_OR_UNSCOPED_GL_%',v_bad; END IF;

  IF EXISTS (
    WITH cuts AS (SELECT unnest(ARRAY['2026-01','2026-10','2026-11']) period),
      accounts AS (SELECT unnest(ARRAY['1010','3100']) account_code)
    SELECT 1 FROM cuts c CROSS JOIN accounts a
    LEFT JOIN public.financial_gl_entries e
      ON e.tenant_id=1 AND e.site_id=9000000000099 AND e.period<=c.period
    LEFT JOIN public.financial_gl_lines l
      ON l.entry_id=e.id AND l.account_code=a.account_code
    GROUP BY c.period,a.account_code
    HAVING coalesce(sum(CASE l.side
      WHEN 'debit' THEN l.amount WHEN 'credit' THEN -l.amount ELSE 0 END),0)<>0
  ) THEN RAISE EXCEPTION 'D43_TEMPORAL_FIXTURE_OUT_OF_BALANCE'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.financial_gl_entries e WHERE e.id=890
      AND e.reverses_entry_id=168 AND e.tenant_id=1 AND e.site_id=9000000000099
  ) OR (SELECT count(*) FROM public.financial_gl_entries
    WHERE operation_key IN ('gl:prelaunch:opening19:jan-correct:v1',
                            'gl:prelaunch:opening19:nov-restore:v1'))<>2
  THEN RAISE EXCEPTION 'D43_FIXTURE_PROVENANCE_DRIFT'; END IF;

  v_oct:=public.powerhub_financial_gl_opening_evidence_status(1,9000000000099,'2026-10');
  v_nov:=public.powerhub_financial_gl_opening_evidence_status(1,9000000000099,'2026-11');
  IF v_oct->>'status'<>'EVIDENCE_MISSING_OR_UNREVIEWED'
    OR v_nov->>'status'<>'EVIDENCE_MISSING_OR_UNREVIEWED'
    OR v_oct->>'isIndependentlyReconciled'<>'false'
    OR v_nov->>'isIndependentlyReconciled'<>'false'
  THEN RAISE EXCEPTION 'D43_FALSE_DOCUMENTARY_CERTIFICATION'; END IF;

  -- Even direct database EXECUTE must be server-only. The API still has its
  -- independent authenticated role, capability, tenant and site checks.
  SELECT count(*) INTO v_bad FROM pg_proc p JOIN pg_namespace ns
    ON ns.oid=p.pronamespace
  WHERE ns.nspname='public' AND p.proname IN (
    'powerhub_financial_gl_trial_balance',
    'powerhub_financial_gl_site_statements',
    'powerhub_financial_gl_subledger_reconciliation',
    'powerhub_financial_gl_company_movement_audit',
    'powerhub_financial_accrual_month_statement',
    'powerhub_site_access_snapshot'
  ) AND p.prosecdef=false
    AND NOT has_function_privilege('anon',p.oid,'EXECUTE')
    AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')
    AND has_function_privilege('service_role',p.oid,'EXECUTE');
  IF v_bad<>6 THEN RAISE EXCEPTION 'D43_FINANCIAL_RPC_DIRECT_ACL_DRIFT_%',v_bad; END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid=
    'public.powerhub_financial_gl_trial_balance(bigint,bigint,text)'::regprocedure)<>'v'
  THEN RAISE EXCEPTION 'D43_D36_POSTGREST_VOLATILITY_DRIFT'; END IF;

  SELECT user_id INTO v_owner_a FROM public.tenant_members
    WHERE tenant_id=1 AND role='owner' AND is_active
      AND membership_status='active' AND (expires_at IS NULL OR expires_at>now())
    ORDER BY user_id LIMIT 1;
  SELECT user_id INTO v_owner_b FROM public.tenant_members
    WHERE tenant_id=13 AND role='owner' AND is_active
      AND membership_status='active' AND (expires_at IS NULL OR expires_at>now())
    ORDER BY user_id LIMIT 1;
  IF v_owner_a IS NULL OR v_owner_b IS NULL THEN
    RAISE EXCEPTION 'D43_OWNER_SCOPE_TEST_IDENTITIES_MISSING';
  END IF;

  v_aa:=public.powerhub_site_access_snapshot(v_owner_a,1);
  v_ab:=public.powerhub_site_access_snapshot(v_owner_a,13);
  v_ba:=public.powerhub_site_access_snapshot(v_owner_b,1);
  v_bb:=public.powerhub_site_access_snapshot(v_owner_b,13);

  IF (v_aa->'site'->>'tenant_id')::bigint<>1
    OR (v_bb->'site'->>'tenant_id')::bigint<>13
    OR v_aa->'membership'='null'::jsonb
    OR v_bb->'membership'='null'::jsonb
    OR v_ab->'membership'<>'null'::jsonb
    OR v_ba->'membership'<>'null'::jsonb
    OR jsonb_array_length(v_ab->'staff_profiles')<>0
    OR jsonb_array_length(v_ba->'staff_profiles')<>0
  THEN RAISE EXCEPTION 'D43_TENANT_SITE_MEMBERSHIP_SCOPE_DRIFT'; END IF;
END $d43$;

ROLLBACK;
SELECT 'D43_PRELAUNCH_ENGINEERING_STAGING_READONLY_SCOPED_PASS_NOT_CERTIFIED' AS result;
