-- A20: fail-closed cash-flow reporting while the known Staging fixture is
-- awaiting independently reviewed quarantine. Never delete/relabel source
-- movements, change company-account balances, or disable Delta triggers.
-- Only the exactly fingerprint-verified cohort can be excluded from flows.
-- For other tenants/sites and periods without this cohort, preserve raw data.
ALTER FUNCTION public.powerhub_financial_period_cash_flow(
  bigint,bigint,timestamptz,timestamptz
) RENAME TO powerhub_financial_period_cash_flow_raw;
REVOKE ALL ON FUNCTION public.powerhub_financial_period_cash_flow_raw(
  bigint,bigint,timestamptz,timestamptz
) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_period_cash_flow_raw(
  bigint,bigint,timestamptz,timestamptz
) TO service_role;

CREATE OR REPLACE FUNCTION public.powerhub_financial_period_cash_flow(
  p_tenant_id bigint,
  p_site_id bigint,
  p_period_start timestamptz,
  p_period_end_exclusive timestamptz
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp
AS $cashflow$
DECLARE
  v_result jsonb;
  v_verified jsonb;
  v_has_fixture boolean;
  v_fixture_in numeric;
  v_fixture_out numeric;
  v_fixture_count bigint;
  v_cash_in numeric;
  v_cash_out numeric;
  v_net numeric;
  v_count bigint;
BEGIN
  IF p_period_start IS NULL OR p_period_end_exclusive IS NULL
     OR p_period_start >= p_period_end_exclusive THEN
    RAISE EXCEPTION 'GL_CASHFLOW_INVALID_PERIOD' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.sites s
    WHERE s.id=p_site_id AND s.tenant_id=p_tenant_id AND s.status<>'archived'
  ) THEN
    RAISE EXCEPTION 'GL_CASHFLOW_SITE_SCOPE_INVALID' USING ERRCODE='22023';
  END IF;
  v_result := public.powerhub_financial_period_cash_flow_raw(
    p_tenant_id,p_site_id,p_period_start,p_period_end_exclusive
  );
  IF v_result IS NULL OR (v_result->>'scopeSiteId')::bigint IS DISTINCT FROM p_site_id THEN
    RAISE EXCEPTION 'GL_CASHFLOW_INVALID_SOURCE_RESULT' USING ERRCODE='22023';
  END IF;
  v_cash_in := (v_result->>'externalCashIn')::numeric;
  v_cash_out := (v_result->>'externalCashOut')::numeric;
  v_net := (v_result->>'netCashFlow')::numeric;
  v_count := (v_result->>'transactionCount')::bigint;
  IF v_cash_in IS NULL OR v_cash_out IS NULL OR v_net IS NULL OR v_count IS NULL
     OR v_count < 0 OR v_cash_in < 0 OR v_cash_out < 0
     OR abs(v_cash_in-v_cash_out-v_net)>0.01 THEN
    RAISE EXCEPTION 'GL_CASHFLOW_RAW_TOTALS_INVALID' USING ERRCODE='22023';
  END IF;

  -- Do not use a prefix-only exclusion: first detect whether the queried
  -- interval actually contains part of the one known Staging fixture.
  IF p_tenant_id=1 AND p_site_id=1 THEN
    SELECT EXISTS(
      SELECT 1 FROM public.account_transactions t
      WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id
        AND t.occurred_at>=p_period_start
        AND t.occurred_at<p_period_end_exclusive
        AND t.reference_no LIKE 'STG-PERF-%'
    ) INTO v_has_fixture;
    IF v_has_fixture THEN
      -- Full 250k-row hash, account-level zero balance, and absence of
      -- business links must STILL match a separately reviewed manifest.
      v_verified:=public.powerhub_financial_gl_verify_staging_fixture(
        p_tenant_id,p_site_id
      );
      IF (v_verified->>'verified')::boolean IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'GL_CASHFLOW_FIXTURE_REVIEW_REQUIRED: %',
          coalesce(v_verified->>'reason','UNKNOWN')
          USING ERRCODE='23514';
      END IF;

      -- A selected date range can contain only a subset of the cohort.
      -- Subtract ONLY that precisely scoped portion after full verification.
      SELECT
        coalesce(sum(t.amount) FILTER(
          WHERE t.transaction_type IN ('collection','deposit')),0),
        coalesce(sum(t.amount) FILTER(
          WHERE t.transaction_type='withdrawal'),0),
        count(*) FILTER(
          WHERE t.transaction_type IN ('collection','deposit','withdrawal'))
      INTO v_fixture_in,v_fixture_out,v_fixture_count
      FROM public.account_transactions t
      WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id
        AND t.occurred_at>=p_period_start
        AND t.occurred_at<p_period_end_exclusive
        AND t.reference_no LIKE 'STG-PERF-%';

      IF v_fixture_count<=0 OR v_cash_in<v_fixture_in
         OR v_cash_out<v_fixture_out OR v_count<v_fixture_count THEN
        RAISE EXCEPTION 'GL_CASHFLOW_FIXTURE_SUBTRACTION_INVALID'
          USING ERRCODE='23514';
      END IF;
      v_result:=v_result || jsonb_build_object(
        'externalCashIn',v_cash_in-v_fixture_in,
        'externalCashOut',v_cash_out-v_fixture_out,
        'netCashFlow',v_net-v_fixture_in+v_fixture_out,
        'transactionCount',v_count-v_fixture_count,
        'fixtureExcludedMovements',v_fixture_count,
        'fixtureTreatment','EXACT_REVIEWED_COHORT_EXCLUDED',
        'fixtureEvidenceSha256',v_verified->>'sha256'
      );
    END IF;
  END IF;

  RETURN v_result || jsonb_build_object(
    'fixtureExcludedMovements',
      coalesce((v_result->>'fixtureExcludedMovements')::bigint,0),
    'fixtureTreatment',
      coalesce(v_result->>'fixtureTreatment','NO_FIXTURE_IN_SCOPED_PERIOD'),
    'accountingCertification','NOT_CERTIFIED'
  );
END;
$cashflow$;

REVOKE ALL ON FUNCTION public.powerhub_financial_period_cash_flow(
  bigint,bigint,timestamptz,timestamptz
) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_period_cash_flow(
  bigint,bigint,timestamptz,timestamptz
) TO service_role;
NOTIFY pgrst,'reload schema';
