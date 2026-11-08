#!/usr/bin/env bash
set -euo pipefail

# Disposable CI PostgreSQL only. Refuse to target arbitrary databases.
database="${1:-field_user_feature_policy_guard_test}"
if [[ "$database" != "field_user_feature_policy_guard_test" ]]; then
  echo "Refusing to run field-user concurrency test outside the CI fixture DB" >&2
  exit 2
fi
psql_args=(--host 127.0.0.1 --port 5432 --username postgres --dbname "$database" --no-psqlrc --set ON_ERROR_STOP=1)
tmpdir="$(mktemp -d)"
export FIELD_USER_TEST_LOCK_DIR="$tmpdir"
first_pid=""
second_pid=""

cleanup() {
  touch "$tmpdir/release" || true
  if [[ -n "$first_pid" ]]; then wait "$first_pid" 2>/dev/null || true; fi
  if [[ -n "$second_pid" ]]; then wait "$second_pid" 2>/dev/null || true; fi
  rm -rf "$tmpdir"
}
trap cleanup EXIT

psql "${psql_args[@]}" -c \
  "INSERT INTO public.test_field_user_policy(tenant_id,eligible,enabled,effective_limit)
   VALUES (50,true,true,1),(51,true,true,1);" >/dev/null

cat >"$tmpdir/first.sql" <<'SQL'
BEGIN;
INSERT INTO public.staff_profiles(tenant_id,user_id,role,is_active)
VALUES (50,501,'technician',true);
\! touch "$FIELD_USER_TEST_LOCK_DIR/ready"
\! while [ ! -f "$FIELD_USER_TEST_LOCK_DIR/release" ]; do sleep 0.05; done
COMMIT;
SQL

psql "${psql_args[@]}" --file "$tmpdir/first.sql" >"$tmpdir/first.log" 2>&1 &
first_pid="$!"

ready=false
for _ in {1..80}; do
  if [[ -f "$tmpdir/ready" ]]; then ready=true; break; fi
  if ! kill -0 "$first_pid" 2>/dev/null; then break; fi
  sleep 0.05
done
if [[ "$ready" != true ]]; then
  echo "First quota admission never reached transaction lock barrier" >&2
  cat "$tmpdir/first.log" >&2
  exit 1
fi

psql "${psql_args[@]}" -c \
  "INSERT INTO public.staff_profiles(tenant_id,user_id,role,is_active)
   VALUES (50,502,'technician',true);" >"$tmpdir/second.log" 2>&1 &
second_pid="$!"

blocked=false
for _ in {1..80}; do
  locks="$(psql "${psql_args[@]}" --tuples-only --no-align -c \
    "SELECT count(*) FROM pg_stat_activity
     WHERE datname='field_user_feature_policy_guard_test'
       AND wait_event_type='Lock'
       AND wait_event='advisory';")"
  if [[ "${locks//[[:space:]]/}" =~ ^[1-9][0-9]*$ ]]; then
    blocked=true
    break
  fi
  if ! kill -0 "$second_pid" 2>/dev/null; then break; fi
  sleep 0.05
done
if [[ "$blocked" != true ]]; then
  echo "Second quota admission did not block on advisory lock" >&2
  cat "$tmpdir/second.log" >&2
  exit 1
fi

timeout 5s psql "${psql_args[@]}" -c \
  "INSERT INTO public.staff_profiles(tenant_id,user_id,role,is_active)
   VALUES (51,511,'technician',true);" >"$tmpdir/other-tenant.log" 2>&1 || {
  echo "Other-tenant admission was wrongly blocked" >&2
  cat "$tmpdir/other-tenant.log" >&2
  exit 1
}

touch "$tmpdir/release"
wait "$first_pid"
first_pid=""

second_status=0
wait "$second_pid" || second_status="$?"
second_pid=""
if [[ "$second_status" -eq 0 ]] || ! grep -q 'FIELD_USER_LIMIT_REACHED' "$tmpdir/second.log"; then
  echo "Concurrent same-tenant admission did not reject the second user" >&2
  cat "$tmpdir/second.log" >&2
  exit 1
fi

counts="$(psql "${psql_args[@]}" --tuples-only --no-align -c \
  "SELECT
   (SELECT count(*) FROM public.staff_profiles WHERE tenant_id=50 AND role='technician' AND is_active)
   ||':'||
   (SELECT count(*) FROM public.staff_profiles WHERE tenant_id=51 AND role='technician' AND is_active);")"
if [[ "${counts//[[:space:]]/}" != '1:1' ]]; then
  echo "Unexpected final active-technician counts after concurrency test: $counts" >&2
  exit 1
fi

echo 'FIELD_USER_QUOTA_TWO_SESSION_CONCURRENCY_PASS'
