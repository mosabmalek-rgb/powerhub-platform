#!/usr/bin/env bash
# Archived Staging append/pull definitions run in disposable networkless PG only.
set -euo pipefail
: "${PR359_TEST_CONTAINER:?Missing disposable container}"
: "${PR359_TEST_PASSWORD:?Missing test password}"
[[ "$PR359_TEST_CONTAINER" =~ ^pr359-definer-[0-9a-f]{12}$ ]] || exit 2
[[ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$PR359_TEST_CONTAINER")" == none ]] || exit 2
[[ -z "$(docker port "$PR359_TEST_CONTAINER")" ]] || exit 2
cd "$(dirname "$0")/../.."
tmp="$(mktemp -d)"
writer_pid=''; writer_in=''; second_pid=''
cleanup(){
 if [[ -n "$writer_pid" ]]; then
  printf 'ROLLBACK;\n\\q\n' >&"$writer_in" 2>/dev/null || :
  kill "$writer_pid" 2>/dev/null || :
  wait "$writer_pid" 2>/dev/null || :
 fi
 if [[ -n "$second_pid" ]]; then
  kill "$second_pid" 2>/dev/null || :
  wait "$second_pid" 2>/dev/null || :
 fi
 rm -rf "$tmp"
}
trap cleanup EXIT
run_sql(){
 docker exec -i -e "PGPASSWORD=$PR359_TEST_PASSWORD" "$PR359_TEST_CONTAINER" \
 psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d pr359_real_append
}
node --test scripts/pr359-canonical/generate-real-delta-disposable.test.mjs
node scripts/pr359-canonical/generate-real-delta-disposable.mjs --out "$tmp/real-append.sql" >/dev/null
docker exec -e "PGPASSWORD=$PR359_TEST_PASSWORD" "$PR359_TEST_CONTAINER" createdb -U postgres pr359_real_append
run_sql < "$tmp/real-append.sql" > "$tmp/setup-results.txt"
for marker in PR359_REAL_APPEND_ROLLBACK_ATOMICITY_PASS PR359_REAL_APPEND_DISTINCT_SCOPES_PASS PR359_CANONICAL_BASELINE_APPROVED=FALSE; do
 grep -Fxq "$marker" "$tmp/setup-results.txt" || { echo "PR359_REAL_APPEND_SETUP_MISSING=$marker" >&2; exit 1; }
done
coproc REAL_DELTA_WRITER { run_sql; }
writer_pid="$REAL_DELTA_WRITER_PID"
writer_in="${REAL_DELTA_WRITER[1]}"
writer_out="${REAL_DELTA_WRITER[0]}"
printf '%s\n' \
 'BEGIN;' \
 "SELECT public.powerhub_append_fuel_maintenance_delta_sync_change(1,101,'fuel_events','61','upsert','{\"id\":\"61\"}'::jsonb);" \
 "SELECT 'PR359_REAL_APPEND_WRITER_A_UNCOMMITTED';" >&"$writer_in"
marker=''
IFS= read -r -t 25 marker <&"$writer_out" || exit 1
[[ "$marker" == 2 ]] || { echo "PR359_REAL_APPEND_A_CURSOR=$marker" >&2; exit 1; }
IFS= read -r -t 25 marker <&"$writer_out" || exit 1
[[ "$marker" == PR359_REAL_APPEND_WRITER_A_UNCOMMITTED ]] || exit 1
{
 printf '%s\n' "SET statement_timeout='25s';"
 printf '%s\n' "SELECT public.powerhub_append_fuel_maintenance_delta_sync_change(1,101,'fuel_events','62','upsert','{\"id\":\"62\"}'::jsonb);"
} | run_sql >"$tmp/writer-b.txt" 2>"$tmp/writer-b.err" &
second_pid="$!"
blocked=0
for i in $(seq 1 80); do
 n="$(printf '%s\n' "SELECT count(*) FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%powerhub_append_fuel_maintenance_delta_sync_change(1,101%';" | run_sql)"
 if [[ "$n" =~ ^[0-9]+$ ]] && ((n>=1)); then blocked=1; break; fi
 sleep 0.25
done
[[ "$blocked" -eq 1 ]] || { echo PR359_REAL_APPEND_EXPECTED_ROW_LOCK_MISSING >&2; exit 1; }
printf 'COMMIT;\n\\q\n' >&"$writer_in"
wait "$writer_pid"
writer_pid=''
wait "$second_pid" || { cat "$tmp/writer-b.err" >&2; exit 1; }
second_pid=''
grep -Fxq 3 "$tmp/writer-b.txt" || { echo PR359_REAL_APPEND_SECOND_CURSOR_NOT_THREE >&2; exit 1; }
printf '%s\n' \
 "SELECT CASE WHEN (SELECT last_cursor FROM public.powerhub_sync_scope_state WHERE tenant_id=1 AND site_id=101 AND entity_type='fuel_events')=3 AND (SELECT count(*) FROM public.powerhub_sync_changes WHERE tenant_id=1 AND site_id=101 AND entity_type='fuel_events')=3 AND (SELECT count(DISTINCT cursor) FROM public.powerhub_sync_changes WHERE tenant_id=1 AND site_id=101 AND entity_type='fuel_events')=3 AND EXISTS(SELECT 1 FROM public.powerhub_sync_changes WHERE tenant_id=1 AND site_id=101 AND entity_id='61' AND cursor=2) AND EXISTS(SELECT 1 FROM public.powerhub_sync_changes WHERE tenant_id=1 AND site_id=101 AND entity_id='62' AND cursor=3) AND (SELECT last_cursor FROM public.powerhub_sync_scope_state WHERE tenant_id=2 AND site_id=201 AND entity_type='fuel_events')=1 THEN 'PR359_REAL_APPEND_CONCURRENT_CURSOR_2_3_PASS' ELSE 'FAILED' END;" \
 "SELECT public.powerhub_pull_fuel_maintenance_sync_delta(1,101,'fuel_events',1,3,200)->>'status';" \
 | run_sql > "$tmp/final-check.txt"
grep -Fxq PR359_REAL_APPEND_CONCURRENT_CURSOR_2_3_PASS "$tmp/final-check.txt" || { echo PR359_REAL_APPEND_SCOPE_CURSOR_INCONSISTENT >&2; exit 1; }
grep -Fxq ok "$tmp/final-check.txt" || { echo PR359_REAL_APPEND_PULL_FAILED >&2; exit 1; }
# Exercise retention with the exact captured Append and Pull definitions.
# Insert 10,499 artificial rows on a separate tenant/site scope, then use
# the real Append for cursor 10,500 to trigger its retention threshold.
node --test scripts/pr359-canonical/real-delta-retention-disposable.test.mjs
run_sql < scripts/pr359-canonical/fixtures/real-delta-retention-disposable.sql > "$tmp/retention-results.txt"
for expected in \
 PR359_REAL_RETENTION_10500_RESET_REQUIRED_PASS \
 PR359_REAL_RETENTION_PAGE_200_AND_SCOPE_PASS \
 PR359_ANDROID_REBOOTSTRAP_RUNTIME_VERIFIED=FALSE \
 PR359_REAL_RETENTION_PRODUCTION_APPROVED=FALSE \
 PR359_CANONICAL_BASELINE_APPROVED=FALSE
do
 grep -Fxq "$expected" "$tmp/retention-results.txt" || {
  echo "PR359_REAL_RETENTION_MARKER_MISSING=$expected" >&2; exit 1;
 }
done
echo PR359_REAL_APPEND_RETENTION_AND_PULL_RESET_PASS
# Characterize archived privileged input boundary; do not approve it.
run_sql < scripts/pr359-canonical/fixtures/real-append-payload-boundary-disposable.sql > "$tmp/payload-boundary-results.txt"
for expected in \
 PR359_ARCHIVED_PRIVILEGED_APPEND_PAYLOAD_GAP_REPRODUCED \
 PR359_ARCHIVED_PAYLOAD_TEST_ROLLBACK_PASS \
 PR359_REAL_PRODUCER_FULL_CALLER_CLOSURE_APPROVED=FALSE \
 PR359_CANONICAL_BASELINE_APPROVED=FALSE
do
 grep -Fxq "$expected" "$tmp/payload-boundary-results.txt" || {
  echo "PR359_ARCHIVED_PAYLOAD_BOUNDARY_MARKER_MISSING=$expected" >&2; exit 1;
 }
done
echo PR359_ARCHIVED_PRIVILEGED_APPEND_PAYLOAD_GAP_REPRODUCED
echo PR359_ARCHIVED_PAYLOAD_TEST_ROLLBACK_PASS
# Candidate is applied only in a rolled-back transaction against the disposable database.
run_sql < scripts/pr359-canonical/fixtures/append-payload-candidate-disposable.sql > "$tmp/append-candidate-results.txt"
for expected in PR359_CANDIDATE_PAYLOAD_17_NEGATIVE_CASES_PASS PR359_CANDIDATE_SYNTHETIC_ACL_PASS PR359_CANDIDATE_VALID_UPSERT_TOMBSTONE_ROLLBACK_PASS PR359_CANDIDATE_RETENTION_RESET_PASS PR359_CANDIDATE_FIXTURE_RESTORE_PASS PR359_CANONICAL_BASELINE_APPROVED=FALSE; do
 grep -Fxq "$expected" "$tmp/append-candidate-results.txt" || { echo "PR359_CANDIDATE_MARKER_MISSING=$expected" >&2; exit 1; }
 echo "$expected"
done
# The archived AFTER triggers, emit and append functions execute together in
# a SECOND synthetic database, with projector and refresh STUBS explicitly
# scoped to the test. The real platform schemas and grants are not tested.
node --test scripts/pr359-canonical/generate-real-capture-disposable.test.mjs
node scripts/pr359-canonical/generate-real-capture-disposable.mjs --out "$tmp/real-capture.sql" >/dev/null
docker exec -e "PGPASSWORD=$PR359_TEST_PASSWORD" "$PR359_TEST_CONTAINER" \
 createdb -U postgres pr359_real_capture
docker exec -i -e "PGPASSWORD=$PR359_TEST_PASSWORD" "$PR359_TEST_CONTAINER" \
 psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d pr359_real_capture \
 < "$tmp/real-capture.sql" > "$tmp/real-capture-results.txt"
for marker in \
 PR359_REAL_CAPTURE_FUEL_LIFECYCLE_PASS \
 PR359_REAL_CAPTURE_SCOPE_MOVE_PASS \
 PR359_REAL_CAPTURE_PARTS_SCOPE_PASS \
 PR359_REAL_CAPTURE_SOURCE_LOG_ROLLBACK_PASS \
 PR359_REAL_CAPTURE_INVALID_SCOPE_ROLLBACK_PASS \
 PR359_REAL_TRIGGER_FULL_PROJECTION_AND_RLS_VERIFIED=FALSE \
 PR359_REAL_TRIGGER_DEPLOYMENT_APPROVED=FALSE \
 PR359_CANONICAL_BASELINE_APPROVED=FALSE
do
 grep -Fxq "$marker" "$tmp/real-capture-results.txt" || {
  echo "PR359_REAL_CAPTURE_ASSERTION_MISSING=$marker" >&2
  exit 1
 }
done
# Separate rolled-back candidate integration; exact archived projectors, synthetic schema.
node scripts/pr359-canonical/generate-candidate-projector-integration.mjs --out "$tmp/candidate-projectors.sql"
docker exec -i -e "PGPASSWORD=$PR359_TEST_PASSWORD" "$PR359_TEST_CONTAINER" \
 psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d pr359_real_capture \
 < "$tmp/candidate-projectors.sql" > "$tmp/candidate-projector-results.txt"
for marker in PR359_CANDIDATE_FULL_PROJECTOR_PAYLOAD_PASS PR359_CANDIDATE_MOVE_SYNTHETIC_CASCADE_PASS PR359_CANDIDATE_PROJECTOR_ROLLBACK_PASS PR359_CANDIDATE_PROJECTOR_FIXTURE_RESTORE_PASS PR359_REAL_PRODUCER_FULL_CALLER_CLOSURE_APPROVED=FALSE PR359_CANONICAL_BASELINE_APPROVED=FALSE; do
 grep -Fxq "$marker" "$tmp/candidate-projector-results.txt" || { echo "PR359_CANDIDATE_PROJECTOR_MARKER_MISSING=$marker" >&2; exit 1; }
 echo "$marker"
done
# Historical-source indirect trigger characterization, independent rolled-back fixture.
node --test scripts/pr359-canonical/generate-indirect-refresh-disposable.test.mjs
node scripts/pr359-canonical/generate-indirect-refresh-disposable.mjs "$tmp/candidate-projectors.sql" --out "$tmp/indirect-refresh.sql"
docker exec -i -e "PGPASSWORD=$PR359_TEST_PASSWORD" "$PR359_TEST_CONTAINER" \
 psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d pr359_real_capture \
 < "$tmp/indirect-refresh.sql" > "$tmp/indirect-refresh-results.txt"
for marker in PR359_SOURCE_RENAME_BOUNDED_SNAPSHOT_PASS PR359_SOURCE_WAREHOUSE_DUPLICATION_CHARACTERIZED PR359_SOURCE_HISTORICAL_PART_STALENESS_CHARACTERIZED PR359_SOURCE_ITEM_SUPPLIER_REFRESH_PASS PR359_SOURCE_INDIRECT_NOOP_AND_ISOLATION_PASS PR359_SOURCE_INDIRECT_FIXTURE_RESTORE_PASS PR359_CANDIDATE_WAREHOUSE_TARGETED_PARTS_PASS PR359_CANDIDATE_HISTORICAL_PART_PULL_PASS PR359_CANDIDATE_ITEM_TARGETED_PARTS_PASS PR359_CANDIDATE_INDIRECT_ROLLBACK_PASS PR359_CANONICAL_BASELINE_APPROVED=FALSE; do
 grep -Fxq "$marker" "$tmp/indirect-refresh-results.txt" || { echo "PR359_INDIRECT_MARKER_MISSING=$marker" >&2; exit 1; }
 echo "$marker"
done
grep -E '^PR359_SOURCE_INDIRECT_COUNTS=' "$tmp/indirect-refresh-results.txt"
bash scripts/pr359-canonical/cb-a-candidate-concurrency-disposable.sh "$tmp/real-append.sql"
echo PR359_REAL_CAPTURE_THREE_OPERATIONAL_TRIGGERS_PASS
echo PR359_REAL_CAPTURE_SOURCE_LOG_ROLLBACK_PASS
echo PR359_REAL_APPEND_CONCURRENT_CURSOR_2_3_PASS
echo PR359_REAL_APPEND_PULL_ISOLATED_PASS
echo PR359_REAL_PRODUCER_FULL_CALLER_CLOSURE_APPROVED=FALSE
echo PR359_CANONICAL_BASELINE_APPROVED=FALSE
