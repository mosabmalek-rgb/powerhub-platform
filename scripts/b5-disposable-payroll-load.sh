#!/usr/bin/env bash
set -euo pipefail
# Strictly local throwaway PostgreSQL; no Staging/Production payroll or transfers.
[[ "${PGDATABASE:-}" == "powerhub_b5_synthetic_payroll_test" ]] || { echo B5_PAYROLL_WRONG_DATABASE >&2; exit 2; }
[[ "${PGHOST:-}" == "127.0.0.1" || "${PGHOST:-}" == "localhost" ]] || { echo B5_PAYROLL_REMOTE_HOST_REJECTED >&2; exit 2; }
[[ "${PGUSER:-}" == "postgres" ]] || { echo B5_PAYROLL_USER_REJECTED >&2; exit 2; }
db() { psql -XAt --no-psqlrc --set ON_ERROR_STOP=1 --dbname "$PGDATABASE" "$@"; }
[[ "$(db -c 'SELECT current_database()')" == "powerhub_b5_synthetic_payroll_test" ]] || exit 2
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
pids=""
for worker in 1 2 3 4; do
  {
    echo 'SET ROLE service_role;'
    for i in $(seq 1 100); do
      printf 'SELECT public.b5_payroll_approval_sample(%d,%d,false);\n' "$worker" "$i"
    done
    echo 'RESET ROLE;'
  } | db > "$tmp/worker-$worker.out" 2> "$tmp/worker-$worker.err" &
  pids="$pids $!"
done
failed=0
for pid in $pids; do wait "$pid" || failed=1; done
if [[ "$failed" != 0 ]]; then
  for worker in 1 2 3 4; do cat "$tmp/worker-$worker.err" >&2; done
  exit 1
fi
for worker in 1 2 3 4; do
  [[ "$(grep -c '^PAYROLL_OK$' "$tmp/worker-$worker.out" || true)" == 100 ]] ||
    { echo "B5_PAYROLL_WORKER_FAILED $worker" >&2; exit 1; }
done
# Four exact replays, after first-time approvals: never create extra audit rows.
db -c "SET ROLE service_role; SELECT public.b5_payroll_approval_sample(1,1,true), public.b5_payroll_approval_sample(2,1,true), public.b5_payroll_approval_sample(3,1,true), public.b5_payroll_approval_sample(4,1,true); RESET ROLE;" > "$tmp/replay.out"
db -f supabase/tests/b5_disposable_payroll_load_assertions.sql
