#!/usr/bin/env bash
set -euo pipefail

: "\${PGHOST:=127.0.0.1}"
: "\${PGPORT:=5432}"
: "\${PGUSER:=postgres}"
: "\${PGDATABASE:?PGDATABASE must identify the disposable cycle-guard database}"
export PGHOST PGPORT PGUSER PGDATABASE

first_log="$(mktemp)"
second_log="$(mktemp)"
cleanup() {
  rm -f "$first_log" "$second_log"
}
trap cleanup EXIT

psql --no-psqlrc --set ON_ERROR_STOP=1 --dbname "$PGDATABASE" >"$first_log" 2>&1 <<'SQL' &
begin;
insert into public.meter_readings (tenant_id, subscriber_id, reading_at)
values (1, 1100, '2026-11-05 10:00:00+02');
select pg_sleep(2);
commit;
SQL
first_pid=$!

sleep 0.35
set +e
psql --no-psqlrc --set ON_ERROR_STOP=1 --dbname "$PGDATABASE" \
  --command "insert into public.meter_readings (tenant_id, subscriber_id, reading_at) values (1, 1100, '2026-11-06 10:00:00+02')" \
  >"$second_log" 2>&1
second_status=$?
set -e

wait "$first_pid"

if [[ "$second_status" -eq 0 ]]; then
  echo "Concurrent second reading unexpectedly committed."
  cat "$second_log"
  exit 1
fi
if ! grep -q "READING_ALREADY_EXISTS_IN_CYCLE" "$second_log"; then
  echo "Concurrent insert failed for an unexpected reason:"
  cat "$second_log"
  exit 1
fi

echo "Concurrent cycle duplicate was rejected after the first transaction committed."
