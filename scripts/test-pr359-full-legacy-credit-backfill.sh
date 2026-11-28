#!/usr/bin/env bash
set -euo pipefail
test "$PGHOST" = "127.0.0.1" || { echo "Refusing non-loopback database"; exit 1; }
test "$PGPORT" = "5432" || { echo "Unexpected test port"; exit 1; }
migration="supabase/migrations/20261103145232_powerhub_legacy_unlinked_payments_to_subscriber_credit.sql"
for db in pr359_credit_backfill_acceptance pr359_credit_backfill_rollback; do
  createdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" "$db"
  psql -X -w -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$db" -v ON_ERROR_STOP=1 \
    -f supabase/tests/pr359_full_legacy_backfill_setup.sql
done
for pass in first replay; do
  psql -X -w -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d pr359_credit_backfill_acceptance \
    -v ON_ERROR_STOP=1 --single-transaction -f "$migration"
  psql -X -w -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d pr359_credit_backfill_acceptance \
    -v ON_ERROR_STOP=1 -f supabase/tests/pr359_full_legacy_backfill_assert.sql
done
log="$(mktemp)"
trap 'rm -f "$log"' EXIT
if psql -X -w -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d pr359_credit_backfill_rollback \
  -v ON_ERROR_STOP=1 --single-transaction -f "$migration" \
  -f supabase/tests/pr359_full_legacy_backfill_forced_failure.sql >"$log" 2>&1; then
  echo "Controlled error unexpectedly succeeded";exit 1
fi
if ! grep -Fq 'PR359_CONTROLLED_FAILURE_AFTER_FULL_MIGRATION' "$log"; then
  echo "Migration failed before intended fault injection";tail -n 50 "$log";exit 1
fi
psql -X -w -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d pr359_credit_backfill_rollback \
  -v ON_ERROR_STOP=1 -f supabase/tests/pr359_full_legacy_backfill_rollback_assert.sql
echo "PR359 complete historical source, replay, and controlled rollback PASS"
