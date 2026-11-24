#!/usr/bin/env bash
# PR359 CB-A: replay pinned SECDEF trigger definitions in networkless Docker.
# No Staging/Production DB URL, credentials, Supabase stack, or migration applied.
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."
for command in docker node od grep; do
  command -v "$command" >/dev/null || { echo "MISSING_TOOL_$command" >&2; exit 2; }
done
tmp="$(mktemp -d)"
container="pr359-definer-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
password="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
cleanup() {
 docker rm -f "$container" >/dev/null 2>&1 || :
 rm -rf -- "$tmp"
}
trap cleanup EXIT
node --test scripts/pr359-canonical/generate-definer-disposable-replay.test.mjs
node scripts/pr359-canonical/generate-definer-disposable-replay.mjs --out "$tmp/replay.sql" >/dev/null
[[ -s "$tmp/replay.sql" ]] || { echo PR359_SYNTHETIC_REPLAY_MISSING >&2; exit 1; }
docker run --rm -d --network none --name "$container" \
 -e "POSTGRES_PASSWORD=$password" -e POSTGRES_DB=postgres postgres:17.6 >/dev/null
ready=0
for i in $(seq 1 90); do
 if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -d postgres >/dev/null 2>&1; then
   ready=1; break
 fi
 sleep 1
done
[[ "$ready" == 1 ]] || { echo PR359_ISOLATED_PG_NOT_READY >&2; exit 1; }
[[ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$container")" == none ]] || exit 1
[[ -z "$(docker port "$container")" ]] || exit 1
docker exec -i -e "PGPASSWORD=$password" "$container" \
 psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres \
 < "$tmp/replay.sql" > "$tmp/results.txt"
for expected in \
 PR359_OWNER_SITE_SERIAL_AND_TWO_TENANT_ISOLATION_PASS \
 PR359_CAPTURED_BRANCH_LIMIT_OMISSION_REPRODUCED \
 PR359_LOCAL_CANDIDATE_GENERATOR_FIRST_LIMIT_PASS \
 PR359_LOCAL_CANDIDATE_NOOP_RENAME_PASS \
 PR359_CANONICAL_BASELINE_APPROVED=FALSE \
 PR359_STAGING_INPLACE_GO=FALSE \
 PR359_PRODUCTION_INPLACE_GO=FALSE
do
 grep -Fxq "$expected" "$tmp/results.txt" || {
   echo "PR359_DISPOSABLE_REPLAY_MISSING_ASSERTION=$expected" >&2; exit 1;
 }
done
echo PR359_CB_A_DISPOSABLE_DEFINER_REPLAY_PASS
echo PR359_OWNER_SITE_CONCURRENT_TRANSACTION_PROOF=NOT_RUN
echo PR359_LOCAL_GENERATOR_CANDIDATE_ONLY=NOT_APPROVED
echo PR359_CANONICAL_BASELINE_APPROVED=FALSE
