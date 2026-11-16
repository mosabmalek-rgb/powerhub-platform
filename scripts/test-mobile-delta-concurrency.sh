#!/usr/bin/env bash
# Deterministic two-connection commit-order / highwater regression against
# disposable PostgreSQL only. No Staging or production credentials are used.
set -euo pipefail
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD=postgres
export PGDATABASE=mobile_delta_journal_test
dir="$(mktemp -d)"
trap 'touch "$dir/release" 2>/dev/null || true; wait || true; rm -rf "$dir"' EXIT
# Connection A appends the first event then holds the tenant transaction
# advisory lock while connection B attempts to append the second event.
(
  psql -X -v ON_ERROR_STOP=1 -q <<SQL >"$dir/a.log" 2>&1
BEGIN;
SELECT public.powerhub_mobile_append_subscriber_change(10,101,3001,'touch',7,7);
\! touch "$dir/a-locked"
\! for i in \$(seq 1 200); do test -f "$dir/release" && exit 0; sleep 0.1; done; exit 1
COMMIT;
SQL
  touch "$dir/a-done"
) &
pid_a=$!
for i in $(seq 1 100); do
  test -f "$dir/a-locked" && break
  sleep 0.1
done
test -f "$dir/a-locked" || { echo "A did not acquire the lock"; exit 1; }
(
  psql -X -v ON_ERROR_STOP=1 -q <<'SQL' >"$dir/b.log" 2>&1
BEGIN;
SELECT public.powerhub_mobile_append_subscriber_change(10,101,3002,'touch',8,8);
COMMIT;
SQL
  touch "$dir/b-done"
) &
pid_b=$!
# Ensure B really waited for the advisory lock, not merely started later.
waited=false
for i in $(seq 1 100); do
  blocked="$(psql -X -Atqc "SELECT count(*) FROM pg_stat_activity
    WHERE datname=current_database() AND wait_event_type='Lock'
    AND query LIKE '%powerhub_mobile_append_subscriber_change%'
    AND query NOT LIKE '%pg_stat_activity%';")"
  if [[ "$blocked" =~ ^[1-9][0-9]*$ ]]; then waited=true; break; fi
  sleep 0.1
done
if [[ "$waited" != true ]]; then
  echo "B was not observed waiting for A's transaction lock"
  exit 1
fi
# No second event may be visible or sequence allocated while A is uncommitted.
visible="$(psql -X -Atqc "SELECT count(*) FROM public.mobile_subscriber_change_log
  WHERE tenant_id=10 AND subscriber_id IN (3001,3002);")"
test "$visible" = "0" || { echo "Uncommitted event leaked: $visible"; exit 1; }
touch "$dir/release"
wait "$pid_a" "$pid_b"
psql -X -v ON_ERROR_STOP=1 <<'SQL'
DO $test$
DECLARE
  a bigint; b bigint;
  n bigint;
  max_seen bigint;
BEGIN
  SELECT sequence_id INTO a FROM public.mobile_subscriber_change_log
    WHERE tenant_id=10 AND subscriber_id=3001;
  SELECT sequence_id INTO b FROM public.mobile_subscriber_change_log
    WHERE tenant_id=10 AND subscriber_id=3002;
  IF a IS NULL OR b IS NULL OR a>=b THEN
    RAISE EXCEPTION 'E51_COMMIT_ORDER_OR_LOST_EVENT a=% b=%',a,b;
  END IF;
  SELECT count(*) INTO n FROM public.mobile_subscriber_change_log
    WHERE tenant_id=10 AND subscriber_id IN(3001,3002);
  IF n<>2 THEN RAISE EXCEPTION 'E51_DUPLICATED_EVENT %',n; END IF;
  SELECT highwater INTO max_seen FROM public.powerhub_mobile_delta_fence(10,101);
  IF max_seen<>b THEN RAISE EXCEPTION 'E51_HIGHWATER_NOT_LAST_COMMITTED % vs %',max_seen,b; END IF;
END $test$;
SELECT 'E51_TWO_CONNECTION_COMMIT_ORDER_PASS' AS result;
SQL
