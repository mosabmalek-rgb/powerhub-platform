-- Test fixture only. Runs exclusively in an isolated docker postgres:17.6 container.
-- Do not execute against Supabase Staging, Production, or any linked database.
CREATE EXTENSION pgcrypto;
CREATE SCHEMA supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations(
 version text PRIMARY KEY, statements text[], name text, created_by text,
 idempotency_key text, rollback text[]
);
INSERT INTO supabase_migrations.schema_migrations(version,statements,name,created_by)
VALUES ('20260101000000', ARRAY['CREATE TABLE synthetic_one(id int);'],'old_demo_1','local_fixture'),
       ('20260102000000', ARRAY['CREATE TABLE synthetic_two(id int);'],'old_demo_2','local_fixture');

CREATE SCHEMA pr359_epoch_v2_demo;
REVOKE ALL ON SCHEMA pr359_epoch_v2_demo FROM PUBLIC;
CREATE TABLE pr359_epoch_v2_demo.invoice_shadow(
  id bigint PRIMARY KEY, total numeric(12,2) NOT NULL
);
INSERT INTO pr359_epoch_v2_demo.invoice_shadow(id,total) VALUES (1,125.50),(2,81.00);

-- Dedicated v2 evidence tables; the historical ledger is read but NEVER written
-- by start_epoch or apply_demo_migration. These are NOT release schemas.
CREATE TABLE pr359_epoch_v2_demo.epoch_contract(
  epoch_id integer PRIMARY KEY CHECK(epoch_id=2),
  legacy_sha256 text NOT NULL CHECK(legacy_sha256 ~ '^[0-9a-f]{64}$'),
  legacy_count integer NOT NULL CHECK(legacy_count >= 1),
  baseline_sha256 text NOT NULL CHECK(baseline_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE TABLE pr359_epoch_v2_demo.epoch_migrations(
  version text PRIMARY KEY,
  sql_sha256 text NOT NULL CHECK(sql_sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON ALL TABLES IN SCHEMA pr359_epoch_v2_demo FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA supabase_migrations FROM PUBLIC;

CREATE FUNCTION pr359_epoch_v2_demo.legacy_sha256()
RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $sql$
 SELECT encode(public.digest(
   coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.version)
             FROM supabase_migrations.schema_migrations m),'[]'::jsonb)::text,
   'sha256'),'hex')
$sql$;
CREATE FUNCTION pr359_epoch_v2_demo.baseline_sha256()
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $sql$
 -- Toy baseline marker. Never claim this is PowerHub canonical application DDL.
 SELECT encode(public.digest('PR359_DISPOSABLE_EPOCH_V2_BASELINE_ONLY','sha256'),'hex')
$sql$;
CREATE FUNCTION pr359_epoch_v2_demo.sql_sha256()
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $sql$
 SELECT encode(public.digest(
   'ALTER TABLE pr359_epoch_v2_demo.invoice_shadow ADD COLUMN applied_amount numeric(12,2) NOT NULL DEFAULT 0',
   'sha256'),'hex')
$sql$;

CREATE FUNCTION pr359_epoch_v2_demo.start_epoch(expected_legacy text, expected_baseline text)
RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE
  present pr359_epoch_v2_demo.epoch_contract%ROWTYPE;
  count_old integer;
BEGIN
  PERFORM pg_advisory_xact_lock(3592001);
  IF expected_legacy IS DISTINCT FROM pr359_epoch_v2_demo.legacy_sha256() THEN
    RAISE EXCEPTION 'PR359_EPOCH_LEGACY_FINGERPRINT_MISMATCH';
  END IF;
  IF expected_baseline IS DISTINCT FROM pr359_epoch_v2_demo.baseline_sha256() THEN
    RAISE EXCEPTION 'PR359_EPOCH_BASELINE_FINGERPRINT_MISMATCH';
  END IF;
  SELECT count(*) INTO count_old FROM supabase_migrations.schema_migrations;
  SELECT * INTO present FROM pr359_epoch_v2_demo.epoch_contract WHERE epoch_id=2;
  IF FOUND THEN
    IF present.legacy_sha256 IS DISTINCT FROM expected_legacy OR
       present.baseline_sha256 IS DISTINCT FROM expected_baseline OR
       present.legacy_count IS DISTINCT FROM count_old THEN
      RAISE EXCEPTION 'PR359_EPOCH_REPLAY_CONTRACT_DRIFT';
    END IF;
    RETURN 'REPLAY';
  END IF;
  INSERT INTO pr359_epoch_v2_demo.epoch_contract(epoch_id,legacy_sha256,legacy_count,baseline_sha256)
  VALUES (2,expected_legacy,count_old,expected_baseline);
  RETURN 'STARTED';
END
$fn$;

CREATE FUNCTION pr359_epoch_v2_demo.apply_demo_migration(p_version text, p_sql_sha text, p_fail boolean DEFAULT false)
RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE
  contract pr359_epoch_v2_demo.epoch_contract%ROWTYPE;
  existing_sha text;
  has_column boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(3592001);
  SELECT * INTO contract FROM pr359_epoch_v2_demo.epoch_contract WHERE epoch_id=2;
  IF NOT FOUND THEN RAISE EXCEPTION 'PR359_EPOCH_NOT_INITIALIZED'; END IF;
  IF contract.legacy_sha256 IS DISTINCT FROM pr359_epoch_v2_demo.legacy_sha256()
     OR contract.legacy_count IS DISTINCT FROM (SELECT count(*) FROM supabase_migrations.schema_migrations)
     OR contract.baseline_sha256 IS DISTINCT FROM pr359_epoch_v2_demo.baseline_sha256() THEN
    RAISE EXCEPTION 'PR359_EPOCH_FINGERPRINT_DRIFT';
  END IF;
  -- Strictly fixed allowlisted identity and SQL hash. Never accepts arbitrary SQL.
  IF p_version IS DISTINCT FROM 'demo-v2-001' OR
     p_sql_sha IS DISTINCT FROM pr359_epoch_v2_demo.sql_sha256() THEN
    RAISE EXCEPTION 'PR359_EPOCH_VERSION_OR_SQL_SHA_REJECTED';
  END IF;
  SELECT EXISTS(
     SELECT 1 FROM information_schema.columns
     WHERE table_schema='pr359_epoch_v2_demo'
       AND table_name='invoice_shadow' AND column_name='applied_amount'
  ) INTO has_column;
  SELECT sql_sha256 INTO existing_sha
  FROM pr359_epoch_v2_demo.epoch_migrations WHERE version=p_version FOR UPDATE;
  IF FOUND THEN
    IF existing_sha IS DISTINCT FROM p_sql_sha OR NOT has_column THEN
      RAISE EXCEPTION 'PR359_EPOCH_REPLAY_SCHEMA_OR_HASH_DRIFT';
    END IF;
    RETURN 'REPLAY';
  END IF;
  IF has_column THEN
    RAISE EXCEPTION 'PR359_EPOCH_UNTRACKED_SCHEMA_MUTATION';
  END IF;
  EXECUTE 'ALTER TABLE pr359_epoch_v2_demo.invoice_shadow ADD COLUMN applied_amount numeric(12,2) NOT NULL DEFAULT 0';
  IF p_fail THEN RAISE EXCEPTION 'PR359_EPOCH_INJECTED_FAILURE'; END IF;
  INSERT INTO pr359_epoch_v2_demo.epoch_migrations(version,sql_sha256)
  VALUES (p_version,p_sql_sha);
  RETURN 'APPLIED';
END
$fn$;

-- No PUBLIC entrypoint. PostgreSQL grants EXECUTE to PUBLIC by default unless revoked.
REVOKE ALL ON FUNCTION pr359_epoch_v2_demo.legacy_sha256() FROM PUBLIC;
REVOKE ALL ON FUNCTION pr359_epoch_v2_demo.baseline_sha256() FROM PUBLIC;
REVOKE ALL ON FUNCTION pr359_epoch_v2_demo.sql_sha256() FROM PUBLIC;
REVOKE ALL ON FUNCTION pr359_epoch_v2_demo.start_epoch(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION pr359_epoch_v2_demo.apply_demo_migration(text,text,boolean) FROM PUBLIC;
