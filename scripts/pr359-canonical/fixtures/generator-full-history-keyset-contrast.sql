-- PR359 CB-A. Synthetic complete-history keyset contrast, NOT deployable SQL.
-- Runs only in the disposable PostgreSQL container with --network none,
-- after the bounded generator-first candidate and historical cap fixture.
\set ON_ERROR_STOP on
TRUNCATE public.delta_probe;
-- Unique probe key is for test completeness assertions, NOT proof that the
-- production emitter offers exactly-once delivery across retries.
CREATE UNIQUE INDEX pr359_synthetic_delta_probe_key
 ON public.delta_probe (tenant_id,site_id,entity_type,entity_id);

DO $keyset$
DECLARE
 last_id bigint;
 r record;
 page_rows integer;
 fuel_pages integer := 0;
 maintenance_pages integer := 0;
 fuel_emitted integer := 0;
 maintenance_emitted integer := 0;
BEGIN
 -- Stable synthetic snapshot; cursor id is unique and strictly ascending.
 -- This procedure is NOT run by the production rename trigger.
 last_id := -9223372036854775808;
 LOOP
  page_rows := 0;
  FOR r IN
   SELECT id FROM public.generator_fuel_events
   WHERE tenant_id=1 AND site_id=10 AND generator_id=1 AND id>last_id
   ORDER BY id ASC LIMIT 128
  LOOP
   PERFORM public.powerhub_emit_fuel_maintenance_delta_sync_change(1,10,'fuel_events',r.id);
   last_id := r.id;
   page_rows := page_rows+1;
   fuel_emitted := fuel_emitted+1;
  END LOOP;
  EXIT WHEN page_rows=0;
  fuel_pages := fuel_pages+1;
  EXIT WHEN page_rows<128;
 END LOOP;

 last_id := -9223372036854775808;
 LOOP
  page_rows := 0;
  FOR r IN
   SELECT id FROM public.generator_maintenance_work_orders
   WHERE tenant_id=1 AND site_id=10 AND generator_id=1 AND id>last_id
   ORDER BY id ASC LIMIT 128
  LOOP
   PERFORM public.powerhub_emit_fuel_maintenance_delta_sync_change(1,10,'maintenance_work_orders',r.id);
   last_id := r.id;
   page_rows := page_rows+1;
   maintenance_emitted := maintenance_emitted+1;
  END LOOP;
  EXIT WHEN page_rows=0;
  maintenance_pages := maintenance_pages+1;
  EXIT WHEN page_rows<128;
 END LOOP;

 IF fuel_emitted<>501 OR maintenance_emitted<>201
    OR fuel_pages<>4 OR maintenance_pages<>2
 THEN
  RAISE EXCEPTION 'PR359_LOCAL_KEYSET_PAGE_COUNTS_INVALID fuel=% maintenance=% fuel_pages=% maintenance_pages=%',
    fuel_emitted,maintenance_emitted,fuel_pages,maintenance_pages;
 END IF;
END
$keyset$;
DO $verify$
BEGIN
 IF (SELECT count(*) FROM public.delta_probe)<>702
 OR (SELECT count(*) FROM public.delta_probe WHERE entity_type='fuel_events')<>501
 OR (SELECT count(*) FROM public.delta_probe WHERE entity_type='maintenance_work_orders')<>201
 OR EXISTS (SELECT 1 FROM public.delta_probe WHERE tenant_id<>1 OR site_id<>10)
 OR EXISTS (
  SELECT 1 FROM public.generator_fuel_events e
  WHERE e.tenant_id=1 AND e.site_id=10 AND e.generator_id=1
    AND NOT EXISTS (
      SELECT 1 FROM public.delta_probe d
      WHERE d.tenant_id=e.tenant_id AND d.site_id=e.site_id
        AND d.entity_type='fuel_events' AND d.entity_id=e.id
    )
 )
 OR EXISTS (
  SELECT 1 FROM public.generator_maintenance_work_orders w
  WHERE w.tenant_id=1 AND w.site_id=10 AND w.generator_id=1
    AND NOT EXISTS (
      SELECT 1 FROM public.delta_probe d
      WHERE d.tenant_id=w.tenant_id AND d.site_id=w.site_id
        AND d.entity_type='maintenance_work_orders' AND d.entity_id=w.id
    )
 )
 OR EXISTS (
  SELECT 1 FROM public.delta_probe d
  WHERE (d.entity_type='fuel_events' AND NOT EXISTS (
          SELECT 1 FROM public.generator_fuel_events e
          WHERE e.id=d.entity_id AND e.tenant_id=d.tenant_id
            AND e.site_id=d.site_id AND e.generator_id=1
        ))
     OR (d.entity_type='maintenance_work_orders' AND NOT EXISTS (
          SELECT 1 FROM public.generator_maintenance_work_orders w
          WHERE w.id=d.entity_id AND w.tenant_id=d.tenant_id
            AND w.site_id=d.site_id AND w.generator_id=1
        ))
 )
 THEN RAISE EXCEPTION 'PR359_LOCAL_KEYSET_DELTA_INCOMPLETE_OR_SCOPE_VIOLATION'; END IF;
END
$verify$;
SELECT 'PR359_LOCAL_KEYSET_GENERATOR_501_FUEL_201_MAINTENANCE_PASS';
SELECT 'PR359_LOCAL_KEYSET_PRODUCER_REAL_RUNTIME_PROOF=FALSE';
SELECT 'PR359_KEYSET_CROSS_TRANSACTION_REPLAY_PROVEN=FALSE';
SELECT 'PR359_KEYSET_DEPLOYMENT_APPROVED=FALSE';
SELECT 'PR359_CANONICAL_BASELINE_APPROVED=FALSE';
