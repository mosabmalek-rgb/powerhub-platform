#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.." 
mode="${1:-}"
[[ "$mode" == smoke || "$mode" == full || "$mode" == staging-restore ]] || { echo 'Usage: run.sh smoke|full|staging-restore' >&2; exit 2; }
for tool in docker node sha256sum; do command -v "$tool" >/dev/null || { echo "Missing: $tool" >&2; exit 2; }; done
work="$(mktemp -d)"
container=''
stack_dir=''
stack_network=''
target_db_url=''
cleanup(){
  if [[ "${mode:-}" != smoke && -n "$stack_dir" && -f "$stack_dir/supabase/config.toml" ]]; then
    (cd "$stack_dir" && supabase stop --no-backup >/dev/null 2>&1) || :
  fi
  if [[ -n "$container" && "$mode" == smoke ]]; then docker rm -f "$container" >/dev/null 2>&1 || :; fi
  if [[ -n "$stack_network" ]]; then docker network rm "$stack_network" >/dev/null 2>&1 || :; fi
  rm -rf -- "$work" "$stack_dir";
}
# Print resource metadata only, never database SQL/dump contents, credentials or raw container logs.
shadow_diagnose(){
  local code="$1"
  [[ "$mode" != smoke ]] || return 0
  echo "PR359_SHADOW_FAILURE_STAGE=${SHADOW_STAGE:-unknown}; EXIT_CODE=$code" >&2
  if [[ -n "$container" ]] && docker inspect "$container" >/dev/null 2>&1; then
    docker inspect --format 'PR359_SHADOW_DOCKER_STATE running={{.State.Running}} oom_killed={{.State.OOMKilled}} exit_code={{.State.ExitCode}}' "$container" >&2 || :
    docker stats --no-stream --format 'PR359_SHADOW_DOCKER_MEM={{.MemUsage}}' "$container" >&2 || :
  else
    echo 'PR359_SHADOW_CONTAINER_NOT_AVAILABLE' >&2
  fi
  if command -v free >/dev/null 2>&1; then
    free -m | awk 'NR==2 {printf "PR359_SHADOW_HOST_MEM_MB total=%s available=%s used=%s\\n", $2,$7,$3}' >&2 || :
  fi
  if command -v df >/dev/null 2>&1; then
    df -Pm "$work" | awk 'NR==2 {printf "PR359_SHADOW_TMP_STORAGE_MB total=%s available=%s used=%s\\n",$2,$4,$3}' >&2 || :
  fi
  if [[ "$code" -eq 137 ]]; then
    echo 'PR359_SHADOW_SIGKILL_137: resource exhaustion is suspected, but must be confirmed using the captured Docker/host metrics' >&2
  fi
}
on_exit(){
  local code="$?"
  if [[ "$code" -ne 0 ]]; then shadow_diagnose "$code"; fi
  cleanup
  return "$code"
}
trap on_exit EXIT
password="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
start(){
  if [[ "${mode:-}" != smoke ]]; then
    if [[ -n "$stack_dir" && -f "$stack_dir/supabase/config.toml" ]]; then
      (cd "$stack_dir" && supabase stop --no-backup >/dev/null 2>&1) || :
      [[ -n "$stack_network" ]] && docker network rm "$stack_network" >/dev/null 2>&1 || :
      stack_dir=''; stack_network=''; target_db_url=''; container=''
    fi
    stack_dir="$(mktemp -d)"
    stack_network="pr359-shadow-stack-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
    docker network create -o com.docker.network.bridge.host_binding_ipv4=127.0.0.1 "$stack_network" >/dev/null
    (cd "$stack_dir" && supabase init --yes >/dev/null 2>&1 &&
      supabase start --network-id "$stack_network" \
        --exclude studio,imgproxy,mailpit,edge-runtime,logflare,vector,supavisor,postgres-meta >/dev/null 2>&1)
    target_db_url="$(cd "$stack_dir" && supabase status -o env | sed -n 's/^DB_URL=//p' | head -1 | tr -d '"')"
    [[ "$target_db_url" =~ ^postgres(ql)?://[^@]+@127[.]0[.]0[.]1:[0-9]+/postgres$ ]] || {
      echo 'PR359_LOCAL_STACK_DB_ENDPOINT_NOT_LOOPBACK' >&2; exit 1;
    }
    container="$(docker ps --filter "network=$stack_network" --filter 'name=supabase_db' --format '{{.ID}}' | head -1)"
    [[ -n "$container" ]] || { echo 'PR359_LOCAL_STACK_DB_CONTAINER_MISSING' >&2; exit 1; }
    return 0
  fi
  local image="$1"
  if [[ -n "$container" ]]; then docker rm -f "$container" >/dev/null; fi
  container="pr359-shadow-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
  docker run --rm -d --network none --name "$container" -e "POSTGRES_PASSWORD=$password" -e POSTGRES_DB=postgres "$image" >/dev/null
  local stable_ready=0
  for i in $(seq 1 120); do
    if docker exec "$container" pg_isready -h 127.0.0.1 -p 5432 -U postgres -d postgres >/dev/null 2>&1; then
      stable_ready=$((stable_ready + 1))
      if [[ "$stable_ready" -ge 2 ]]; then break; fi
    else
      stable_ready=0
    fi
    sleep 1
  done
  [[ "$stable_ready" -ge 2 ]] || { echo 'PR359_DOCKER_FINAL_POSTMASTER_NOT_READY: TCP readiness never stabilized' >&2; exit 1; }
  [[ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$container")" == none ]] || exit 1
  [[ -z "$(docker port "$container")" ]] || { echo 'Unexpected published Docker port' >&2; exit 1; }
}

sql(){
  if [[ "${mode:-}" != smoke ]]; then
    psql -X -w -qAt -v ON_ERROR_STOP=1 --dbname "$target_db_url"
  else
    docker exec -i -e "PGPASSWORD=$password" "$container" psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d "${1:-postgres}"
  fi
}
runfile(){ sql "$1" < "$2" >/dev/null; }
# In the full run the DB URL is the disposable Local Stack endpoint only.
# In smoke this remains the isolated Docker-only admin bootstrap.
sql_local_admin(){
  if [[ "${mode:-}" != smoke ]]; then
    # Local Stack may expose the DB URL with a non-superuser-compatible
    # password policy. Bootstrap privileged roles over the disposable DB
    # container's Unix socket instead; this never reaches the hosted source.
    docker exec -i "$container" psql -X -w -qAt -v ON_ERROR_STOP=1 -U supabase_admin -d postgres
  else
    docker exec -i -e "PGPASSWORD=$password" "$container" psql -X -w -qAt -v ON_ERROR_STOP=1 -U supabase_admin -d postgres
  fi
}
runfile_local_admin(){ sql_local_admin < "$1" >/dev/null; }
assert_local_admin(){
  local result
  if ! result="$(printf '%s\n' "SELECT current_user IN ('postgres','supabase_admin') AND (SELECT rolsuper FROM pg_roles WHERE rolname=current_user);" | sql_local_admin 2>/dev/null)"; then
    echo 'PR359_LOCAL_SUPERUSER_UNAVAILABLE: isolated Supabase image cannot authenticate supabase_admin' >&2; exit 1
  fi
  [[ "$result" == t ]] || { echo 'PR359_LOCAL_SUPERUSER_REQUIRED: local Supabase admin role lacks superuser' >&2; exit 1; }
}
value(){ printf '%s\n' "$1" | sql postgres | tail -1; }
if [[ "${mode:-}" == smoke ]]; then
  start postgres:17.6
  # Test local-only reserved role initialization and idempotence.
  runfile postgres scripts/pr359-shadow/bootstrap-realtime-role.sql
  runfile postgres scripts/pr359-shadow/bootstrap-realtime-role.sql
  # Simulate the older managed Auth schema before applying the exact source-attested additive patch.
  printf 'CREATE SCHEMA auth; CREATE TABLE auth.audit_log_entries (id uuid PRIMARY KEY);\n' | sql postgres >/dev/null
  runfile postgres scripts/pr359-shadow/bootstrap-auth-audit-column.sql
  runfile postgres scripts/pr359-shadow/bootstrap-auth-audit-column.sql
  [[ "$(value "SELECT count(*) FROM information_schema.columns WHERE table_schema='auth' AND table_name='audit_log_entries' AND column_name='ip_address' AND data_type='character varying' AND character_maximum_length=64 AND is_nullable='NO';")" == 1 ]] || { echo 'PR359_DOCKER_AUTH_COMPAT_TEST_FAILED' >&2; exit 1; }
  runfile postgres supabase/tests/pr359_full_legacy_backfill_setup.sql
  for i in 1 2; do
    runfile postgres supabase/migrations/20261103145232_powerhub_legacy_unlinked_payments_to_subscriber_credit.sql
    runfile postgres supabase/tests/pr359_full_legacy_backfill_assert.sql
  done
  docker exec -e "PGPASSWORD=$password" "$container" createdb -U postgres shadow_failure
  runfile shadow_failure supabase/tests/pr359_full_legacy_backfill_setup.sql
  { printf 'BEGIN;\n'; cat supabase/migrations/20261103145232_powerhub_legacy_unlinked_payments_to_subscriber_credit.sql;
    printf "\nDO \$fault\$ BEGIN RAISE EXCEPTION 'PR359_CONTROLLED_DOCKER_FAULT'; END \$fault\$;\nCOMMIT;\n"; } > "$work/fault.sql"
  if sql shadow_failure < "$work/fault.sql" >"$work/fault.log" 2>&1; then echo 'Expected failure missing' >&2;exit 1;fi
  grep -q PR359_CONTROLLED_DOCKER_FAULT "$work/fault.log" || { echo 'Unexpected error before fault boundary' >&2;exit 1; }
  runfile shadow_failure supabase/tests/pr359_full_legacy_backfill_rollback_assert.sql
  # Exercise the SAME privileged bootstrap on the real Supabase Postgres image.
  # A plain postgres:17 image cannot reproduce Supabase reserved-role guards.
  start supabase/postgres:17.6.1.155
  assert_local_admin
  runfile_local_admin scripts/pr359-shadow/bootstrap-realtime-role.sql
  runfile_local_admin scripts/pr359-shadow/bootstrap-realtime-role.sql
  runfile_local_admin scripts/pr359-shadow/bootstrap-vault-schema.sql
  runfile_local_admin scripts/pr359-shadow/bootstrap-vault-schema.sql
  runfile_local_admin scripts/pr359-shadow/bootstrap-graphql-parity.sql
  runfile_local_admin scripts/pr359-shadow/bootstrap-graphql-parity.sql
  # Prove the exact hosted Auth owner can be retained when adding missing
  # source-attested audit metadata through Docker-only local superuser.
  [[ "$(value "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='auth.audit_log_entries'::regclass;")" == supabase_auth_admin ]] || {
    echo 'PR359_SUPABASE_IMAGE_AUTH_OWNER_MISMATCH' >&2; exit 1;
  }
  runfile_local_admin scripts/pr359-shadow/bootstrap-auth-audit-column.sql
  runfile_local_admin scripts/pr359-shadow/bootstrap-auth-audit-column.sql
  [[ "$(value "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='auth.audit_log_entries'::regclass;")" == supabase_auth_admin ]] || {
    echo 'PR359_SUPABASE_IMAGE_AUTH_OWNER_CHANGED' >&2; exit 1;
  }
  # Regression: DDL must not invoke a stale graphql.seq_schema_version OID.
  printf 'CREATE TABLE public.pr359_graphql_ddl_probe(id bigint); DROP TABLE public.pr359_graphql_ddl_probe;\n' | sql_local_admin >/dev/null
  [[ "$(value "SELECT to_regclass('graphql.seq_schema_version') IS NULL;")" == t ]] || exit 1
  [[ "$(value "SELECT NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolbypassrls FROM pg_roles WHERE rolname='supabase_realtime_admin';")" == t ]] || {
    echo 'PR359_LOCAL_RESERVED_ROLE_CHECK_FAILED' >&2; exit 1;
  }
  echo 'PR359_DOCKER_SUPABASE_RESERVED_ROLE_SMOKE_PASS'
  echo 'PR359_DOCKER_ISOLATED_SMOKE_PASS'
  exit 0
fi
if [[ "$mode" == staging-restore ]]; then
  [[ "${SHADOW_SOURCE_KIND:-}" == staging ]] || { echo 'STAGING_SOURCE_KIND_REQUIRED' >&2;exit 2; }
  [[ "${SHADOW_CONFIRM_STAGING_TEST_DATA:-}" == YES_STAGING_TEST_DATA ]] || { echo 'STAGING_TEST_DATA_ATTESTATION_REQUIRED' >&2;exit 2; }
  [[ -z "${SHADOW_CONFIRM_PRODUCTION_TEST_DATA:-}" ]] || { echo 'STAGING_PRODUCTION_ATTESTATION_FORBIDDEN' >&2;exit 2; }
else
  [[ "${SHADOW_SOURCE_KIND:-production}" == production ]] || { echo 'PRODUCTION_SOURCE_KIND_REQUIRED' >&2;exit 2; }
  [[ "${SHADOW_CONFIRM_PRODUCTION_TEST_DATA:-}" == YES_PRODUCTION_TEST_DATA ]] || exit 2
fi
[[ -n "${SHADOW_SOURCE_DB_URL:-}" ]] || { echo 'Missing source secret' >&2;exit 2; }
[[ "$(git rev-parse HEAD)" == "${SHADOW_APPROVED_HEAD:-}" ]] || { echo 'Source HEAD SHA mismatch' >&2;exit 2; }
command -v supabase >/dev/null && command -v psql >/dev/null || { echo 'Missing Supabase CLI or psql' >&2;exit 2; }
node scripts/pr359-shadow/guard.mjs
# Append TLS requirement for dashboard URIs without a query. The guard rejects extra/insecure parameters.
if [[ "$SHADOW_SOURCE_DB_URL" != *\?* ]]; then
  export SHADOW_SOURCE_DB_URL="${SHADOW_SOURCE_DB_URL}?sslmode=require"
fi
node scripts/pr359-shadow/guard.mjs
[[ "$(supabase --version | cut -d. -f1)" == 3 ]] || { echo 'Supabase CLI v3 required' >&2;exit 2; }
mkdir -p "$work/dump" "$work/transactions"
export PGOPTIONS='-c default_transaction_read_only=on' PGSSLMODE=require
source_sql="SELECT jsonb_build_object('payments',(SELECT count(*) FROM public.payments),'invoices',(SELECT count(*) FROM public.invoices),'cash',(SELECT count(*) FROM public.account_transactions),'auth_users',(SELECT count(*) FROM auth.users),'migration_rows',(SELECT count(*) FROM supabase_migrations.schema_migrations))::text;"
if ! psql -X -w -qAt -v ON_ERROR_STOP=1 --dbname "$SHADOW_SOURCE_DB_URL" --command "$source_sql" > "$work/source-counts" 2>"$work/source-check-stderr"; then
  # Never publish raw libpq stderr: it may contain user/host or source credentials.
  if grep -Eqi 'Network is unreachable|No route to host' "$work/source-check-stderr"; then
    echo 'PR359_SOURCE_NETWORK_UNREACHABLE: use the IPv4 Session Pooler at port 5432 on GitHub-hosted runners.' >&2
  elif grep -Eqi 'could not translate host name|Name or service not known|Temporary failure in name resolution' "$work/source-check-stderr"; then
    echo 'PR359_SOURCE_DNS_ERROR: verify the hostname copied from Supabase Connect > Session Pooler.' >&2
  elif grep -Eqi 'password authentication failed|28P01' "$work/source-check-stderr"; then
    echo 'PR359_SOURCE_AUTH_FAILED: verify the protected database password and pooler username.' >&2
  elif grep -Eqi 'connection refused|timeout expired|Connection timed out' "$work/source-check-stderr"; then
    echo 'PR359_SOURCE_UNREACHABLE: verify the Session Pooler endpoint and port 5432.' >&2
  elif grep -Eqi 'permission denied|insufficient privilege|42501' "$work/source-check-stderr"; then
    echo 'PR359_SOURCE_PERMISSION_DENIED: source account cannot read required baseline tables.' >&2
  elif grep -Eqi 'SSL|certificate|TLS' "$work/source-check-stderr"; then
    echo 'PR359_SOURCE_TLS_FAILED: verify the SSL connection policy.' >&2
  else
    echo 'PR359_SOURCE_PREFLIGHT_FAILED: read-only SQL failed for an unclassified reason; raw error retained only in the ephemeral runner.' >&2
  fi
  exit 1
fi
dump(){
  local output="$1";shift
  if ! supabase db dump --db-url "$SHADOW_SOURCE_DB_URL" -f "$work/dump/$output" "$@" >"$work/dump.log" 2>&1; then
    echo "Supabase logical export failed: $output" >&2; exit 1
  fi
  [[ -s "$work/dump/$output" ]] || { echo "Empty dump: $output" >&2;exit 1; }
}
# Capture source-managed table metadata only, never business rows or secrets.
if ! psql -X -w -qAt -v ON_ERROR_STOP=1 --dbname "$SHADOW_SOURCE_DB_URL" \
    --file scripts/pr359-shadow/managed-catalog.sql > "$work/source-managed-catalog.json" 2>/dev/null; then
  echo 'PR359_SOURCE_MANAGED_CATALOG_READ_FAILED' >&2; exit 1
fi
[[ -s "$work/source-managed-catalog.json" ]] || { echo 'PR359_SOURCE_MANAGED_CATALOG_EMPTY' >&2;exit 1; }
# Record provider-managed Auth/Storage/Realtime migration provenance without data rows.
if ! psql -X -w -qAt -v ON_ERROR_STOP=1 --dbname "$SHADOW_SOURCE_DB_URL" \
    --file scripts/pr359-shadow/managed-migrations.sql > "$work/source-managed-migrations.json" 2>/dev/null; then
  echo 'PR359_SOURCE_MANAGED_MIGRATIONS_READ_FAILED' >&2; exit 1
fi
[[ -s "$work/source-managed-migrations.json" ]] || { echo 'PR359_SOURCE_MANAGED_MIGRATIONS_EMPTY' >&2; exit 1; }
if ! psql -X -w -qAt -v ON_ERROR_STOP=1 --dbname "$SHADOW_SOURCE_DB_URL" \
    --file scripts/pr359-shadow/managed-relations.sql > "$work/source-managed-relations.json" 2>/dev/null; then
  echo 'PR359_SOURCE_MANAGED_RELATIONS_READ_FAILED' >&2; exit 1
fi
[[ -s "$work/source-managed-relations.json" ]] || { echo 'PR359_SOURCE_MANAGED_RELATIONS_EMPTY' >&2; exit 1; }
# Exact-source parity attestation: never drop an extension that exists upstream.
source_graphql_check="SELECT NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_graphql') AND to_regclass('graphql.seq_schema_version') IS NULL;"
if ! graphql_check="$(psql -X -w -qAt -v ON_ERROR_STOP=1 --dbname "$SHADOW_SOURCE_DB_URL" --command "$source_graphql_check" 2>/dev/null)" || [[ "$graphql_check" != t ]]; then
  echo 'PR359_SOURCE_GRAPHQL_PARITY_UNPROVEN: source does not match verified absent extension/sequence contract' >&2
  exit 1
fi
# Read-only fingerprint of the exact historical application migration ledger,
# including all six columns and statement arrays. Never print statement content.
SHADOW_STAGE=source-historical-ledger-attestation
if ! psql -X -w -qAt -v ON_ERROR_STOP=1 --dbname "$SHADOW_SOURCE_DB_URL" \
    --file scripts/pr359-shadow/history-attestation.sql \
    > "$work/source-history-attestation.json" 2>/dev/null; then
  echo 'PR359_SOURCE_HISTORY_ATTESTATION_FAILED' >&2; exit 1
fi
[[ -s "$work/source-history-attestation.json" ]] || {
  echo 'PR359_SOURCE_HISTORY_ATTESTATION_EMPTY' >&2; exit 1;
}
if [[ "$mode" == staging-restore ]]; then
  node scripts/pr359-r4/check-staging-legacy-ledger.mjs "$work/source-history-attestation.json"
fi
if [[ "$mode" == staging-restore ]]; then
  SHADOW_STAGE=staging-source-all-table-counts
  if ! psql -X -w -qAt -v ON_ERROR_STOP=1 --dbname "$SHADOW_SOURCE_DB_URL" \
      --file scripts/pr359-r4/staging-table-counts.sql > "$work/staging-tables-source.jsonl" 2>/dev/null; then
    echo 'PR359_STAGING_APP_TABLE_SOURCE_COUNT_FAILED' >&2;exit 1
  fi
  node scripts/pr359-r4/check-staging-table-counts.mjs --compare \
    "$work/staging-tables-source.jsonl" "$work/staging-tables-source.jsonl"
  SHADOW_STAGE=staging-source-content-before-export
  if ! psql -X -w -qAt -v ON_ERROR_STOP=1 --dbname "$SHADOW_SOURCE_DB_URL" \
    --file scripts/pr359-r4/staging-table-content.sql > "$work/staging-content-source.jsonl" 2>/dev/null; then
    echo 'PR359_STAGING_SOURCE_CONTENT_SHA256_FAILED' >&2;exit 1
  fi
  node scripts/pr359-r4/check-staging-table-content.mjs --compare \
    "$work/staging-content-source.jsonl" "$work/staging-content-source.jsonl"
fi

# Do NOT copy business data until the local networkless engine proves it can
# represent the source-managed service catalog and migration history. Running this
# pre-export gate avoids repeated expensive/pointless source dumps on known drift.
SHADOW_STAGE=pre-export-managed-start
# The source URL remains explicit and TLS-protected; do not leak its libpq TLS
# requirement into the disposable Local Stack, which intentionally serves plain
# loopback PostgreSQL.
unset PGOPTIONS PGSSLMODE
# Full restore uses the pinned Supabase Local Stack, not a standalone PostgreSQL image.
start
assert_local_admin
runfile_local_admin scripts/pr359-shadow/bootstrap-realtime-role.sql
runfile_local_admin scripts/pr359-shadow/bootstrap-vault-schema.sql
runfile_local_admin scripts/pr359-shadow/bootstrap-graphql-parity.sql
[[ "$(value "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='auth.audit_log_entries'::regclass;")" == supabase_auth_admin ]] || {
  echo 'PR359_PRE_EXPORT_AUTH_OWNER_MISMATCH' >&2; exit 1
}
SHADOW_STAGE=pre-export-managed-auth-compat
runfile_local_admin scripts/pr359-shadow/bootstrap-auth-audit-column.sql
SHADOW_STAGE=pre-export-managed-catalog
sql postgres < scripts/pr359-shadow/managed-catalog.sql > "$work/docker-managed-catalog.json"
SHADOW_STAGE=pre-export-managed-migrations
if ! sql postgres < scripts/pr359-shadow/managed-migrations.sql > "$work/docker-managed-migrations.json" 2>/dev/null; then
  echo 'PR359_PRE_EXPORT_MANAGED_MIGRATIONS_READ_FAILED' >&2; exit 1
fi
sql postgres < scripts/pr359-shadow/managed-relations.sql > "$work/docker-managed-relations.json"
node scripts/pr359-shadow/check-managed-stack-compatibility.mjs \
  "$work/source-managed-catalog.json" "$work/docker-managed-catalog.json" \
  "$work/source-managed-migrations.json" "$work/docker-managed-migrations.json" \
  "$work/source-managed-relations.json" "$work/docker-managed-relations.json"
echo 'PR359_PRE_EXPORT_MANAGED_PARITY_PASS: data export may now begin'

dump roles.sql --role-only
if [[ "$mode" == staging-restore ]]; then
  SHADOW_STAGE=staging-atomic-cross-dump-export
  SOURCE_COUNTS_SQL="$source_sql" bash scripts/pr359-r4/staging-atomic-export.sh "$work/dump" "$work"
  sha256sum -c --status "$work/staging-export-manifest.sha256" || {
    echo 'PR359_STAGING_DUMP_MANIFEST_DRIFT' >&2;exit 1;
  }
else
  dump schema.sql
  dump data.sql --data-only --use-copy
  dump history-schema.sql --schema supabase_migrations
  dump history-data.sql --schema supabase_migrations --data-only --use-copy
fi
if [[ "$mode" == staging-restore ]]; then
  # pg_dumpall --roles-only cannot join a PostgreSQL MVCC snapshot.
  # Fail closed if global role definitions drift during the SQL export.
  # This parity check is NOT proof of a role-atomic backup.
  SHADOW_STAGE=staging-roles-after-export
  dump roles-after.sql --role-only
  if ! cmp -s "$work/dump/roles.sql" "$work/dump/roles-after.sql"; then
    echo 'PR359_STAGING_ROLE_METADATA_DRIFT_DURING_EXPORT' >&2
    exit 1
  fi
  echo 'PR359_STAGING_ROLE_REEXPORT_PARITY_PASS'
fi
if [[ "$mode" == staging-restore ]]; then
  # Source verification before unsetting credentials. These are independent
  # read-only TLS transactions, not an atomic snapshot of Staging.
  SHADOW_STAGE=staging-source-post-export-verify
  if ! PGOPTIONS='-c default_transaction_read_only=on' PGSSLMODE=require \
    psql -X -w -qAt -v ON_ERROR_STOP=1 --dbname "$SHADOW_SOURCE_DB_URL" \
    --file scripts/pr359-shadow/history-attestation.sql > "$work/source-history-after-export.json" 2>/dev/null; then
    echo 'PR359_STAGING_POST_EXPORT_HISTORY_READ_FAILED' >&2;exit 1
  fi
  cmp -s "$work/source-history-attestation.json" "$work/source-history-after-export.json" || {
    echo 'PR359_STAGING_HISTORY_CHANGED_DURING_EXPORT' >&2;exit 1;
  }
  if ! PGOPTIONS='-c default_transaction_read_only=on' PGSSLMODE=require \
    psql -X -w -qAt -v ON_ERROR_STOP=1 --dbname "$SHADOW_SOURCE_DB_URL" \
    --command "$source_sql" > "$work/source-counts-after-export" 2>/dev/null; then
    echo 'PR359_STAGING_POST_EXPORT_COUNTS_READ_FAILED' >&2;exit 1
  fi
  cmp -s "$work/source-counts" "$work/source-counts-after-export" || {
    echo 'PR359_STAGING_COUNTS_CHANGED_DURING_EXPORT' >&2;exit 1;
  }
  SHADOW_STAGE=staging-source-post-export-table-counts
  if ! PGOPTIONS='-c default_transaction_read_only=on' PGSSLMODE=require \
    psql -X -w -qAt -v ON_ERROR_STOP=1 --dbname "$SHADOW_SOURCE_DB_URL" \
    --file scripts/pr359-r4/staging-table-counts.sql > "$work/staging-tables-after-export.jsonl" 2>/dev/null; then
    echo 'PR359_STAGING_APP_TABLE_POST_EXPORT_COUNT_FAILED' >&2;exit 1
  fi
  node scripts/pr359-r4/check-staging-table-counts.mjs --compare \
    "$work/staging-tables-source.jsonl" "$work/staging-tables-after-export.jsonl"
  SHADOW_STAGE=staging-source-content-after-export
  if ! PGOPTIONS='-c default_transaction_read_only=on' PGSSLMODE=require \
    psql -X -w -qAt -v ON_ERROR_STOP=1 --dbname "$SHADOW_SOURCE_DB_URL" \
    --file scripts/pr359-r4/staging-table-content.sql > "$work/staging-content-after-export.jsonl" 2>/dev/null; then
    echo 'PR359_STAGING_POST_EXPORT_CONTENT_SHA256_FAILED' >&2;exit 1
  fi
  node scripts/pr359-r4/check-staging-table-content.mjs --compare \
    "$work/staging-content-source.jsonl" "$work/staging-content-after-export.jsonl"
fi
unset PGOPTIONS PGSSLMODE SHADOW_SOURCE_DB_URL
if [[ "$mode" == full ]]; then
  node scripts/pr359-shadow/render.mjs "$work/transactions"
fi
restore(){
  if [[ "$mode" == staging-restore ]]; then
    sha256sum -c --status "$work/staging-export-manifest.sha256" || {
      echo 'PR359_STAGING_DUMP_MANIFEST_CHANGED_BEFORE_RESTORE' >&2;exit 1;
    }
  fi
  SHADOW_STAGE=container-start
  start
  [[ "$(value 'SHOW server_version_num;')" == 17* ]] || exit 1
  # Supabase CLI --role-only intentionally omits reserved platform roles.
  # The hosted reserved role below is source-attested and created ONLY in networkless Docker.
  assert_local_admin
  runfile_local_admin scripts/pr359-shadow/bootstrap-realtime-role.sql
  # Supabase role dumps refer to reserved schema ACLs excluded by managed schema filters.
  # Create the original source-attested Vault schema/extension in local Docker first.
  runfile_local_admin scripts/pr359-shadow/bootstrap-vault-schema.sql
  # Drop only the image's extra pg_graphql extension, with RESTRICT (never CASCADE).
  runfile_local_admin scripts/pr359-shadow/bootstrap-graphql-parity.sql
  echo 'PR359_SHADOW_STAGE: prepared reserved role, Vault and GraphQL source parity'
  SHADOW_STAGE=restore-roles
  runfile_local_admin "$work/dump/roles.sql"
  echo 'PR359_SHADOW_STAGE: role/ACL dump imported'
  # Fail closed before importing ANY application schema if provider-managed
  # Auth/Storage/Realtime tables differ from the hosted source. This avoids
  # importing an app schema into a disposable but fundamentally incompatible DB.
  # Match confirmed source Auth audit metadata without changing reserved schemas remotely.
  # Production's auth.audit_log_entries is owned by supabase_auth_admin. The
  # Docker-only supabase_admin is a verified local superuser; using postgres
  # here fails "must be owner" and must never be fixed by changing ownership.
  local audit_owner_before audit_owner_after
  audit_owner_before="$(value "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='auth.audit_log_entries'::regclass;")"
  [[ "$audit_owner_before" == supabase_auth_admin ]] || {
    echo 'PR359_SHADOW_AUTH_AUDIT_UNEXPECTED_OWNER: refusing to change the managed Auth schema' >&2
    exit 1
  }
  assert_local_admin
  SHADOW_STAGE=restore-auth-audit-compat
  runfile_local_admin scripts/pr359-shadow/bootstrap-auth-audit-column.sql
  audit_owner_after="$(value "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='auth.audit_log_entries'::regclass;")"
  [[ "$audit_owner_after" == "$audit_owner_before" ]] || {
    echo 'PR359_SHADOW_AUTH_AUDIT_OWNER_DRIFT: refusing modified Auth table owner' >&2
    exit 1
  }
  SHADOW_STAGE=verify-managed-catalog-pre-application
  sql postgres < scripts/pr359-shadow/managed-catalog.sql > "$work/docker-managed-catalog.json"
  sql postgres < scripts/pr359-shadow/managed-relations.sql > "$work/docker-managed-relations.json"
  # Provider compatibility is checked fail-closed. The only accepted local extras
  # are the verified daily Realtime partitions and the two Storage Iceberg catalog tables.
  SHADOW_STAGE=verify-managed-migrations-pre-application
  if ! sql postgres < scripts/pr359-shadow/managed-migrations.sql > "$work/docker-managed-migrations.json" 2>/dev/null; then
    echo 'PR359_DOCKER_MANAGED_MIGRATIONS_READ_FAILED' >&2; exit 1
  fi
  node scripts/pr359-shadow/check-managed-stack-compatibility.mjs \
    "$work/source-managed-catalog.json" "$work/docker-managed-catalog.json" \
    "$work/source-managed-migrations.json" "$work/docker-managed-migrations.json" \
    "$work/source-managed-relations.json" "$work/docker-managed-relations.json"
  SHADOW_STAGE=restore-application-schema
  echo 'PR359_SHADOW_STAGE: starting application schema restore'
  runfile postgres "$work/dump/schema.sql"
  echo 'PR359_SHADOW_STAGE: application schema imported'
  if [[ "$mode" == staging-restore ]]; then
    SHADOW_STAGE=staging-schema-before-data
    sql postgres < scripts/pr359-r4/staging-schema-fingerprint.sql > "$work/staging-schema-pre-data.jsonl"
    node scripts/pr359-r4/check-staging-schema-fingerprint.mjs --compare \
      "$work/staging-schema-source.jsonl" "$work/staging-schema-pre-data.jsonl"
    echo 'PR359_STAGING_SCHEMA_PRE_DATA_FINGERPRINT_PASS'
  fi
  # A compatible baseline can still be changed by the application schema dump;
  # verify the managed surface AGAIN after importing schema, before data COPY.
  SHADOW_STAGE=verify-managed-catalog-post-application
  sql postgres < scripts/pr359-shadow/managed-catalog.sql > "$work/docker-managed-catalog.json"
  sql postgres < scripts/pr359-shadow/managed-relations.sql > "$work/docker-managed-relations.json"
  SHADOW_STAGE=verify-managed-migrations-post-application
  if ! sql postgres < scripts/pr359-shadow/managed-migrations.sql > "$work/docker-managed-migrations.json" 2>/dev/null; then
    echo 'PR359_DOCKER_MANAGED_MIGRATIONS_READ_FAILED' >&2; exit 1
  fi
  node scripts/pr359-shadow/check-managed-stack-compatibility.mjs \
    "$work/source-managed-catalog.json" "$work/docker-managed-catalog.json" \
    "$work/source-managed-migrations.json" "$work/docker-managed-migrations.json" \
    "$work/source-managed-relations.json" "$work/docker-managed-relations.json"
  { printf 'BEGIN;\nSET LOCAL session_replication_role=replica;\n'; cat "$work/dump/data.sql"; printf '\nCOMMIT;\n'; } > "$work/restore-data.sql"
  SHADOW_STAGE=restore-data
  # COPY includes provider-owned Storage rows such as buckets_vectors. Import
  # into the disposable target through its local superuser socket so source
  # ACLs cannot block a faithful data restore; no hosted role is elevated.
  runfile_local_admin "$work/restore-data.sql"
  if [[ "$(value "SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL;")" == f ]]; then
    runfile postgres "$work/dump/history-schema.sql"
  fi
  SHADOW_STAGE=restore-history
  runfile postgres "$work/dump/history-data.sql"
  # Full-row cryptographic history attestation after each independent restore,
# BEFORE any financial migration changes the migration ledger.
SHADOW_STAGE=verify-restored-legacy-ledger-sha256
sql postgres < scripts/pr359-shadow/history-attestation.sql > "$work/target-history-attestation.json"
cmp -s "$work/source-history-attestation.json" "$work/target-history-attestation.json" || {
  echo 'PR359_RESTORED_LEGACY_LEDGER_SHA256_MISMATCH' >&2; exit 1;
}
echo 'PR359_RESTORED_LEGACY_LEDGER_SHA256_PASS'

[[ "$(value "$source_sql")" == "$(cat "$work/source-counts")" ]] || { echo 'Source and restore row counts differ' >&2;exit 1; }
  if [[ "$mode" == staging-restore ]]; then
    SHADOW_STAGE=staging-restored-table-counts
    sql postgres < scripts/pr359-r4/staging-table-counts.sql > "$work/staging-tables-restored.jsonl"
    node scripts/pr359-r4/check-staging-table-counts.mjs --compare \
      "$work/staging-tables-source.jsonl" "$work/staging-tables-restored.jsonl"
    SHADOW_STAGE=staging-restored-table-content
    sql postgres < scripts/pr359-r4/staging-table-content.sql > "$work/staging-content-restored.jsonl"
    node scripts/pr359-r4/check-staging-table-content.mjs --compare \
      "$work/staging-content-source.jsonl" "$work/staging-content-restored.jsonl"
    SHADOW_STAGE=staging-restored-managed-data
    sql postgres < scripts/pr359-r4/staging-managed-data-content.sql > "$work/staging-managed-restored.jsonl"
    node scripts/pr359-r4/check-staging-managed-data.mjs --compare \
      "$work/staging-managed-source.jsonl" "$work/staging-managed-restored.jsonl"
    SHADOW_STAGE=staging-restored-schema-fingerprint
    sql postgres < scripts/pr359-r4/staging-schema-fingerprint.sql > "$work/staging-schema-restored.jsonl"
    node scripts/pr359-r4/check-staging-schema-fingerprint.mjs --compare \
      "$work/staging-schema-source.jsonl" "$work/staging-schema-restored.jsonl"
    echo 'PR359_STAGING_SCHEMA_FINGERPRINT_PASS'
    echo 'PR359_STAGING_FULL_APP_TABLE_COUNTS_AND_CONTENT_PASS'
    echo 'PR359_STAGING_MANAGED_AUTH_STORAGE_ROW_PARITY_PASS'
  fi
  [[ "$(value "SELECT to_regclass('auth.users') IS NOT NULL AND to_regclass('storage.objects') IS NOT NULL AND to_regclass('supabase_migrations.schema_migrations') IS NOT NULL;")" == t ]] || { echo 'Managed schema missing' >&2;exit 1; }
}
apply(){ for i in $(seq "$1" 4); do SHADOW_STAGE="finance-migration-$i";runfile postgres "$work/transactions/$i-apply.sql";done; }
fingerprint(){ sql postgres < scripts/pr359-shadow/fingerprint.sql | tail -1; }
restore
if [[ "$mode" == staging-restore ]]; then
  cp "$work/target-history-attestation.json" "$work/staging-first-restored-history.json"
  SHADOW_STAGE=staging-independent-second-restore
  restore
  cmp -s "$work/staging-first-restored-history.json" "$work/target-history-attestation.json" || {
    echo 'PR359_STAGING_INDEPENDENT_RESTORE_HISTORY_DRIFT' >&2;exit 1;
  }
  echo 'PR359_STAGING_REAL_LEDGER_RESTORED_TWICE_PASS'
  echo 'PR359_STAGING_EPOCH_V2_CUTOVER_PASS=NOT_GRANTED'
  echo 'PR359_STAGING_INPLACE_GO=FALSE'
  exit 0
fi
apply 1
fingerprint > "$work/first"
restore
apply 1
fingerprint > "$work/second"
cmp -s "$work/first" "$work/second" || { echo 'Independent upgrade fingerprints differ' >&2; exit 1; }
restore
runfile postgres "$work/transactions/1-apply.sql"
if sql postgres < "$work/transactions/2-fault.sql" > "$work/failure.log" 2>&1; then echo 'Expected failure missing' >&2;exit 1;fi
grep -q PR359_DOCKER_SHADOW_EXPECTED_FAILURE "$work/failure.log" || { echo 'Unexpected failure before fault boundary' >&2;exit 1; }
[[ "$(value "SELECT NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20261103131104');")" == t ]] || { echo 'Ledger rollback failed' >&2;exit 1; }
[[ "$(value "SELECT NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='payments' AND column_name='invoice_applied_amount');")" == t ]] || { echo 'Schema rollback failed' >&2;exit 1; }
apply 2
fingerprint > "$work/third"
cmp -s "$work/first" "$work/third" || { echo 'Recovered upgrade differs' >&2;exit 1; }
echo "PR359_DOCKER_FINANCE_REHEARSAL_PASS_SHA=$(git rev-parse HEAD)"
echo "FINANCIAL_FINGERPRINT_SHA256=$(sha256sum "$work/first" | cut -d' ' -f1)"
echo 'MIGRATION_RECONCILIATION_PASS=NOT_GRANTED'
echo 'PRODUCTION_SHADOW_UPGRADE_PASS=NOT_GRANTED_COMPLETE_CROSSWALK_PENDING'
