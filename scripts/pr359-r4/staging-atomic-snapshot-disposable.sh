#!/usr/bin/env bash
# Disposable PostgreSQL 17 MVCC snapshot regression with concurrent writes.
# Networkless Docker, synthetic data only; no hosted PowerHub connection.
set -euo pipefail
umask 077
for tool in docker grep od; do command -v "$tool" >/dev/null || exit 2; done
work="$(mktemp -d)"
container="pr359-mvcc-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
password="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
keeper_pid=''
keeper_in=''
cleanup() {
 if [[ -n "$keeper_in" ]]; then printf 'ROLLBACK;\n\\q\n' >&"$keeper_in" 2>/dev/null || :; fi
 if [[ -n "$keeper_pid" ]]; then kill "$keeper_pid" 2>/dev/null || :; wait "$keeper_pid" 2>/dev/null || :; fi
 docker rm -f "$container" >/dev/null 2>&1 || :
 rm -rf -- "$work"
}
trap cleanup EXIT
docker run --rm -d --network none --name "$container" \
 -e "POSTGRES_PASSWORD=$password" -e POSTGRES_DB=postgres postgres:17.6 >/dev/null
ready=0
for i in $(seq 1 90); do
 if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -d postgres >/dev/null 2>&1; then ready=1; break; fi
 sleep 1
done
[[ "$ready" -eq 1 ]] || { echo 'PR359_SNAPSHOT_DOCKER_NOT_READY' >&2; exit 1; }
[[ "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$container")" == none ]] || exit 1
[[ -z "$(docker port "$container")" ]] || exit 1
psql_local() {
 docker exec -i -e "PGPASSWORD=$password" "$container" psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d "$1"
}
printf '%s\n' \
 "CREATE TABLE public.pr359_snapshot_probe (id integer PRIMARY KEY, payload text NOT NULL);" \
 "CREATE TABLE public.pr359_migration_probe (version text PRIMARY KEY, payload text NOT NULL);" \
 "INSERT INTO public.pr359_snapshot_probe VALUES (1, 'before');" \
 "INSERT INTO public.pr359_migration_probe VALUES ('v1', 'original');" | psql_local postgres >/dev/null
# Keeper must remain open while multiple pg_dump processes import one snapshot.
coproc SNAP_OWNER {
 docker exec -i -e "PGPASSWORD=$password" "$container" \
  psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres 2>"$work/owner.err"
}
keeper_pid="$SNAP_OWNER_PID"
keeper_in="${SNAP_OWNER[1]}"
keeper_out="${SNAP_OWNER[0]}"
printf 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_export_snapshot();\n' >&"$keeper_in"
snapshot=''
if ! IFS= read -r -t 30 snapshot <&"$keeper_out" || [[ ! "$snapshot" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[0-9]+$ ]]; then
 echo 'PR359_SNAPSHOT_OWNER_EXPORT_FAILED' >&2; exit 1
fi
pg_dump_local() {
 docker exec -e "PGPASSWORD=$password" "$container" pg_dump \
  -w -U postgres -d postgres --quote-all-identifiers \
  --table=public.pr359_snapshot_probe --table=public.pr359_migration_probe "$@"
}
pg_dump_local --snapshot="$snapshot" --schema-only >"$work/schema.sql"
# Mutate data *after* first dump and *before* later dumps.
printf '%s\n' \
 "UPDATE public.pr359_snapshot_probe SET payload='after' WHERE id=1;" \
 "INSERT INTO public.pr359_snapshot_probe VALUES(2, 'new');" \
 "UPDATE public.pr359_migration_probe SET payload='changed' WHERE version='v1';" | psql_local postgres >/dev/null
pg_dump_local --snapshot="$snapshot" --data-only --column-inserts >"$work/data-snapshot.sql"
pg_dump_local --data-only --column-inserts >"$work/data-fresh.sql"
grep -q "'before'" "$work/data-snapshot.sql" || exit 1
grep -q "'original'" "$work/data-snapshot.sql" || exit 1
if grep -Eq "'after'|'new'|'changed'" "$work/data-snapshot.sql"; then
 echo 'PR359_SNAPSHOT_LEAKED_CONCURRENT_MUTATION' >&2; exit 1
fi
grep -q "'after'" "$work/data-fresh.sql" || exit 1
grep -q "'new'" "$work/data-fresh.sql" || exit 1
grep -q "'changed'" "$work/data-fresh.sql" || exit 1
# An independent read-only query imports the same snapshot as pg_dump.
{
 printf 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;\n'
 printf "SET TRANSACTION SNAPSHOT '%s';\n" "$snapshot"
 printf "SELECT (SELECT count(*) FROM public.pr359_snapshot_probe)::text || ':' || (SELECT payload FROM public.pr359_migration_probe WHERE version='v1');\nCOMMIT;\n"
} | psql_local postgres >"$work/attest.txt"
[[ "$(cat "$work/attest.txt")" == '1:original' ]] || { echo 'PR359_SNAPSHOT_IMPORT_MISMATCH' >&2; exit 1; }
# Fresh disposable restore proves dump coherence.
docker exec -e "PGPASSWORD=$password" "$container" createdb -U postgres pr359_shadow_restore
psql_local pr359_shadow_restore <"$work/schema.sql" >/dev/null
psql_local pr359_shadow_restore <"$work/data-snapshot.sql" >/dev/null
restored="$(printf "SELECT (SELECT string_agg(payload,',' ORDER BY id) FROM public.pr359_snapshot_probe) || ':' || (SELECT payload FROM public.pr359_migration_probe WHERE version='v1');\n" | psql_local pr359_shadow_restore)"
[[ "$restored" == 'before:original' ]] || { echo 'PR359_SNAPSHOT_RESTORE_MISMATCH' >&2; exit 1; }
# Snapshot must become unusable after the exporting transaction ends.
printf 'COMMIT;\n\\q\n' >&"$keeper_in"
wait "$keeper_pid" || :
keeper_pid=''
keeper_in=''
if pg_dump_local --snapshot="$snapshot" --data-only >"$work/expired.sql" 2>"$work/expired.err"; then
 echo 'PR359_EXPIRED_SNAPSHOT_WAS_ACCEPTED' >&2; exit 1
fi
echo 'PR359_DISPOSABLE_MVCC_CONCURRENT_WRITES_PASS'
echo 'PR359_DISPOSABLE_MVCC_EXPIRED_SNAPSHOT_REJECTED_PASS'
echo 'PR359_STAGING_REAL_RESTORE=NOT_PROVEN'
echo 'PR359_STAGING_INPLACE_GO=FALSE'
