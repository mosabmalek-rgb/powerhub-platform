#!/usr/bin/env bash
# R4: prove that the actual seven-category SHA query detects definition drift.
# Uses ONLY a networkless, disposable PostgreSQL 17.6 Docker container.
set -euo pipefail
umask 077
for tool in docker node od; do command -v "$tool" >/dev/null || exit 2; done
work="$(mktemp -d)"
container="pr359-catalog-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
password="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
cleanup(){ docker rm -f "$container" >/dev/null 2>&1 || :; rm -rf -- "$work"; }
trap cleanup EXIT
docker run --rm -d --network none --name "$container" \
 -e "POSTGRES_PASSWORD=$password" -e POSTGRES_DB=postgres postgres:17.6 >/dev/null
ready=0
for i in $(seq 1 90); do
 if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -d postgres >/dev/null 2>&1; then ready=1; break; fi
 sleep 1
done
[[ "$ready" -eq 1 ]] || { echo PR359_R4_CATALOG_DOCKER_NOT_READY >&2; exit 1; }
[[ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$container")" == none ]] || exit 1
[[ -z "$(docker port "$container")" ]] || exit 1
sql(){
 docker exec -i -e "PGPASSWORD=$password" "$container" \
  psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres
}
cat <<'SQL' | sql >/dev/null
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE TABLE public.pr359_catalog_probe(id integer PRIMARY KEY, payload text NOT NULL);
CREATE INDEX pr359_catalog_probe_payload_idx ON public.pr359_catalog_probe(payload);
CREATE FUNCTION public.pr359_catalog_probe_fn() RETURNS trigger LANGUAGE plpgsql
 AS $$BEGIN RETURN NEW; END$$;
CREATE TRIGGER pr359_catalog_probe_trg BEFORE UPDATE ON public.pr359_catalog_probe
 FOR EACH ROW EXECUTE FUNCTION public.pr359_catalog_probe_fn();
ALTER TABLE public.pr359_catalog_probe ENABLE ROW LEVEL SECURITY;
CREATE POLICY pr359_catalog_probe_policy ON public.pr359_catalog_probe FOR SELECT
 TO PUBLIC USING (id>0);
SQL
sql < scripts/pr359-r4/staging-schema-fingerprint.sql >"$work/initial.jsonl"
cat <<'SQL' | sql >/dev/null
CREATE OR REPLACE FUNCTION public.pr359_catalog_probe_fn() RETURNS trigger
 LANGUAGE plpgsql AS $$BEGIN NEW.payload=NEW.payload; RETURN NEW; END$$;
ALTER POLICY pr359_catalog_probe_policy ON public.pr359_catalog_probe
 USING (id>=0);
ALTER TABLE public.pr359_catalog_probe DISABLE TRIGGER pr359_catalog_probe_trg;
SQL
sql < scripts/pr359-r4/staging-schema-fingerprint.sql >"$work/changed.jsonl"
node - "$work/initial.jsonl" "$work/changed.jsonl" <<'JS'
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const parse=(p)=>new Map(readFileSync(p,'utf8').trim().split(/\r?\n/).map(line=>{
 const row=JSON.parse(line);
 assert.match(row.sha256,/^[a-f0-9]{64}$/);
 assert.ok(Number.isSafeInteger(row.objects));
 return [row.category,row];
}));
const original=parse(process.argv[2]),changed=parse(process.argv[3]);
const expected=['columns','constraints','functions','indexes','policies','relations','triggers'];
assert.deepEqual([...original.keys()].sort(),expected);
assert.deepEqual([...changed.keys()].sort(),expected);
const changedNames=[];
for(const [kind,initial] of original){
 const current=changed.get(kind);
 assert.equal(initial.objects,current.objects,'unexpected object-count change: '+kind);
 if(initial.sha256!==current.sha256)changedNames.push(kind);
}
assert.deepEqual(changedNames.sort(),['functions','policies','triggers']);
JS
echo 'PR359_R4_DISPOSABLE_SCHEMA_SHA_DRIFT_DETECTED_PASS'
echo 'PR359_R4_DISPOSABLE_EQUAL_COUNTS_DETECTED_PASS'
echo 'PR359_STAGING_INPLACE_GO=FALSE'
