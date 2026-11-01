-- Aggregate platform search telemetry without storing search terms or returned PII.
CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE IF NOT EXISTS private.platform_admin_search_metrics_daily (
  metric_day date NOT NULL,
  search_count bigint NOT NULL DEFAULT 0 CHECK (search_count >= 0),
  no_result_search_count bigint NOT NULL DEFAULT 0 CHECK (no_result_search_count >= 0),
  result_count bigint NOT NULL DEFAULT 0 CHECK (result_count >= 0),
  generator_result_count bigint NOT NULL DEFAULT 0 CHECK (generator_result_count >= 0),
  subscriber_result_count bigint NOT NULL DEFAULT 0 CHECK (subscriber_result_count >= 0),
  owner_result_count bigint NOT NULL DEFAULT 0 CHECK (owner_result_count >= 0),
  first_searched_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  last_searched_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT platform_admin_search_metrics_daily_pk PRIMARY KEY (metric_day),
  CONSTRAINT platform_admin_search_metrics_counts_check
    CHECK (no_result_search_count <= search_count)
);

ALTER TABLE private.platform_admin_search_metrics_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.platform_admin_search_metrics_daily FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.platform_admin_search_metrics_daily FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private TO postgres;

CREATE OR REPLACE FUNCTION public.powerhub_admin_record_search_metric(
  p_result_count integer,
  p_generator_result_count integer,
  p_subscriber_result_count integer,
  p_owner_result_count integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_metric_day date := (pg_catalog.clock_timestamp() AT TIME ZONE 'Asia/Gaza')::date;
BEGIN
  IF coalesce(pg_catalog.current_setting('request.jwt.claim.role', true), '') <> 'service_role' THEN
    RAISE EXCEPTION 'INTERNAL_ONLY';
  END IF;

  IF p_result_count IS NULL OR p_result_count < 0 OR p_result_count > 30
     OR p_generator_result_count IS NULL OR p_generator_result_count < 0
     OR p_subscriber_result_count IS NULL OR p_subscriber_result_count < 0
     OR p_owner_result_count IS NULL OR p_owner_result_count < 0
     OR p_generator_result_count + p_subscriber_result_count + p_owner_result_count <> p_result_count THEN
    RAISE EXCEPTION 'INVALID_SEARCH_METRICS';
  END IF;

  INSERT INTO private.platform_admin_search_metrics_daily (
    metric_day, search_count, no_result_search_count,
    result_count, generator_result_count, subscriber_result_count,
    owner_result_count, first_searched_at, last_searched_at
  ) VALUES (
    v_metric_day, 1, CASE WHEN p_result_count = 0 THEN 1 ELSE 0 END,
    p_result_count, p_generator_result_count, p_subscriber_result_count,
    p_owner_result_count, pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
  )
  ON CONFLICT (metric_day) DO UPDATE SET
    search_count = private.platform_admin_search_metrics_daily.search_count + 1,
    no_result_search_count = private.platform_admin_search_metrics_daily.no_result_search_count
      + CASE WHEN EXCLUDED.no_result_search_count = 1 THEN 1 ELSE 0 END,
    result_count = private.platform_admin_search_metrics_daily.result_count + EXCLUDED.result_count,
    generator_result_count = private.platform_admin_search_metrics_daily.generator_result_count + EXCLUDED.generator_result_count,
    subscriber_result_count = private.platform_admin_search_metrics_daily.subscriber_result_count + EXCLUDED.subscriber_result_count,
    owner_result_count = private.platform_admin_search_metrics_daily.owner_result_count + EXCLUDED.owner_result_count,
    last_searched_at = EXCLUDED.last_searched_at;
END;
$function$;

CREATE OR REPLACE FUNCTION public.powerhub_admin_get_activity_metrics()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := (pg_catalog.clock_timestamp() AT TIME ZONE 'Asia/Gaza')::date;
  v_payment record;
  v_search record;
BEGIN
  IF coalesce(pg_catalog.current_setting('request.jwt.claim.role', true), '') <> 'service_role' THEN
    RAISE EXCEPTION 'INTERNAL_ONLY';
  END IF;

  SELECT
    count(*)::bigint AS total_requests,
    count(*) FILTER (WHERE status = 'pending')::bigint AS pending_requests,
    count(*) FILTER (WHERE status = 'approved')::bigint AS approved_requests,
    count(*) FILTER (WHERE status = 'rejected')::bigint AS rejected_requests,
    count(*) FILTER (WHERE submitted_at >= v_now - interval '7 days')::bigint AS requests_last_7_days,
    count(*) FILTER (WHERE submitted_at >= v_now - interval '30 days')::bigint AS requests_last_30_days,
    coalesce(sum(payment_amount) FILTER (WHERE status = 'approved'), 0)::double precision AS approved_amount_all_time,
    coalesce(sum(payment_amount) FILTER (WHERE status = 'approved' AND submitted_at >= v_now - interval '30 days'), 0)::double precision AS approved_amount_last_30_days,
    max(submitted_at) AS latest_submitted_at
  INTO v_payment
  FROM public.payment_documentation_requests;

  SELECT
    coalesce(sum(search_count), 0)::bigint AS searches_all_time,
    coalesce(sum(search_count) FILTER (WHERE metric_day >= v_today - 6), 0)::bigint AS searches_last_7_days,
    coalesce(sum(search_count) FILTER (WHERE metric_day >= v_today - 29), 0)::bigint AS searches_last_30_days,
    coalesce(sum(no_result_search_count) FILTER (WHERE metric_day >= v_today - 29), 0)::bigint AS no_result_searches_last_30_days,
    coalesce(sum(generator_result_count) FILTER (WHERE metric_day >= v_today - 29), 0)::bigint AS generator_result_hits_last_30_days,
    coalesce(sum(subscriber_result_count) FILTER (WHERE metric_day >= v_today - 29), 0)::bigint AS subscriber_result_hits_last_30_days,
    coalesce(sum(owner_result_count) FILTER (WHERE metric_day >= v_today - 29), 0)::bigint AS owner_result_hits_last_30_days,
    min(metric_day) AS tracking_started_at,
    max(last_searched_at) AS last_search_at
  INTO v_search
  FROM private.platform_admin_search_metrics_daily;

  RETURN pg_catalog.jsonb_build_object(
    'generatedAt', v_now,
    'paymentDocumentation', pg_catalog.jsonb_build_object(
      'totalRequests', v_payment.total_requests,
      'pendingRequests', v_payment.pending_requests,
      'approvedRequests', v_payment.approved_requests,
      'rejectedRequests', v_payment.rejected_requests,
      'requestsLast7Days', v_payment.requests_last_7_days,
      'requestsLast30Days', v_payment.requests_last_30_days,
      'approvedAmountAllTime', v_payment.approved_amount_all_time,
      'approvedAmountLast30Days', v_payment.approved_amount_last_30_days,
      'decidedRequests', v_payment.approved_requests + v_payment.rejected_requests,
      'approvalRatePercent', CASE
        WHEN v_payment.approved_requests + v_payment.rejected_requests = 0 THEN NULL
        ELSE round(100.0 * v_payment.approved_requests / (v_payment.approved_requests + v_payment.rejected_requests), 2)
      END,
      'latestSubmittedAt', v_payment.latest_submitted_at
    ),
    'search', pg_catalog.jsonb_build_object(
      'searchesAllTime', v_search.searches_all_time,
      'searchesLast7Days', v_search.searches_last_7_days,
      'searchesLast30Days', v_search.searches_last_30_days,
      'noResultSearchesLast30Days', v_search.no_result_searches_last_30_days,
      'noResultRatePercentLast30Days', CASE
        WHEN v_search.searches_last_30_days = 0 THEN NULL
        ELSE round(100.0 * v_search.no_result_searches_last_30_days / v_search.searches_last_30_days, 2)
      END,
      'generatorResultHitsLast30Days', v_search.generator_result_hits_last_30_days,
      'subscriberResultHitsLast30Days', v_search.subscriber_result_hits_last_30_days,
      'ownerResultHitsLast30Days', v_search.owner_result_hits_last_30_days,
      'trackingStartedAt', v_search.tracking_started_at,
      'lastSearchAt', v_search.last_search_at
    )
  );
END;
$function$;

ALTER FUNCTION public.powerhub_admin_record_search_metric(integer, integer, integer, integer) OWNER TO postgres;
ALTER FUNCTION public.powerhub_admin_get_activity_metrics() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.powerhub_admin_record_search_metric(integer, integer, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.powerhub_admin_get_activity_metrics() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_admin_record_search_metric(integer, integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_admin_get_activity_metrics() TO service_role;
