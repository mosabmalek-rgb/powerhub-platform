-- Per-owner payment-documentation and subscriber-search analytics.
-- Only aggregate counters are stored; search terms, actor identifiers, and result PII are never persisted.

CREATE TABLE IF NOT EXISTS private.platform_tenant_search_metrics_daily (
  tenant_id bigint NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  metric_day date NOT NULL,
  search_count bigint NOT NULL DEFAULT 0 CHECK (search_count >= 0),
  no_result_search_count bigint NOT NULL DEFAULT 0 CHECK (no_result_search_count >= 0),
  result_count bigint NOT NULL DEFAULT 0 CHECK (result_count >= 0),
  first_searched_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  last_searched_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT platform_tenant_search_metrics_daily_pk PRIMARY KEY (tenant_id, metric_day),
  CONSTRAINT platform_tenant_search_metrics_counts_check
    CHECK (no_result_search_count <= search_count)
);

ALTER TABLE private.platform_tenant_search_metrics_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.platform_tenant_search_metrics_daily FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.platform_tenant_search_metrics_daily FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE private.platform_tenant_search_metrics_daily IS
  'Daily per-tenant subscriber directory search counters only. No raw query text, result labels, phones, or actor identifiers.';

CREATE OR REPLACE FUNCTION public.powerhub_record_tenant_search_metric(
  p_tenant_id bigint,
  p_result_count integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_metric_day date := (pg_catalog.clock_timestamp() AT TIME ZONE 'Asia/Gaza')::date;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF coalesce(pg_catalog.current_setting('request.jwt.claim.role', true), '') <> 'service_role' THEN
    RAISE EXCEPTION 'INTERNAL_ONLY';
  END IF;

  IF p_tenant_id IS NULL OR p_tenant_id <= 0
     OR p_result_count IS NULL OR p_result_count < 0 OR p_result_count > 25 THEN
    RAISE EXCEPTION 'INVALID_TENANT_SEARCH_METRICS';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.tenants AS tenant WHERE tenant.id = p_tenant_id) THEN
    RAISE EXCEPTION 'TENANT_NOT_FOUND';
  END IF;

  INSERT INTO private.platform_tenant_search_metrics_daily AS metrics (
    tenant_id, metric_day, search_count, no_result_search_count, result_count,
    first_searched_at, last_searched_at
  ) VALUES (
    p_tenant_id, v_metric_day, 1,
    CASE WHEN p_result_count = 0 THEN 1 ELSE 0 END,
    p_result_count, v_now, v_now
  )
  ON CONFLICT (tenant_id, metric_day) DO UPDATE SET
    search_count = metrics.search_count + 1,
    no_result_search_count = metrics.no_result_search_count
      + CASE WHEN EXCLUDED.no_result_search_count = 1 THEN 1 ELSE 0 END,
    result_count = metrics.result_count + EXCLUDED.result_count,
    last_searched_at = EXCLUDED.last_searched_at;
END;
$function$;

CREATE OR REPLACE FUNCTION public.powerhub_admin_get_owner_activity_metrics(
  p_from_date date,
  p_to_date date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_from_ts timestamptz;
  v_to_exclusive timestamptz;
  v_owner_count bigint := 0;
  v_owners jsonb := '[]'::jsonb;
BEGIN
  IF coalesce(pg_catalog.current_setting('request.jwt.claim.role', true), '') <> 'service_role' THEN
    RAISE EXCEPTION 'INTERNAL_ONLY';
  END IF;

  IF (p_from_date IS NULL) <> (p_to_date IS NULL)
     OR (p_from_date IS NOT NULL AND p_to_date < p_from_date)
     OR (p_from_date IS NOT NULL AND p_to_date - p_from_date > 3650) THEN
    RAISE EXCEPTION 'INVALID_OWNER_ACTIVITY_METRICS_DATE_RANGE';
  END IF;

  v_from_ts := CASE
    WHEN p_from_date IS NULL THEN NULL
    ELSE p_from_date::timestamp AT TIME ZONE 'Asia/Gaza'
  END;
  v_to_exclusive := CASE
    WHEN p_to_date IS NULL THEN NULL
    ELSE (p_to_date + 1)::timestamp AT TIME ZONE 'Asia/Gaza'
  END;

  SELECT count(*)::bigint
  INTO v_owner_count
  FROM public.tenants;

  WITH payment_stats AS (
    SELECT
      request.tenant_id,
      count(*)::bigint AS total_requests,
      count(*) FILTER (WHERE request.status = 'pending')::bigint AS pending_requests,
      count(*) FILTER (WHERE request.status = 'approved')::bigint AS approved_requests,
      count(*) FILTER (WHERE request.status = 'rejected')::bigint AS rejected_requests,
      coalesce(sum(request.payment_amount) FILTER (WHERE request.status = 'approved'), 0)::numeric AS approved_amount
    FROM public.payment_documentation_requests AS request
    WHERE (v_from_ts IS NULL OR request.submitted_at >= v_from_ts)
      AND (v_to_exclusive IS NULL OR request.submitted_at < v_to_exclusive)
    GROUP BY request.tenant_id
  ),
  search_stats AS (
    SELECT
      metrics.tenant_id,
      coalesce(sum(metrics.search_count), 0)::bigint AS searches_in_period,
      coalesce(sum(metrics.no_result_search_count), 0)::bigint AS no_result_searches_in_period,
      coalesce(sum(metrics.result_count), 0)::bigint AS result_hits_in_period,
      max(metrics.last_searched_at) AS last_search_at
    FROM private.platform_tenant_search_metrics_daily AS metrics
    WHERE (p_from_date IS NULL OR metrics.metric_day >= p_from_date)
      AND (p_to_date IS NULL OR metrics.metric_day <= p_to_date)
    GROUP BY metrics.tenant_id
  ),
  tracking_stats AS (
    SELECT
      metrics.tenant_id,
      min(metrics.metric_day) AS tracking_started_at
    FROM private.platform_tenant_search_metrics_daily AS metrics
    GROUP BY metrics.tenant_id
  ),
  owner_rows AS (
    SELECT
      tenant.id AS tenant_id,
      tenant.name AS tenant_name,
      coalesce(nullif(pg_catalog.btrim(owner.full_name), ''), 'غير محدد') AS owner_name,
      nullif(pg_catalog.btrim(owner.company_name), '') AS company_name,
      coalesce(subscription.package_code, tenant.package_code) AS package_code,
      subscription.status AS subscription_status,
      coalesce(payment.total_requests, 0)::bigint AS total_requests,
      coalesce(payment.pending_requests, 0)::bigint AS pending_requests,
      coalesce(payment.approved_requests, 0)::bigint AS approved_requests,
      coalesce(payment.rejected_requests, 0)::bigint AS rejected_requests,
      coalesce(payment.approved_amount, 0)::numeric AS approved_amount,
      coalesce(search.searches_in_period, 0)::bigint AS searches_in_period,
      coalesce(search.no_result_searches_in_period, 0)::bigint AS no_result_searches_in_period,
      coalesce(search.result_hits_in_period, 0)::bigint AS result_hits_in_period,
      tracking.tracking_started_at,
      search.last_search_at
    FROM public.tenants AS tenant
    LEFT JOIN public.tenant_owner_profiles AS owner
      ON owner.tenant_id = tenant.id
    LEFT JOIN LATERAL (
      SELECT subscription_row.package_code, subscription_row.status
      FROM public.tenant_subscriptions AS subscription_row
      WHERE subscription_row.tenant_id = tenant.id
      ORDER BY
        CASE
          WHEN subscription_row.status IN ('trial', 'active')
            AND (subscription_row.ends_at IS NULL OR subscription_row.ends_at > v_now)
          THEN 0 ELSE 1
        END,
        subscription_row.created_at DESC NULLS LAST,
        subscription_row.id DESC
      LIMIT 1
    ) AS subscription ON true
    LEFT JOIN payment_stats AS payment
      ON payment.tenant_id = tenant.id
    LEFT JOIN search_stats AS search
      ON search.tenant_id = tenant.id
    LEFT JOIN tracking_stats AS tracking
      ON tracking.tenant_id = tenant.id
  )
  SELECT coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'tenantId', owner_rows.tenant_id,
        'tenantName', owner_rows.tenant_name,
        'ownerName', owner_rows.owner_name,
        'companyName', owner_rows.company_name,
        'packageCode', owner_rows.package_code,
        'subscriptionStatus', owner_rows.subscription_status,
        'payment', pg_catalog.jsonb_build_object(
          'totalRequests', owner_rows.total_requests,
          'pendingRequests', owner_rows.pending_requests,
          'approvedRequests', owner_rows.approved_requests,
          'rejectedRequests', owner_rows.rejected_requests,
          'approvedAmountInPeriod', owner_rows.approved_amount,
          'decidedRequests', owner_rows.approved_requests + owner_rows.rejected_requests,
          'approvalRatePercent', CASE
            WHEN owner_rows.approved_requests + owner_rows.rejected_requests = 0 THEN NULL
            ELSE pg_catalog.round(
              100.0 * owner_rows.approved_requests
              / (owner_rows.approved_requests + owner_rows.rejected_requests),
              2
            )
          END
        ),
        'search', pg_catalog.jsonb_build_object(
          'searchesInPeriod', owner_rows.searches_in_period,
          'noResultSearchesInPeriod', owner_rows.no_result_searches_in_period,
          'noResultRatePercentInPeriod', CASE
            WHEN owner_rows.searches_in_period = 0 THEN NULL
            ELSE pg_catalog.round(
              100.0 * owner_rows.no_result_searches_in_period
              / owner_rows.searches_in_period,
              2
            )
          END,
          'resultHitsInPeriod', owner_rows.result_hits_in_period,
          'trackingStartedAt', owner_rows.tracking_started_at,
          'lastSearchAt', owner_rows.last_search_at
        )
      )
      ORDER BY
        owner_rows.total_requests + owner_rows.searches_in_period DESC,
        owner_rows.tenant_name ASC,
        owner_rows.tenant_id ASC
    ),
    '[]'::jsonb
  )
  INTO v_owners
  FROM (
    SELECT *
    FROM owner_rows
    ORDER BY
      total_requests + searches_in_period DESC,
      tenant_name ASC,
      tenant_id ASC
    LIMIT 500
  ) AS owner_rows;

  RETURN pg_catalog.jsonb_build_object(
    'generatedAt', v_now,
    'period', pg_catalog.jsonb_build_object(
      'fromDate', p_from_date,
      'toDate', p_to_date
    ),
    'ownerCount', v_owner_count,
    'ownerBreakdownTruncated', v_owner_count > 500,
    'owners', v_owners
  );
END;
$function$;

ALTER FUNCTION public.powerhub_record_tenant_search_metric(bigint, integer) OWNER TO postgres;
ALTER FUNCTION public.powerhub_admin_get_owner_activity_metrics(date, date) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.powerhub_record_tenant_search_metric(bigint, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.powerhub_admin_get_owner_activity_metrics(date, date) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.powerhub_record_tenant_search_metric(bigint, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_admin_get_owner_activity_metrics(date, date) TO service_role;
