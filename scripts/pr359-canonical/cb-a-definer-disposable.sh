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
owner_pid=''
owner_in=''
cleanup() {
 if [[ -n "$owner_pid" ]]; then
  printf 'ROLLBACK;\n\\q\n' >&"$owner_in" 2>/dev/null || :
  kill "$owner_pid" 2>/dev/null || :
  wait "$owner_pid" 2>/dev/null || :
 fi
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
# Reproduce a genuine two-session race: an uncommitted manual site insert
# is invisible to the committed subscription-trigger INSERT in session B.
# Only this disposable synthetic DB is affected. This is an expected NEGATIVE
# test showing that the captured function lacks cross-path serialization.
printf '%s\n' "INSERT INTO public.tenant_members(tenant_id,user_id,role,is_active) VALUES (3,300,'owner',true);" |
 docker exec -i -e "PGPASSWORD=$password" "$container" \
 psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null
coproc OWNER_SITE_TX {
 docker exec -i -e "PGPASSWORD=$password" "$container" \
  psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres
}
owner_pid="$OWNER_SITE_TX_PID"
owner_in="${OWNER_SITE_TX[1]}"
owner_out="${OWNER_SITE_TX[0]}"
printf '%s\n' \
 'BEGIN;' \
 "INSERT INTO public.sites(tenant_id,name,code,status) SELECT 3,name,'PR359-PENDING-SITE','active' FROM public.sites WHERE tenant_id=1 ORDER BY id LIMIT 1;" \
 "SELECT 'PR359_OWNER_SITE_UNCOMMITTED';" >&"$owner_in"
marker=''
if ! IFS= read -r -t 25 marker <&"$owner_out" || [[ "$marker" != PR359_OWNER_SITE_UNCOMMITTED ]]; then
 echo PR359_OWNER_SITE_CONCURRENT_SETUP_FAILED >&2; exit 1
fi
# Session B sees no committed site and the captured trigger inserts another.
printf '%s\n' "INSERT INTO public.tenant_subscriptions(tenant_id) VALUES(3);" |
 docker exec -i -e "PGPASSWORD=$password" "$container" \
 psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null
printf 'COMMIT;\n\\q\n' >&"$owner_in"
wait "$owner_pid"
owner_pid=''
count="$(printf '%s\n' "SELECT count(*) FROM public.sites WHERE tenant_id=3 AND name=(SELECT name FROM public.sites WHERE tenant_id=1 LIMIT 1);" |
 docker exec -i -e "PGPASSWORD=$password" "$container" \
 psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres)"
[[ "$count" == 2 ]] || {
 echo "PR359_EXPECTED_OWNER_SITE_CROSS_PATH_RACE_NOT_REPRODUCED count=$count" >&2; exit 1
}
echo PR359_OWNER_SITE_CROSS_PATH_CONCURRENT_DUPLICATE_REPRODUCED
echo PR359_OWNER_SITE_CONCURRENT_SAFETY_APPROVED=FALSE
echo PR359_CB_A_DISPOSABLE_DEFINER_REPLAY_PASS
echo PR359_LOCAL_GENERATOR_CANDIDATE_ONLY=NOT_APPROVED
echo PR359_CANONICAL_BASELINE_APPROVED=FALSE
