#!/usr/bin/env bash
set -euo pipefail
# B5 standalone synthetic financial load: never connects to hosted databases.
if [[ "$PGDATABASE" != "powerhub_b5_synthetic_load_test" ]] ||
   [[ "$PGHOST" != "127.0.0.1" && "$PGHOST" != "localhost" ]] ||
   [[ "$PGUSER" != "postgres" ]]; then
  echo B5_DISPOSABLE_LOCAL_DATABASE_ONLY >&2; exit 2
fi
db() { psql -XAt --no-psqlrc --set ON_ERROR_STOP=1 --dbname "$PGDATABASE" "$@"; }
[[ "$(db -c 'SELECT current_database()')" == "powerhub_b5_synthetic_load_test" ]] || exit 2
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
pids=""
start="$(date +%s)"
for worker in 1 2 3 4; do
  {
    echo 'SET ROLE service_role;'
    for iteration in $(seq 1 25); do
      printf 'SELECT public.b5_execute_synthetic_movement(%d,%d);\n' "$worker" "$iteration"
    done
    echo 'RESET ROLE;'
  } | db > "$dir/out-$worker" 2> "$dir/err-$worker" &
  pids="$pids $!"
done
failed=0
for pid in $pids; do wait "$pid" || failed=1; done
if [[ "$failed" != 0 ]]; then
  for worker in 1 2 3 4; do cat "$dir/err-$worker" >&2; done
  exit 1
fi
for worker in 1 2 3 4; do
  [[ "$(grep -c '^B5_OK$' "$dir/out-$worker" || true)" == 25 ]] ||
    { echo "B5_WORKER_RESULT_MISMATCH $worker" >&2; exit 1; }
done
echo "B5 four concurrent SQL backends finished in $(($(date +%s)-start)) seconds"
db -f supabase/tests/b5_disposable_single_site_load_assertions.sql
