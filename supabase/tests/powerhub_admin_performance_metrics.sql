\set ON_ERROR_STOP on

DO $roles$
BEGIN
  BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END;
END
$roles$;

\ir ../migrations/20261101232628_powerhub_admin_performance_metrics.sql

DO $acl$
BEGIN
  IF has_function_privilege('anon','public.powerhub_admin_get_performance_metrics()','EXECUTE')
     OR has_function_privilege('authenticated','public.powerhub_admin_get_performance_metrics()','EXECUTE')
     OR NOT has_function_privilege('service_role','public.powerhub_admin_get_performance_metrics()','EXECUTE') THEN
    RAISE EXCEPTION 'PERFORMANCE_METRICS_RPC_ACL_MISMATCH';
  END IF;
END
$acl$;

SET ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',false);
DO $payload$
DECLARE
  v jsonb;
BEGIN
  v := public.powerhub_admin_get_performance_metrics();
  IF jsonb_typeof(v) <> 'object'
     OR jsonb_typeof(v->'database') <> 'object'
     OR jsonb_typeof(v->'connections') <> 'object'
     OR jsonb_typeof(v->'transactions') <> 'object'
     OR jsonb_typeof(v->'topTables') <> 'array'
     OR NOT (v ? 'generatedAt')
     OR NOT (v ? 'cacheHitRatioPercent') THEN
    RAISE EXCEPTION 'PERFORMANCE_METRICS_PAYLOAD_INVALID: %', v;
  END IF;
  IF (v->'database'->>'sizeBytes')::bigint < 0
     OR (v->'connections'->>'maxConnections')::integer <= 0
     OR jsonb_array_length(v->'topTables') > 10 THEN
    RAISE EXCEPTION 'PERFORMANCE_METRICS_VALUES_INVALID: %', v;
  END IF;
END
$payload$;
RESET ROLE;

SELECT 'POWERHUB_ADMIN_PERFORMANCE_METRICS_ASSERTIONS_PASSED' AS result;
