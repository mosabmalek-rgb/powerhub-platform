-- Add server-side date filtering to platform admin payment and search analytics.
-- Keep the existing no-argument RPC temporarily for deployed clients during rollout.
CREATE OR REPLACE FUNCTION public.powerhub_admin_get_activity_metrics(
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
  v_payment record;
  v_search record;
BEGIN
  IF coalesce(pg_catalog.current_setting('request.jwt.claim.role', true), '') <> 'service_role' THEN
    RAISE EXCEPTION 'INTERNAL_ONLY';
  END IF;

  IF (p_from_date IS NULL) <> (p_to_date IS NULL)
     OR (p_from_date IS NOT NULL AND p_to_date < p_from_date)
     OR (p_from_date IS NOT NULL AND p_to_date - p_from_date > 3650) THEN
    RAISE EXCEPTION 'INVALID_ACTIVITY_METRICS_DATE_RANGE';
  END IF;

  v_from_ts := CASE
    WHEN p_from_date IS NULL THEN NULL
    ELSE p_from_date::timestamp AT TIME ZONE 'Asia/Gaza'
  END;
  v_to_exclusive := CASE
    WHEN p_to_date IS NULL THEN NULL
    ELSE (p_to_date + 1)::timestamp AT TIME ZONE 'Asia/Gaza'
  END;

  -- Payment counts and approved amounts use the same submission-date cohort.
  SELECT
    count(*)::bigint AS total_requests,
    count(*) FILTER (WHERE status = 'pending')::bigint AS pending_requests,
    count(*) FILTER (WHERE status = 'approved')::bigint AS approved_requests,
    count(*) FILTER (WHERE status = 'rejected')::bigint AS rejected_requests,
    coalesce(sum(payment_amount) FILTER (WHERE status = 'approved'), 0)::double precision AS approved_amount,
    max(submitted_at) AS latest_submitted_at
  INTO v_payment
  FROM public.payment_documentation_requests
  WHERE (v_from_ts IS NULL OR submitted_at >= v_from_ts)
    AND (v_to_exclusive IS NULL OR submitted_at < v_to_exclusive);

  -- Search rows are daily buckets in Asia/Gaza, inclusive on both selected dates.
  SELECT
    coalesce(sum(search_count), 0)::bigint AS searches_in_period,
    coalesce(sum(no_result_search_count), 0)::bigint AS no_result_searches_in_period,
    coalesce(sum(generator_result_count), 0)::bigint AS generator_result_hits_in_period,
    coalesce(sum(subscriber_result_count), 0)::bigint AS subscriber_result_hits_in_period,
    coalesce(sum(owner_result_count), 0)::bigint AS owner_result_hits_in_period,
    min(metric_day) AS tracking_started_at,
    max(last_searched_at) AS last_search_at
  INTO v_search
  FROM private.platform_admin_search_metrics_daily
  WHERE (p_from_date IS NULL OR metric_day >= p_from_date)
    AND (p_to_date IS NULL OR metric_day <= p_to_date);

  RETURN pg_catalog.jsonb_build_object(
    'generatedAt', v_now,
    'period', pg_catalog.jsonb_build_object(
      'fromDate', p_from_date,
      'toDate', p_to_date
    ),
    'paymentDocumentation', pg_catalog.jsonb_build_object(
      'totalRequests', v_payment.total_requests,
      'pendingRequests', v_payment.pending_requests,
      'approvedRequests', v_payment.approved_requests,
      'rejectedRequests', v_payment.rejected_requests,
      'approvedAmountInPeriod', v_payment.approved_amount,
      'decidedRequests', v_payment.approved_requests + v_payment.rejected_requests,
      'approvalRatePercent', CASE
        WHEN v_payment.approved_requests + v_payment.rejected_requests = 0 THEN NULL
        ELSE round(100.0 * v_payment.approved_requests / (v_payment.approved_requests + v_payment.rejected_requests), 2)
      END,
      'latestSubmittedAt', v_payment.latest_submitted_at
    ),
    'search', pg_catalog.jsonb_build_object(
      'searchesInPeriod', v_search.searches_in_period,
      'noResultSearchesInPeriod', v_search.no_result_searches_in_period,
      'noResultRatePercentInPeriod', CASE
        WHEN v_search.searches_in_period = 0 THEN NULL
        ELSE round(100.0 * v_search.no_result_searches_in_period / v_search.searches_in_period, 2)
      END,
      'generatorResultHitsInPeriod', v_search.generator_result_hits_in_period,
      'subscriberResultHitsInPeriod', v_search.subscriber_result_hits_in_period,
      'ownerResultHitsInPeriod', v_search.owner_result_hits_in_period,
      'trackingStartedAt', v_search.tracking_started_at,
      'lastSearchAt', v_search.last_search_at
    )
  );
END;
$function$;

ALTER FUNCTION public.powerhub_admin_get_activity_metrics(date, date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.powerhub_admin_get_activity_metrics(date, date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_admin_get_activity_metrics(date, date) TO service_role;
