-- Harden the two offline generator RPCs with an empty search_path.
-- Their relations, composite types, and auth helper references are schema-qualified.
ALTER FUNCTION public.powerhub_sync_generator_create(bigint,text,text,text,numeric,text,text)
  SET search_path = '';
ALTER FUNCTION public.powerhub_sync_generator_update(bigint,bigint,text,numeric,numeric,numeric,text,timestamp with time zone,text)
  SET search_path = '';

-- pg_net is non-relocatable. Supabase documents drop/recreate to install it
-- outside public. Fail closed if the ephemeral request/response tables contain
-- data; never discard queued requests or responses during this migration.
CREATE SCHEMA IF NOT EXISTS extensions;

DO $pg_net_preflight$
DECLARE
  v_queue_count bigint;
  v_response_count bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_net') THEN
    RAISE EXCEPTION 'PG_NET_EXTENSION_NOT_INSTALLED';
  END IF;

  IF to_regclass('net.http_request_queue') IS NULL
     OR to_regclass('net._http_response') IS NULL THEN
    RAISE EXCEPTION 'PG_NET_EXPECTED_OBJECTS_MISSING';
  END IF;

  EXECUTE 'SELECT count(*) FROM net.http_request_queue' INTO v_queue_count;
  EXECUTE 'SELECT count(*) FROM net._http_response' INTO v_response_count;

  IF v_queue_count <> 0 OR v_response_count <> 0 THEN
    RAISE EXCEPTION 'PG_NET_NOT_EMPTY: pending_requests=%, stored_responses=%',
      v_queue_count,v_response_count;
  END IF;
END
$pg_net_preflight$;

DROP EXTENSION pg_net;
CREATE EXTENSION pg_net WITH SCHEMA extensions;

-- Remove only redundant duplicate indexes. Keep the sites index backing the
-- composite foreign keys; drop the unreferenced duplicate instead.
DO $duplicate_index_preflight$
DECLARE
  v_sites_extra text;
  v_sites_required text;
  v_template_keep text;
  v_template_drop text;
BEGIN
  SELECT pg_get_indexdef('public.sites_tenant_id_id_scope_uidx'::regclass)
    INTO v_sites_extra;
  SELECT pg_get_indexdef('public.sites_tenant_id_id_unique_idx'::regclass)
    INTO v_sites_required;

  IF v_sites_extra <> 'CREATE UNIQUE INDEX sites_tenant_id_id_scope_uidx ON public.sites USING btree (tenant_id, id)'
     OR v_sites_required <> 'CREATE UNIQUE INDEX sites_tenant_id_id_unique_idx ON public.sites USING btree (tenant_id, id)' THEN
    RAISE EXCEPTION 'SITES_DUPLICATE_INDEX_SHAPE_CHANGED';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conindid='public.sites_tenant_id_id_scope_uidx'::regclass
  ) THEN
    RAISE EXCEPTION 'SITES_DUPLICATE_INDEX_HAS_CONSTRAINT_DEPENDENCY';
  END IF;

  SELECT pg_get_indexdef('public.tenant_invoice_message_templat_tenant_id_channel_event_type_key'::regclass)
    INTO v_template_keep;
  SELECT pg_get_indexdef('public.tenant_invoice_message_templates_tenant_channel_event_type_key'::regclass)
    INTO v_template_drop;

  IF v_template_keep <> 'CREATE UNIQUE INDEX tenant_invoice_message_templat_tenant_id_channel_event_type_key ON public.tenant_invoice_message_templates USING btree (tenant_id, channel, event_type)'
     OR v_template_drop <> 'CREATE UNIQUE INDEX tenant_invoice_message_templates_tenant_channel_event_type_key ON public.tenant_invoice_message_templates USING btree (tenant_id, channel, event_type)' THEN
    RAISE EXCEPTION 'TEMPLATE_DUPLICATE_INDEX_SHAPE_CHANGED';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conindid='public.tenant_invoice_message_templates_tenant_channel_event_type_key'::regclass
  ) THEN
    RAISE EXCEPTION 'TEMPLATE_DUPLICATE_INDEX_HAS_CONSTRAINT_DEPENDENCY';
  END IF;
END
$duplicate_index_preflight$;

DROP INDEX public.sites_tenant_id_id_scope_uidx;
DROP INDEX public.tenant_invoice_message_templates_tenant_channel_event_type_key;

-- Fail the migration if any hardening postcondition is not met.
DO $postconditions$
DECLARE
  v_extension_schema text;
  v_queue_count bigint;
  v_response_count bigint;
BEGIN
  SELECT n.nspname INTO v_extension_schema
  FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace
  WHERE e.extname='pg_net';

  IF v_extension_schema <> 'extensions' THEN
    RAISE EXCEPTION 'PG_NET_EXTENSION_SCHEMA_NOT_HARDENED: %',v_extension_schema;
  END IF;

  IF (SELECT proconfig FROM pg_proc
      WHERE oid='public.powerhub_sync_generator_create(bigint,text,text,text,numeric,text,text)'::regprocedure)
       IS DISTINCT FROM ARRAY['search_path=""']::text[] THEN
    RAISE EXCEPTION 'GENERATOR_CREATE_SEARCH_PATH_NOT_EMPTY';
  END IF;

  IF (SELECT proconfig FROM pg_proc
      WHERE oid='public.powerhub_sync_generator_update(bigint,bigint,text,numeric,numeric,numeric,text,timestamp with time zone,text)'::regprocedure)
       IS DISTINCT FROM ARRAY['search_path=""']::text[] THEN
    RAISE EXCEPTION 'GENERATOR_UPDATE_SEARCH_PATH_NOT_EMPTY';
  END IF;

  IF to_regclass('public.sites_tenant_id_id_scope_uidx') IS NOT NULL
     OR to_regclass('public.tenant_invoice_message_templates_tenant_channel_event_type_key') IS NOT NULL THEN
    RAISE EXCEPTION 'REDUNDANT_INDEX_REMAINS';
  END IF;

  EXECUTE 'SELECT count(*) FROM net.http_request_queue' INTO v_queue_count;
  EXECUTE 'SELECT count(*) FROM net._http_response' INTO v_response_count;
  IF v_queue_count <> 0 OR v_response_count <> 0 THEN
    RAISE EXCEPTION 'PG_NET_QUEUE_OR_RESPONSES_UNEXPECTED_AFTER_REINSTALL';
  END IF;
END
$postconditions$;
