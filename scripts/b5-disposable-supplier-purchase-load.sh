#!/usr/bin/env bash
set -euo pipefail
[[ "${PGDATABASE:-}" == inventory_purchase_receiving_test ]] || exit 2
[[ "${PGHOST:-}" == 127.0.0.1 || "${PGHOST:-}" == localhost ]] || exit 2
[[ "${PGUSER:-}" == postgres ]] || exit 2
db() { psql -XAt --no-psqlrc --set ON_ERROR_STOP=1 --dbname "$PGDATABASE" "$@"; }
[[ "$(db -c 'SELECT current_database()')" == inventory_purchase_receiving_test ]] || exit 2
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
pids=""
for worker in 1 2 3 4; do
  {
    echo 'SET ROLE service_role;'
    for iteration in $(seq 1 25); do
      printf 'SELECT public.b5_supplier_load_one(%d,%d);\n' "$worker" "$iteration"
    done
    echo 'RESET ROLE;'
  } | db > "$tmp/out-$worker" 2> "$tmp/err-$worker" &
  pids="$pids $!"
done
failed=0
for pid in $pids; do wait "$pid" || failed=1; done
if [[ "$failed" != 0 ]]; then
  for worker in 1 2 3 4; do cat "$tmp/err-$worker" >&2; done
  exit 1
fi
for worker in 1 2 3 4; do
  [[ "$(grep -c '^SUPPLIER_OK$' "$tmp/out-$worker" || true)" == 25 ]] ||
    { echo "B5_SUPPLIER_WORKER_FAILED $worker" >&2; exit 1; }
done
db -f supabase/tests/b5_disposable_supplier_purchase_load_assertions.sql
