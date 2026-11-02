\set ON_ERROR_STOP on

BEGIN;

DO $roles$
BEGIN
  BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END;
END
$roles$;

CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE public.tenants (
  id bigint PRIMARY KEY,
  name text NOT NULL,
  package_code text NOT NULL
);
CREATE TABLE public.tenant_owner_profiles (
  tenant_id bigint PRIMARY KEY REFERENCES public.tenants(id),
  full_name text,
  company_name text
);
CREATE TABLE public.tenant_subscriptions (
  id bigint PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES public.tenants(id),
  package_code text NOT NULL,
  status text NOT NULL,
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.payment_documentation_requests (
  id bigint PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES public.tenants(id),
  status text NOT NULL,
  submitted_at timestamptz NOT NULL,
  payment_amount numeric(14,2) NOT NULL
);

INSERT INTO public.tenants (id, name, package_code) VALUES
  (101, 'مساحة الشمال', 'basic'),
  (102, 'مساحة الوسط', 'advanced'),
  (103, 'مساحة بلا نشاط', 'vip');

INSERT INTO public.tenant_owner_profiles (tenant_id, full_name, company_name) VALUES
  (101, 'مالك الشمال', 'شركة الشمال'),
  (102, 'مالك الوسط', 'شركة الوسط');

INSERT INTO public.tenant_subscriptions (id, tenant_id, package_code, status, ends_at, created_at) VALUES
  (1, 101, 'basic', 'cancelled', now() - interval '20 days', now() - interval '2 months'),
  (2, 101, 'professional', 'active', now() + interval '30 days', now() - interval '1 day'),
  (3, 102, 'business', 'suspended', now() - interval '1 day', now() - interval '2 days');

INSERT INTO public.payment_documentation_requests (id, tenant_id, status, submitted_at, payment_amount) VALUES
  (1, 101, 'approved', now() - interval '1 day', 25.00),
  (2, 101, 'approved', now() - interval '3 days', 75.00),
  (3, 101, 'pending', now() - interval '2 days', 15.00),
  (4, 101, 'approved', now() - interval '40 days', 500.00),
  (5, 102, 'rejected', now() - interval '5 days', 30.00);

\ir ../migrations/20261101234455_powerhub_admin_activity_metrics.sql
\ir ../migrations/20261101235452_powerhub_admin_activity_metrics_date_filter.sql
\ir ../migrations/20261102090921_powerhub_admin_owner_activity_metrics.sql

-- Seed an older aggregate day as a service-independent fixture to check that
-- tracking_started_at remains the first observed day, outside the selected range.
INSERT INTO private.platform_tenant_search_metrics_daily (
  tenant_id, metric_day, search_count, no_result_search_count, result_count,
  first_searched_at, last_searched_at
) VALUES (
  101,
  ((pg_catalog.clock_timestamp() AT TIME ZONE 'Asia/Gaza')::date - 40),
  1, 0, 2, now() - interval '40 days', now() - interval '40 days'
);

DO $acl$
BEGIN
  IF has_function_privilege('anon', 'public.powerhub_record_tenant_search_metric(bigint,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.powerhub_record_tenant_search_metric(bigint,integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.powerhub_record_tenant_search_metric(bigint,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.powerhub_admin_get_owner_activity_metrics(date,date)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.powerhub_admin_get_owner_activity_metrics(date,date)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.powerhub_admin_get_owner_activity_metrics(date,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'OWNER_ACTIVITY_RPC_ACL_MISMATCH';
  END IF;

  IF has_table_privilege('anon', 'private.platform_tenant_search_metrics_daily', 'SELECT')
     OR has_table_privilege('authenticated', 'private.platform_tenant_search_metrics_daily', 'SELECT')
     OR has_table_privilege('service_role', 'private.platform_tenant_search_metrics_daily', 'SELECT') THEN
    RAISE EXCEPTION 'TENANT_SEARCH_METRICS_TABLE_EXPOSED';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS namespace_row ON namespace_row.oid = relation_row.relnamespace
    WHERE namespace_row.nspname = 'private'
      AND relation_row.relname = 'platform_tenant_search_metrics_daily'
      AND relation_row.relrowsecurity
      AND relation_row.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'TENANT_SEARCH_METRICS_RLS_NOT_FORCED';
  END IF;
END
$acl$;

SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);

SELECT public.powerhub_record_tenant_search_metric(101, 4);
SELECT public.powerhub_record_tenant_search_metric(101, 0);
SELECT public.powerhub_record_tenant_search_metric(102, 0);

DO $metrics$
DECLARE
  v_today date := (pg_catalog.clock_timestamp() AT TIME ZONE 'Asia/Gaza')::date;
  v_all jsonb;
  v_recent jsonb;
  v_owner_101 jsonb;
  v_owner_102 jsonb;
  v_owner_103 jsonb;
BEGIN
  v_all := public.powerhub_admin_get_owner_activity_metrics(NULL, NULL);

  IF (v_all->>'ownerCount')::bigint <> 3
     OR (v_all->>'ownerBreakdownTruncated')::boolean
     OR jsonb_array_length(v_all->'owners') <> 3 THEN
    RAISE EXCEPTION 'OWNER_ACTIVITY_TENANT_COUNT_MISMATCH: %', v_all;
  END IF;

  SELECT owner_row
  INTO v_owner_101
  FROM jsonb_array_elements(v_all->'owners') AS owner_rows(owner_row)
  WHERE owner_row->>'tenantId' = '101';

  SELECT owner_row
  INTO v_owner_102
  FROM jsonb_array_elements(v_all->'owners') AS owner_rows(owner_row)
  WHERE owner_row->>'tenantId' = '102';

  SELECT owner_row
  INTO v_owner_103
  FROM jsonb_array_elements(v_all->'owners') AS owner_rows(owner_row)
  WHERE owner_row->>'tenantId' = '103';

  IF v_owner_101 IS NULL
     OR v_owner_101->>'packageCode' <> 'professional'
     OR v_owner_101->>'subscriptionStatus' <> 'active'
     OR v_owner_101#>>'{payment,totalRequests}' <> '4'
     OR v_owner_101#>>'{payment,approvedRequests}' <> '3'
     OR v_owner_101#>>'{payment,pendingRequests}' <> '1'
     OR (v_owner_101#>>'{payment,approvedAmountInPeriod}')::numeric <> 600
     OR v_owner_101#>>'{search,searchesInPeriod}' <> '3'
     OR v_owner_101#>>'{search,noResultSearchesInPeriod}' <> '1'
     OR v_owner_101#>>'{search,resultHitsInPeriod}' <> '6'
     OR (v_owner_101#>>'{search,trackingStartedAt}')::date <> v_today - 40 THEN
    RAISE EXCEPTION 'TENANT_101_METRICS_MISMATCH: %', v_owner_101;
  END IF;

  IF v_owner_102 IS NULL
     OR v_owner_102->>'packageCode' <> 'business'
     OR v_owner_102->>'subscriptionStatus' <> 'suspended'
     OR v_owner_102#>>'{payment,totalRequests}' <> '1'
     OR v_owner_102#>>'{payment,rejectedRequests}' <> '1'
     OR (v_owner_102#>>'{payment,approvedAmountInPeriod}')::numeric <> 0
     OR v_owner_102#>>'{search,searchesInPeriod}' <> '1'
     OR v_owner_102#>>'{search,noResultSearchesInPeriod}' <> '1'
     OR v_owner_102#>>'{search,resultHitsInPeriod}' <> '0' THEN
    RAISE EXCEPTION 'TENANT_102_METRICS_MISMATCH: %', v_owner_102;
  END IF;

  IF v_owner_103 IS NULL
     OR v_owner_103->>'packageCode' <> 'vip'
     OR v_owner_103->>'ownerName' <> 'غير محدد'
     OR v_owner_103->>'subscriptionStatus' IS NOT NULL
     OR v_owner_103#>>'{payment,totalRequests}' <> '0'
     OR v_owner_103#>>'{search,searchesInPeriod}' <> '0' THEN
    RAISE EXCEPTION 'ZERO_ACTIVITY_TENANT_MISSING_OR_MISMATCH: %', v_owner_103;
  END IF;

  v_recent := public.powerhub_admin_get_owner_activity_metrics(v_today - 6, v_today);

  SELECT owner_row
  INTO v_owner_101
  FROM jsonb_array_elements(v_recent->'owners') AS owner_rows(owner_row)
  WHERE owner_row->>'tenantId' = '101';

  IF v_owner_101#>>'{payment,totalRequests}' <> '3'
     OR v_owner_101#>>'{payment,approvedRequests}' <> '2'
     OR (v_owner_101#>>'{payment,approvedAmountInPeriod}')::numeric <> 100
     OR v_owner_101#>>'{search,searchesInPeriod}' <> '2'
     OR v_owner_101#>>'{search,noResultSearchesInPeriod}' <> '1'
     OR (v_owner_101#>>'{search,trackingStartedAt}')::date <> v_today - 40
     OR (v_owner_101#>>'{search,lastSearchAt}') IS NULL THEN
    RAISE EXCEPTION 'OWNER_ACTIVITY_DATE_FILTER_MISMATCH: %', v_owner_101;
  END IF;
END
$metrics$;

DO $invalid_range$
DECLARE
  v_today date := (pg_catalog.clock_timestamp() AT TIME ZONE 'Asia/Gaza')::date;
BEGIN
  BEGIN
    PERFORM public.powerhub_admin_get_owner_activity_metrics(v_today, v_today - 1);
    RAISE EXCEPTION 'OWNER_ACTIVITY_INVALID_RANGE_ACCEPTED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'INVALID_OWNER_ACTIVITY_METRICS_DATE_RANGE' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.powerhub_admin_get_owner_activity_metrics(NULL, v_today);
    RAISE EXCEPTION 'OWNER_ACTIVITY_PARTIAL_RANGE_ACCEPTED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'INVALID_OWNER_ACTIVITY_METRICS_DATE_RANGE' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.powerhub_record_tenant_search_metric(101, 26);
    RAISE EXCEPTION 'OWNER_SEARCH_RESULT_LIMIT_NOT_ENFORCED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'INVALID_TENANT_SEARCH_METRICS' THEN RAISE; END IF;
  END;
END
$invalid_range$;

RESET ROLE;

DO $privacy$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'private'
      AND table_name = 'platform_tenant_search_metrics_daily'
      AND column_name IN (
        'query', 'search_query', 'search_term', 'phone', 'subscriber_name',
        'subscriber_phone', 'actor_user_id', 'user_id', 'result_labels'
      )
  ) THEN
    RAISE EXCEPTION 'TENANT_SEARCH_RAW_QUERY_OR_PII_COLUMN_PRESENT';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    JOIN pg_catalog.pg_class AS table_row ON table_row.oid = constraint_row.conrelid
    JOIN pg_catalog.pg_namespace AS schema_row ON schema_row.oid = table_row.relnamespace
    WHERE schema_row.nspname = 'private'
      AND table_row.relname = 'platform_tenant_search_metrics_daily'
      AND constraint_row.contype = 'p'
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid) = 'PRIMARY KEY (tenant_id, metric_day)'
  ) THEN
    RAISE EXCEPTION 'TENANT_SEARCH_DAILY_COMPOSITE_PRIMARY_KEY_MISSING';
  END IF;
END
$privacy$;

ROLLBACK;

SELECT 'POWERHUB_ADMIN_OWNER_ACTIVITY_METRICS_ASSERTIONS_PASSED' AS result;
