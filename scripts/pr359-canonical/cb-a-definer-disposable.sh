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
candidate_pid=''
cleanup() {
 if [[ -n "$candidate_pid" ]]; then
  kill "$candidate_pid" 2>/dev/null || :
  wait "$candidate_pid" 2>/dev/null || :
 fi
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

# The following isolated-only candidate adds a partial unique index PLUS
# conflict reuse. Run the exact same cross-path overlap as a positive control.
node --test scripts/pr359-canonical/generate-owner-site-candidate.test.mjs
node scripts/pr359-canonical/generate-owner-site-candidate.mjs --out "$tmp/candidate.sql" >/dev/null
docker exec -i -e "PGPASSWORD=$password" "$container" \
 psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres \
 < "$tmp/candidate.sql" > "$tmp/candidate-results.txt"
grep -Fxq PR359_ISOLATED_OWNER_SITE_CANDIDATE_READY "$tmp/candidate-results.txt" || exit 1
coproc OWNER_SITE_TX {
 docker exec -i -e "PGPASSWORD=$password" "$container" \
  psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres
}
owner_pid="$OWNER_SITE_TX_PID"
owner_in="${OWNER_SITE_TX[1]}"
owner_out="${OWNER_SITE_TX[0]}"
printf '%s\n' \
 'BEGIN;' \
 "INSERT INTO public.sites(tenant_id,name,code,status) VALUES(4,'الفرع الرئيسي','PR359-CANDIDATE-SITE','active');" \
 "SELECT 'PR359_CANDIDATE_SITE_UNCOMMITTED';" >&"$owner_in"
marker=''
if ! IFS= read -r -t 25 marker <&"$owner_out" || [[ "$marker" != PR359_CANDIDATE_SITE_UNCOMMITTED ]]; then
 echo PR359_OWNER_SITE_CANDIDATE_SETUP_FAILED >&2; exit 1
fi
# A distinct session should block on unique-index arbitration until A commits.
{
 printf "SET statement_timeout='25s';\n"
 printf "INSERT INTO public.tenant_subscriptions(tenant_id) VALUES(4);\n"
} | docker exec -i -e "PGPASSWORD=$password" "$container" \
 psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres \
 >"$tmp/candidate-b.out" 2>"$tmp/candidate-b.err" &
candidate_pid="$!"
blocked=0
for i in $(seq 1 60); do
 # Inspect only the disposable container's pg_stat_activity. An observed
 # Lock wait demonstrates the candidate arbitrates the competing insertion.
 lock_count="$(printf '%s\n' \
 "SELECT count(*) FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND query LIKE '%INSERT INTO public.tenant_subscriptions(tenant_id) VALUES(4)%' AND wait_event_type='Lock';" |
 docker exec -i -e "PGPASSWORD=$password" "$container" \
 psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres)"
 if [[ "$lock_count" =~ ^[0-9]+$ ]] && ((lock_count >= 1)); then blocked=1; break; fi
 sleep 0.25
done
[[ "$blocked" -eq 1 ]] || {
 echo PR359_EXPECTED_CANDIDATE_CONCURRENT_LOCK_WAIT_MISSING >&2; exit 1;
}
printf 'COMMIT;\n\\q\n' >&"$owner_in"
wait "$owner_pid"
owner_pid=''
wait "$candidate_pid" || {
 echo PR359_CANDIDATE_CONCURRENT_SUBSCRIPTION_INSERT_FAILED >&2
 cat "$tmp/candidate-b.err" >&2; exit 1
}
candidate_pid=''
candidate_sites="$(printf '%s\n' \
 "SELECT count(*) FROM public.sites WHERE tenant_id=4 AND name='الفرع الرئيسي';" |
 docker exec -i -e "PGPASSWORD=$password" "$container" \
 psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres)"
candidate_staff="$(printf '%s\n' \
 "SELECT count(*) FROM public.staff_profiles st JOIN public.sites si ON si.id=st.site_id WHERE st.tenant_id=4 AND si.tenant_id=4 AND st.user_id=400 AND st.role='owner';" |
 docker exec -i -e "PGPASSWORD=$password" "$container" \
 psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres)"
[[ "$candidate_sites" == 1 && "$candidate_staff" == 1 ]] || {
 echo "PR359_CANDIDATE_CONCURRENT_DUPLICATE_OR_OWNER_BINDING sites=$candidate_sites staff=$candidate_staff" >&2; exit 1
}
# The historical fixture runs in the SAME disposable PostgreSQL database.
# It must not touch hosted data, resolve duplicates, or turn capped Delta
# refresh into a claim of complete historical event coverage.
node --test scripts/pr359-canonical/historical-site-and-generator-boundaries.test.mjs
[[ -s scripts/pr359-canonical/fixtures/historical-site-and-generator-boundaries.sql ]] || {
 echo PR359_HISTORICAL_BOUNDARY_FIXTURE_MISSING >&2; exit 1;
}
docker exec -i -e "PGPASSWORD=$password" "$container" \
 psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres \
 < scripts/pr359-canonical/fixtures/historical-site-and-generator-boundaries.sql \
 > "$tmp/historical-results.txt"
for expected in \
 PR359_HISTORICAL_DUPLICATES_REJECT_INDEX_WITHOUT_DATA_LOSS \
 PR359_HISTORICAL_CLEAN_INDEX_PREDICATE_PASS \
 PR359_GENERATOR_FIRST_REMAINS_BOUNDED_ABOVE_TARGET_500_200 \
 PR359_FULL_GENERATOR_HISTORY_DELTA_PROVEN=FALSE \
 PR359_HISTORICAL_DATA_RECONCILIATION_APPROVED=FALSE \
 PR359_CANONICAL_BASELINE_APPROVED=FALSE \
 PR359_STAGING_INPLACE_GO=FALSE \
 PR359_PRODUCTION_INPLACE_GO=FALSE
do
 grep -Fxq "$expected" "$tmp/historical-results.txt" || {
  echo "PR359_HISTORICAL_BOUNDARY_ASSERTION_MISSING=$expected" >&2; exit 1;
 }
done
# A separate synthetic full-history keyset contrast (not a deployed
# trigger) proves the capped Delta window is distinct from explicit backfill.
node --test scripts/pr359-canonical/generator-full-history-keyset-contrast.test.mjs
docker exec -i -e "PGPASSWORD=$password" "$container" \
 psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres \
 < scripts/pr359-canonical/fixtures/generator-full-history-keyset-contrast.sql \
 > "$tmp/keyset-results.txt"
for expected in \
 PR359_LOCAL_KEYSET_GENERATOR_501_FUEL_201_MAINTENANCE_PASS \
 PR359_LOCAL_KEYSET_PRODUCER_REAL_RUNTIME_PROOF=FALSE \
 PR359_KEYSET_CROSS_TRANSACTION_REPLAY_PROVEN=FALSE \
 PR359_KEYSET_DEPLOYMENT_APPROVED=FALSE \
 PR359_CANONICAL_BASELINE_APPROVED=FALSE
do
 grep -Fxq "$expected" "$tmp/keyset-results.txt" || {
  echo "PR359_KEYSET_ASSERTION_MISSING=$expected" >&2; exit 1;
 }
done
echo PR359_LOCAL_KEYSET_HISTORY_CONTRAST_PASS
# Keyset recovery must survive a new connection and persist checkpoint
# atomically with a synthetic sink, even after an injected SQL exception.
# All fixture calls use the SAME isolated container with --network none.
node --test scripts/pr359-canonical/keyset-restart.test.mjs
for phase in setup failure first-page after-crash; do
 fixture="scripts/pr359-canonical/fixtures/keyset-restart-$phase.sql"
 [[ -s "$fixture" ]] || { echo "PR359_KEYSET_FIXTURE_MISSING=$phase" >&2; exit 1; }
 docker exec -i -e "PGPASSWORD=$password" "$container" \
  psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < "$fixture" > "$tmp/keyset-$phase-results.txt"
done
for assertion in \
 "setup:PR359_ISOLATED_KEYSET_CHECKPOINT_SETUP_PASS" \
 "failure:PR359_ISOLATED_KEYSET_INJECTED_FAILURE_ROLLBACK_PASS" \
 "first-page:PR359_ISOLATED_KEYSET_FIRST_PAGE_COMMITTED_PASS" \
 "after-crash:PR359_ISOLATED_KEYSET_CROSS_CONNECTION_RECOVERY_PASS" \
 "after-crash:PR359_ISOLATED_KEYSET_HIGH_WATER_MARK_PASS" \
 "after-crash:PR359_REAL_DELTA_OUTBOX_ATOMICITY_PROVEN=FALSE" \
 "after-crash:PR359_CROSS_DEVICE_IDEMPOTENCY_PROVEN=FALSE" \
 "after-crash:PR359_CANONICAL_BASELINE_APPROVED=FALSE"
do
 phase="${assertion%%:*}"
 marker="${assertion#*:}"
 grep -Fxq "$marker" "$tmp/keyset-$phase-results.txt" || {
  echo "PR359_KEYSET_RECOVERY_MISSING=$marker" >&2; exit 1;
 }
done
# Independent sequence-based journal: changes to earlier event IDs and
# deletion tombstones must be replayed after a crash, and only a new snapshot
# may consume changes occurring after the original high-water mark.
node --test scripts/pr359-canonical/journal-restart.test.mjs
for phase in setup failure first-page resume; do
 fixture="scripts/pr359-canonical/fixtures/journal-restart-$phase.sql"
 [[ -s "$fixture" ]] || { echo "PR359_JOURNAL_FIXTURE_MISSING=$phase" >&2; exit 1; }
 docker exec -i -e "PGPASSWORD=$password" "$container" \
  psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < "$fixture" > "$tmp/journal-$phase-results.txt"
done
for assertion in \
 "setup:PR359_ISOLATED_CHANGE_JOURNAL_SETUP_PASS" \
 "failure:PR359_ISOLATED_CHANGE_JOURNAL_FAILURE_ROLLBACK_PASS" \
 "first-page:PR359_ISOLATED_CHANGE_JOURNAL_FIRST_PAGE_COMMITTED_PASS" \
 "resume:PR359_ISOLATED_CHANGE_JOURNAL_CROSS_CONNECTION_RECOVERY_PASS" \
 "resume:PR359_ISOLATED_CHANGE_JOURNAL_TOMBSTONE_AND_NEW_SNAPSHOT_PASS" \
 "resume:PR359_REAL_DELTA_PRODUCER_ATOMICITY_PROVEN=FALSE" \
 "resume:PR359_REAL_CHANGE_JOURNAL_CAPTURE_PROVEN=FALSE" \
 "resume:PR359_CANONICAL_BASELINE_APPROVED=FALSE"
do
 phase="${assertion%%:*}"
 marker="${assertion#*:}"
 grep -Fxq "$marker" "$tmp/journal-$phase-results.txt" || {
  echo "PR359_JOURNAL_RECOVERY_MISSING=$marker" >&2; exit 1;
 }
done
# NEGATIVE CONTROL: IDENTITY/sequence allocation order is not commit order.
# A allocates a lower journal sequence and holds an uncommitted insert.
# B allocates and commits a higher one; the consumer can advance past A.
# All sessions remain in this --network none disposable database.
printf '%s\n' "INSERT INTO public.pr359_synthetic_change_checkpoint(tenant_id,site_id,generator_id,kind,cursor_seq,snapshot_upper_seq) VALUES(77,70,7,'fuel_events',0,0);" |
 docker exec -i -e "PGPASSWORD=$password" "$container" \
 psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null
coproc JOURNAL_EARLY_WRITER {
 docker exec -i -e "PGPASSWORD=$password" "$container" \
 psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres
}
owner_pid="$JOURNAL_EARLY_WRITER_PID"
owner_in="${JOURNAL_EARLY_WRITER[1]}"
owner_out="${JOURNAL_EARLY_WRITER[0]}"
printf '%s\n' \
 'BEGIN;' \
 "INSERT INTO public.pr359_synthetic_change_journal(tenant_id,site_id,generator_id,kind,event_id,change_kind,revision) VALUES(77,70,7,'fuel_events',701,'upsert',1);" \
 "SELECT 'PR359_LOWER_SEQUENCE_UNCOMMITTED';" >&"$owner_in"
marker=''
if ! IFS= read -r -t 25 marker <&"$owner_out" || [[ "$marker" != PR359_LOWER_SEQUENCE_UNCOMMITTED ]]; then
 echo PR359_JOURNAL_COMMIT_ORDER_SETUP_FAILED >&2; exit 1
fi
printf '%s\n' \
 "INSERT INTO public.pr359_synthetic_change_journal(tenant_id,site_id,generator_id,kind,event_id,change_kind,revision) VALUES(77,70,7,'fuel_events',702,'upsert',1);" \
 "UPDATE public.pr359_synthetic_change_checkpoint SET snapshot_upper_seq=(SELECT max(change_seq) FROM public.pr359_synthetic_change_journal WHERE tenant_id=77 AND site_id=70 AND generator_id=7 AND kind='fuel_events') WHERE tenant_id=77 AND site_id=70 AND generator_id=7 AND kind='fuel_events';" \
 "SELECT public.pr359_synthetic_apply_change_page(77,70,7,'fuel_events',128,false);" |
 docker exec -i -e "PGPASSWORD=$password" "$container" \
 psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres > "$tmp/journal-order-visible.txt"
grep -Fxq 1 "$tmp/journal-order-visible.txt" || {
 echo PR359_EXPECTED_ONLY_HIGHER_SEQUENCE_VISIBLE >&2; exit 1
}
printf 'COMMIT;\n\\q\n' >&"$owner_in"
wait "$owner_pid"
owner_pid=''
printf '%s\n' \
 "SELECT CASE WHEN (SELECT count(*) FROM public.pr359_synthetic_change_journal WHERE tenant_id=77 AND site_id=70 AND generator_id=7)=2 AND (SELECT count(*) FROM public.pr359_synthetic_change_sink WHERE tenant_id=77 AND site_id=70 AND generator_id=7)=1 AND EXISTS(SELECT 1 FROM public.pr359_synthetic_change_journal j WHERE j.tenant_id=77 AND j.event_id=701 AND j.change_seq<(SELECT cursor_seq FROM public.pr359_synthetic_change_checkpoint WHERE tenant_id=77 AND site_id=70 AND generator_id=7)) AND NOT EXISTS(SELECT 1 FROM public.pr359_synthetic_change_sink WHERE tenant_id=77 AND event_id=701) THEN 'PR359_SEQUENCE_COMMIT_ORDER_GAP_REPRODUCED' ELSE 'FAILED' END;" |
 docker exec -i -e "PGPASSWORD=$password" "$container" \
 psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres > "$tmp/journal-order-result.txt"
grep -Fxq PR359_SEQUENCE_COMMIT_ORDER_GAP_REPRODUCED "$tmp/journal-order-result.txt" || {
 echo PR359_COMMIT_ORDER_NEGATIVE_CONTROL_FAILED >&2; exit 1
}
echo PR359_SEQUENCE_COMMIT_ORDER_GAP_REPRODUCED
echo PR359_PRODUCTION_SEQUENCE_ORDERING_APPROVED=FALSE
# POSITIVE SYNTHETIC CONTRAST: both producers take the SAME transaction
# advisory lock for this scope BEFORE allocating a change sequence.
# This serializes only compliant writers; it does not validate production.
printf '%s\n' "INSERT INTO public.pr359_synthetic_change_checkpoint(tenant_id,site_id,generator_id,kind,cursor_seq,snapshot_upper_seq) VALUES(78,70,7,'fuel_events',0,0);" |
 docker exec -i -e "PGPASSWORD=$password" "$container" \
 psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null
coproc JOURNAL_SERIAL_WRITER {
 docker exec -i -e "PGPASSWORD=$password" "$container" \
 psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres
}
owner_pid="$JOURNAL_SERIAL_WRITER_PID"
owner_in="${JOURNAL_SERIAL_WRITER[1]}"
owner_out="${JOURNAL_SERIAL_WRITER[0]}"
printf '%s\n' \
 'BEGIN;' \
 'DO $guard$ BEGIN PERFORM pg_advisory_xact_lock(78,7); END $guard$;' \
 "INSERT INTO public.pr359_synthetic_change_journal(tenant_id,site_id,generator_id,kind,event_id,change_kind,revision) VALUES(78,70,7,'fuel_events',801,'upsert',1);" \
 "SELECT 'PR359_SERIAL_JOURNAL_WRITER_UNCOMMITTED';" >&"$owner_in"
marker=''
if ! IFS= read -r -t 25 marker <&"$owner_out" || [[ "$marker" != PR359_SERIAL_JOURNAL_WRITER_UNCOMMITTED ]]; then
 echo PR359_SERIAL_JOURNAL_FIRST_SETUP_FAILED >&2; exit 1
fi
{
 printf '%s\n' 'BEGIN;' \
  'DO $guard$ BEGIN PERFORM pg_advisory_xact_lock(78,7); END $guard$;' \
  "INSERT INTO public.pr359_synthetic_change_journal(tenant_id,site_id,generator_id,kind,event_id,change_kind,revision) VALUES(78,70,7,'fuel_events',802,'upsert',1);" \
  'COMMIT;'
} | docker exec -i -e "PGPASSWORD=$password" "$container" \
 psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres \
 >"$tmp/journal-serial-b.txt" 2>"$tmp/journal-serial-b.err" &
candidate_pid="$!"
blocked=0
for i in $(seq 1 80); do
 lock_count="$(printf '%s\n' \
 "SELECT count(*) FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock(78,7)%';" |
 docker exec -i -e "PGPASSWORD=$password" "$container" \
 psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres)"
 if [[ "$lock_count" =~ ^[0-9]+$ ]] && ((lock_count>=1)); then blocked=1; break; fi
 sleep 0.25
done
[[ "$blocked" -eq 1 ]] || {
 echo PR359_SERIAL_JOURNAL_LOCK_WAIT_MISSING >&2; exit 1
}
printf 'COMMIT;\n\\q\n' >&"$owner_in"
wait "$owner_pid"
owner_pid=''
wait "$candidate_pid" || {
 cat "$tmp/journal-serial-b.err" >&2
 echo PR359_SERIAL_JOURNAL_SECOND_FAILED >&2; exit 1
}
candidate_pid=''
printf '%s\n' \
 "UPDATE public.pr359_synthetic_change_checkpoint SET snapshot_upper_seq=(SELECT max(change_seq) FROM public.pr359_synthetic_change_journal WHERE tenant_id=78 AND site_id=70 AND generator_id=7 AND kind='fuel_events') WHERE tenant_id=78 AND site_id=70 AND generator_id=7 AND kind='fuel_events';" \
 "SELECT public.pr359_synthetic_apply_change_page(78,70,7,'fuel_events',128,false);" \
 "SELECT CASE WHEN (SELECT count(*) FROM public.pr359_synthetic_change_sink WHERE tenant_id=78 AND site_id=70 AND generator_id=7)=2 AND (SELECT count(*) FROM public.pr359_synthetic_change_journal WHERE tenant_id=78 AND site_id=70 AND generator_id=7)=2 AND NOT EXISTS(SELECT 1 FROM public.pr359_synthetic_change_journal j WHERE j.tenant_id=78 AND NOT EXISTS(SELECT 1 FROM public.pr359_synthetic_change_sink s WHERE s.tenant_id=j.tenant_id AND s.site_id=j.site_id AND s.generator_id=j.generator_id AND s.event_id=j.event_id)) THEN 'PR359_SERIAL_JOURNAL_NO_GAP_PASS' ELSE 'FAILED' END;" |
 docker exec -i -e "PGPASSWORD=$password" "$container" \
 psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres >"$tmp/journal-serial-result.txt"
grep -Fxq 2 "$tmp/journal-serial-result.txt" || exit 1
grep -Fxq PR359_SERIAL_JOURNAL_NO_GAP_PASS "$tmp/journal-serial-result.txt" || {
 echo PR359_SERIAL_JOURNAL_SCOPE_MISSING_EVENT >&2; exit 1
}
echo PR359_SERIAL_JOURNAL_NO_GAP_PASS
echo PR359_SERIAL_JOURNAL_PRODUCTION_APPROVED=FALSE
echo PR359_CB_A_CHANGE_JOURNAL_TOMBSTONE_RECOVERY_PASS
echo PR359_CB_A_CROSS_CONNECTION_KEYSET_RECOVERY_PASS
echo PR359_CB_A_HISTORICAL_INDEX_AND_GENERATOR_CAP_BOUNDARY_PASS
echo PR359_OWNER_SITE_CANDIDATE_CROSS_PATH_CONCURRENCY_PASS
echo PR359_OWNER_SITE_CANDIDATE_PRODUCTION_APPROVED=FALSE
echo PR359_CB_A_DISPOSABLE_DEFINER_REPLAY_PASS
echo PR359_LOCAL_GENERATOR_CANDIDATE_ONLY=NOT_APPROVED
echo PR359_CANONICAL_BASELINE_APPROVED=FALSE
