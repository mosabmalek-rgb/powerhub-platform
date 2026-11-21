#!/usr/bin/env bash
# R4 proof of protocol only: never connects to hosted Supabase.
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."

for tool in docker grep mktemp od; do
  command -v "$tool" >/dev/null || { echo "PR359_EPOCH_MISSING_TOOL_$tool" >&2; exit 2; }
done
# Fail closed if any hosted DB URL / source credential leaks into this experiment.
for key in SHADOW_SOURCE_DB_URL SUPABASE_DB_URL DATABASE_URL SUPABASE_ACCESS_TOKEN; do
  if [[ -n "$(printenv "$key" 2>/dev/null || :)" ]]; then
    echo 'PR359_EPOCH_HOSTED_CREDENTIALS_FORBIDDEN' >&2; exit 2
  fi
done

container="pr359-epoch-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
work="$(mktemp -d)"
cleanup(){
  docker rm -f "$container" >/dev/null 2>&1 || :
  rm -rf -- "$work"
}
trap cleanup EXIT
password="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
docker run --rm -d --network none --name "$container" \
  -e "POSTGRES_PASSWORD=$password" \
  -e POSTGRES_DB=postgres postgres:17.6 >/dev/null
[[ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$container")" == none ]] || exit 2
[[ -z "$(docker port "$container")" ]] || exit 2
ready=0
for i in $(seq 1 100); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -p 5432 -U postgres -d postgres >/dev/null 2>&1; then
    ready=$((ready+1))
    [[ "$ready" -ge 2 ]] && break
  else
    ready=0
  fi
  sleep 1
done
[[ "$ready" -ge 2 ]] || { echo 'PR359_EPOCH_POSTGRES_NOT_READY' >&2; exit 2; }
db(){
  local database="$1"; shift
  docker exec -i "$container" psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d "$database" "$@"
}
create_case(){
  docker exec "$container" createdb -U postgres "$1" >/dev/null
  db "$1" < scripts/pr359-r4/epoch-v2-fixture.sql >/dev/null
}
get_value(){ printf '%s\n' "$2" | db "$1" | tail -1; }
expect_rejected(){
  local name="$1" database="$2" marker="$3" query="$4"
  if printf '%s\n' "$query" | db "$database" >"$work/$name.out" 2>&1; then
    echo "PR359_EPOCH_EXPECTED_REJECTION_MISSING:$name" >&2;exit 1
  fi
  if ! grep -q "$marker" "$work/$name.out"; then
    echo "PR359_EPOCH_WRONG_REJECTION:$name" >&2;exit 1
  fi
}
assert_true(){
  local dbname="$1" label="$2" query="$3"
  [[ "$(get_value "$dbname" "$query")" == t ]] || {
    echo "PR359_EPOCH_ASSERT_FAIL:$label" >&2; exit 1
  }
}
fingerprint="pr359_epoch_v2_demo.legacy_sha256()"
baseline="pr359_epoch_v2_demo.baseline_sha256()"
sqlsha="pr359_epoch_v2_demo.sql_sha256()"
start="SELECT pr359_epoch_v2_demo.start_epoch($fingerprint,$baseline);"
apply="SELECT pr359_epoch_v2_demo.apply_demo_migration('demo-v2-001',$sqlsha,false);"
proof="SELECT (SELECT count(*) FROM supabase_migrations.schema_migrations)=2
  AND pr359_epoch_v2_demo.legacy_sha256()=(SELECT legacy_sha256 FROM pr359_epoch_v2_demo.epoch_contract WHERE epoch_id=2)
  AND (SELECT count(*) FROM pr359_epoch_v2_demo.epoch_migrations)=1
  AND (SELECT count(*) FROM pr359_epoch_v2_demo.invoice_shadow)=2
  AND (SELECT sum(total) FROM pr359_epoch_v2_demo.invoice_shadow)=206.50
  AND (SELECT sum(applied_amount) FROM pr359_epoch_v2_demo.invoice_shadow)=0;"

create_case epoch_pass
[[ "$(get_value epoch_pass "$start")" == STARTED ]] || exit 1
[[ "$(get_value epoch_pass "$start")" == REPLAY ]] || exit 1
[[ "$(get_value epoch_pass "$apply")" == APPLIED ]] || exit 1
[[ "$(get_value epoch_pass "$apply")" == REPLAY ]] || exit 1
assert_true epoch_pass happy_path "$proof"
expect_rejected wrong_checksum epoch_pass PR359_EPOCH_VERSION_OR_SQL_SHA_REJECTED \
  "SELECT pr359_epoch_v2_demo.apply_demo_migration('demo-v2-001',repeat('a',64),false);"
expect_rejected wrong_version epoch_pass PR359_EPOCH_VERSION_OR_SQL_SHA_REJECTED \
  "SELECT pr359_epoch_v2_demo.apply_demo_migration('demo-v2-002',$sqlsha,false);"
expect_rejected wrong_baseline epoch_pass PR359_EPOCH_BASELINE_FINGERPRINT_MISMATCH \
  "SELECT pr359_epoch_v2_demo.start_epoch($fingerprint,repeat('0',64));"
assert_true epoch_pass reject_no_side_effect "$proof"

create_case epoch_fault
[[ "$(get_value epoch_fault "$start")" == STARTED ]] || exit 1
expect_rejected forced_fault epoch_fault PR359_EPOCH_INJECTED_FAILURE \
  "SELECT pr359_epoch_v2_demo.apply_demo_migration('demo-v2-001',$sqlsha,true);"
assert_true epoch_fault atomic_rollback "SELECT
  NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='pr359_epoch_v2_demo' AND table_name='invoice_shadow' AND column_name='applied_amount')
  AND (SELECT count(*) FROM pr359_epoch_v2_demo.epoch_migrations)=0
  AND (SELECT count(*) FROM supabase_migrations.schema_migrations)=2
  AND pr359_epoch_v2_demo.legacy_sha256()=(SELECT legacy_sha256 FROM pr359_epoch_v2_demo.epoch_contract);"
[[ "$(get_value epoch_fault "$apply")" == APPLIED ]] || exit 1
assert_true epoch_fault recovered "$proof"

create_case epoch_explicit_rollback
[[ "$(get_value epoch_explicit_rollback "$start")" == STARTED ]] || exit 1
get_value epoch_explicit_rollback "BEGIN; $apply ROLLBACK;" >/dev/null
assert_true epoch_explicit_rollback transaction_rollback "SELECT
  NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='pr359_epoch_v2_demo' AND table_name='invoice_shadow' AND column_name='applied_amount')
  AND (SELECT count(*) FROM pr359_epoch_v2_demo.epoch_migrations)=0;"
[[ "$(get_value epoch_explicit_rollback "$apply")" == APPLIED ]] || exit 1
assert_true epoch_explicit_rollback rollback_recovered "$proof"

create_case epoch_history_tamper
[[ "$(get_value epoch_history_tamper "$start")" == STARTED ]] || exit 1
printf "%s\n" "UPDATE supabase_migrations.schema_migrations SET name='tampered-local-fixture' WHERE version='20260101000000';" | db epoch_history_tamper >/dev/null
expect_rejected modified_legacy epoch_history_tamper PR359_EPOCH_FINGERPRINT_DRIFT "$apply"
assert_true epoch_history_tamper tamper_denied "SELECT
  (SELECT count(*) FROM pr359_epoch_v2_demo.epoch_migrations)=0 AND
  NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='pr359_epoch_v2_demo' AND table_name='invoice_shadow' AND column_name='applied_amount');"

create_case epoch_not_started
expect_rejected no_epoch epoch_not_started PR359_EPOCH_NOT_INITIALIZED "$apply"
assert_true epoch_not_started guard_denied "SELECT (SELECT count(*) FROM supabase_migrations.schema_migrations)=2
 AND (SELECT count(*) FROM pr359_epoch_v2_demo.epoch_migrations)=0;"

create_case epoch_concurrent
[[ "$(get_value epoch_concurrent "$start")" == STARTED ]] || exit 1
printf '%s\n' "$apply" | db epoch_concurrent > "$work/concurrent-1" 2>"$work/concurrent-1.err" &
p1=$!
printf '%s\n' "$apply" | db epoch_concurrent > "$work/concurrent-2" 2>"$work/concurrent-2.err" &
p2=$!
wait "$p1" || { echo 'PR359_EPOCH_CONCURRENCY_1_FAILED' >&2;exit 1; }
wait "$p2" || { echo 'PR359_EPOCH_CONCURRENCY_2_FAILED' >&2;exit 1; }
grep -qxE 'APPLIED|REPLAY' "$work/concurrent-1" || exit 1
grep -qxE 'APPLIED|REPLAY' "$work/concurrent-2" || exit 1
[[ "$(cat "$work/concurrent-1")" != "$(cat "$work/concurrent-2")" ]] || {
  echo 'PR359_EPOCH_CONCURRENCY_NOT_SERIALIZED' >&2;exit 1
}
assert_true epoch_concurrent concurrency_serialized "$proof"

echo 'PR359_EPOCH_V2_DISPOSABLE_PROTOCOL_PASS'
echo 'PR359_EPOCH_V2_LEGACY_HISTORY_UNCHANGED_IN_SUCCESS_PATHS=TRUE'
echo 'PR359_EPOCH_V2_FAULT_AND_ROLLBACK_PASS'
echo 'PR359_EPOCH_V2_CONCURRENT_IDEMPOTENCY_PASS'
echo 'PR359_R4_CANONICAL_BASELINE_APPROVED=FALSE'
echo 'PR359_R4_STAGING_INPLACE_GO=FALSE'
