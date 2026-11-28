-- Read-only platform-admin database telemetry. No application rows are read or changed.
CREATE OR REPLACE FUNCTION public.powerhub_admin_get_performance_metrics()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_db record;
  v_connections record;
  v_transactions record;
  v_tables jsonb;
  v_max_connections integer;
BEGIN
  IF coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' THEN
    RAISE EXCEPTION 'INTERNAL_ONLY';
  END IF;

  SELECT
    d.datname,
    pg_catalog.pg_database_size(d.datname)::bigint AS size_bytes,
    s.blks_hit,
    s.blks_read,
    s.xact_commit,
    s.xact_rollback,
    s.deadlocks,
    s.temp_files,
    s.temp_bytes,
    s.stats_reset
  INTO v_db
  FROM pg_catalog.pg_database d
  JOIN pg_catalog.pg_stat_database s ON s.datid = d.oid
  WHERE d.datname = current_database();

  SELECT
    count(*) FILTER (WHERE backend_type = 'client backend')::integer AS client_backends,
    count(*) FILTER (WHERE backend_type = 'client backend' AND state = 'active')::integer AS active,
    count(*) FILTER (WHERE backend_type = 'client backend' AND state = 'idle in transaction')::integer AS idle_in_transaction
  INTO v_connections
  FROM pg_catalog.pg_stat_activity
  WHERE datname = current_database();

  SELECT setting::integer INTO v_max_connections
  FROM pg_catalog.pg_settings WHERE name = 'max_connections';

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'schemaName', schema_name,
        'tableName', table_name,
        'totalBytes', total_bytes,
        'indexBytes', index_bytes,
        'liveRowsEstimate', live_rows,
        'deadRowsEstimate', dead_rows
      ) ORDER BY total_bytes DESC
    ),
    '[]'::jsonb
  )
  INTO v_tables
  FROM (
    SELECT
      schemaname AS schema_name,
      relname AS table_name,
      pg_catalog.pg_total_relation_size(relid)::bigint AS total_bytes,
      pg_catalog.pg_indexes_size(relid)::bigint AS index_bytes,
      greatest(n_live_tup, 0)::bigint AS live_rows,
      greatest(n_dead_tup, 0)::bigint AS dead_rows
    FROM pg_catalog.pg_stat_user_tables
    WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY pg_catalog.pg_total_relation_size(relid) DESC
    LIMIT 10
  ) top_tables;

  RETURN jsonb_build_object(
    'generatedAt', pg_catalog.clock_timestamp(),
    'database', jsonb_build_object(
      'name', v_db.datname,
      'sizeBytes', v_db.size_bytes,
      'sizeMiB', round(v_db.size_bytes::numeric / 1048576, 2)
    ),
    'connections', jsonb_build_object(
      'clientBackends', v_connections.client_backends,
      'active', v_connections.active,
      'idleInTransaction', v_connections.idle_in_transaction,
      'maxConnections', v_max_connections
    ),
    'cacheHitRatioPercent', CASE
      WHEN coalesce(v_db.blks_hit, 0) + coalesce(v_db.blks_read, 0) = 0 THEN NULL
      ELSE round(100.0 * v_db.blks_hit / (v_db.blks_hit + v_db.blks_read), 2)
    END,
    'transactions', jsonb_build_object(
      'commits', v_db.xact_commit,
      'rollbacks', v_db.xact_rollback,
      'deadlocks', v_db.deadlocks,
      'tempFiles', v_db.temp_files,
      'tempBytes', v_db.temp_bytes,
      'statsResetAt', v_db.stats_reset
    ),
    'topTables', v_tables
  );
END;
$function$;

ALTER FUNCTION public.powerhub_admin_get_performance_metrics() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.powerhub_admin_get_performance_metrics() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_admin_get_performance_metrics() TO service_role;
