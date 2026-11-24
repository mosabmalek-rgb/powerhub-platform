-- PR359 CB-A SYNTHETIC ONLY. Run after the disposable trigger replay,
-- in a networkless temporary PostgreSQL container. No hosted tables touched.
\set ON_ERROR_STOP on

-- Historical data compatibility: a partial unique index cannot be built
-- over two already-committed main sites of the same tenant. PostgreSQL must
-- refuse it; the operator must review the rows, never auto-delete one.
CREATE TEMP TABLE pr359_historical_main_sites (
  tenant_id bigint NOT NULL,
  name text NOT NULL,
  code text NOT NULL
);
INSERT INTO pr359_historical_main_sites(tenant_id,name,code)
VALUES (91,'الفرع الرئيسي','HIST-A'),(91,'الفرع الرئيسي','HIST-B'),
       (92,'الفرع الرئيسي','HIST-C'),(91,'فرع آخر','HIST-D');
DO $historical$
DECLARE rejected boolean := false;
BEGIN
  BEGIN
    EXECUTE 'CREATE UNIQUE INDEX pr359_unapproved_historical_site_idx ON pg_temp.pr359_historical_main_sites (tenant_id, name) WHERE name=''الفرع الرئيسي''';
  EXCEPTION WHEN unique_violation THEN
    rejected := true;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'PR359_HISTORICAL_DUPLICATE_INDEX_WAS_INCORRECTLY_ACCEPTED';
  END IF;
  IF (SELECT count(*) FROM pr359_historical_main_sites) <> 4
  OR (SELECT count(*) FROM pr359_historical_main_sites
      WHERE tenant_id=91 AND name='الفرع الرئيسي') <> 2
  OR to_regclass('pg_temp.pr359_unapproved_historical_site_idx') IS NOT NULL
  THEN
    RAISE EXCEPTION 'PR359_HISTORICAL_REJECTION_MUTATED_DATA';
  END IF;
END
$historical$;
SELECT 'PR359_HISTORICAL_DUPLICATES_REJECT_INDEX_WITHOUT_DATA_LOSS';

-- A separate clean fixture proves the very same partial predicate can be
-- installed after a deliberate business-reviewed duplicate reconciliation.
CREATE TEMP TABLE pr359_clean_main_sites AS
SELECT * FROM pr359_historical_main_sites WHERE code IN ('HIST-A','HIST-C','HIST-D');
CREATE UNIQUE INDEX pr359_clean_main_site_idx
ON pg_temp.pr359_clean_main_sites (tenant_id, name)
WHERE name='الفرع الرئيسي';
DO $clean$
BEGIN
  IF (SELECT count(*) FROM pr359_clean_main_sites) <> 3
  OR to_regclass('pg_temp.pr359_clean_main_site_idx') IS NULL
  THEN RAISE EXCEPTION 'PR359_CLEAN_HISTORICAL_INDEX_PRECONDITION_FAILED';
  END IF;
END
$clean$;
SELECT 'PR359_HISTORICAL_CLEAN_INDEX_PREDICATE_PASS';

-- Bounded per-generator Delta is still bounded. Adding 500 newer fuel events
-- and 200 work orders to the same target proves that the oldest target row
-- is omitted even with the generator-first candidate. This requires a product
-- contract: bounded recent cache refresh vs complete historical refresh.
INSERT INTO public.generator_fuel_events(id,tenant_id,site_id,generator_id,occurred_at)
SELECT 30000+x,1,10,1,'2027-01-01'::timestamptz+x*interval '1 second'
FROM generate_series(1,500) x;
INSERT INTO public.generator_maintenance_work_orders
(id,tenant_id,site_id,generator_id,reported_at,created_at)
SELECT 40000+x,1,10,1,
 '2027-01-01'::timestamptz+x*interval '1 second',
 '2027-01-01'::timestamptz+x*interval '1 second'
FROM generate_series(1,200) x;
TRUNCATE public.delta_probe;
UPDATE public.generators SET name='Renamed target above cap' WHERE id=1;
DO $bounded$
BEGIN
  IF (SELECT count(*) FROM public.delta_probe WHERE entity_type='fuel_events')<>500
  OR (SELECT count(*) FROM public.delta_probe WHERE entity_type='maintenance_work_orders')<>200
  OR EXISTS(SELECT 1 FROM public.delta_probe WHERE entity_id=1)
  OR EXISTS(SELECT 1 FROM public.delta_probe WHERE tenant_id<>1 OR site_id<>10)
  OR (SELECT count(*) FROM public.delta_probe)<>700
  OR (SELECT count(DISTINCT (entity_type,entity_id)) FROM public.delta_probe)<>700
  THEN RAISE EXCEPTION 'PR359_GENERATOR_FIRST_CAP_BOUNDARY_INCORRECT';
  END IF;
END
$bounded$;
SELECT 'PR359_GENERATOR_FIRST_REMAINS_BOUNDED_ABOVE_TARGET_500_200';
SELECT 'PR359_FULL_GENERATOR_HISTORY_DELTA_PROVEN=FALSE';
SELECT 'PR359_HISTORICAL_DATA_RECONCILIATION_APPROVED=FALSE';
SELECT 'PR359_CANONICAL_BASELINE_APPROVED=FALSE';
SELECT 'PR359_STAGING_INPLACE_GO=FALSE';
SELECT 'PR359_PRODUCTION_INPLACE_GO=FALSE';