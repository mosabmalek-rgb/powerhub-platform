#!/usr/bin/env bash
set -euo pipefail
[[ "${PGDATABASE:-}" == powerhub_b5_synthetic_collection_test ]] || exit 2
[[ "${PGHOST:-}" == 127.0.0.1 || "${PGHOST:-}" == localhost ]] || exit 2
[[ "${PGUSER:-}" == postgres ]] || exit 2
db() { psql -XAt --no-psqlrc --set ON_ERROR_STOP=1 --dbname "$PGDATABASE" "$@"; }
[[ "$(db -c 'SELECT current_database()')" == powerhub_b5_synthetic_collection_test ]] || exit 2
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
pids=""
for worker in 1 2 3 4; do
  {
    echo 'SET ROLE service_role;'
    for iteration in $(seq 1 250); do
      printf 'SELECT public.b5_collect_one(%d,%d);\n' "$worker" "$iteration"
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
  [[ "$(grep -c '^COLLECTION_OK$' "$tmp/worker-$worker.out" || true)" == 250 ]] ||
   { echo "B5_COLLECTION_WORKER_FAILED $worker" >&2; exit 1; }
done
db -f supabase/tests/b5_disposable_collection_load_assertions.sql
