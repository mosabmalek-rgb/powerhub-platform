#!/usr/bin/env bash
set -euo pipefail

if [ -z "${PGDATABASE:-}" ]; then
  echo "PGDATABASE must name the disposable site-billing test database." >&2
  exit 1
fi
if [ -z "${PGHOST:-}" ]; then export PGHOST=127.0.0.1; fi
if [ -z "${PGPORT:-}" ]; then export PGPORT=5432; fi
if [ -z "${PGUSER:-}" ]; then export PGUSER=postgres; fi

psql_test() {
  psql --no-psqlrc --no-password --set=ON_ERROR_STOP=1 --tuples-only --no-align --dbname "$PGDATABASE" "$@"
}

# The delay widens the race window after the RPC acquires its idempotency lock.
psql_test --command "
CREATE OR REPLACE FUNCTION public.test_pause_payment_insert()
RETURNS trigger LANGUAGE plpgsql AS \$function\$
BEGIN
  IF NEW.payment_no='TEST-PAYMENT-CONCURRENT-001' THEN PERFORM pg_sleep(1); END IF;
  RETURN NEW;
END
\$function\$;
DROP TRIGGER IF EXISTS test_pause_payment_insert_trigger ON public.payments;
CREATE TRIGGER test_pause_payment_insert_trigger
BEFORE INSERT ON public.payments FOR EACH ROW EXECUTE FUNCTION public.test_pause_payment_insert();
" >/dev/null

invoice_id="$(psql_test --command "SELECT id FROM public.invoices WHERE reading_id=1005 AND tenant_id=1 AND site_id=10 LIMIT 1;")"
if [ -z "$invoice_id" ]; then
  echo "Concurrent payment fixture invoice was not found." >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"; psql_test --command "DROP TRIGGER IF EXISTS test_pause_payment_insert_trigger ON public.payments; DROP FUNCTION IF EXISTS public.test_pause_payment_insert();" >/dev/null' EXIT

sql="SELECT payment_id::text || '|' || replayed::text FROM public.powerhub_create_payment(1,10,7,104,$invoice_id,'TEST-PAYMENT-CONCURRENT-001',1,'cash',301,NULL,NULL,'CONCURRENT-IDEMP-REF',NULL,NULL,NULL,'55555555-5555-4555-8555-555555555555');"

psql_test --command "$sql" > "$tmp_dir/first.out" &
first_pid=$!
sleep 0.1
psql_test --command "$sql" > "$tmp_dir/second.out" &
second_pid=$!

wait "$first_pid"
wait "$second_pid"

combined="$(cat "$tmp_dir/first.out" "$tmp_dir/second.out" | sed '/^[[:space:]]*$/d' | sort)"
if [ "$(printf '%s\n' "$combined" | wc -l | tr -d ' ')" != "2" ] ||
   [ "$(printf '%s\n' "$combined" | grep -Ec '^[0-9]+\|false$')" != "1" ] ||
   [ "$(printf '%s\n' "$combined" | grep -Ec '^[0-9]+\|true$')" != "1" ] ||
   [ "$(printf '%s\n' "$combined" | cut -d'|' -f1 | sort -u | wc -l | tr -d ' ')" != "1" ]; then
  echo "Concurrent payment calls did not return one creation and one exact replay:" >&2
  cat "$tmp_dir/first.out" "$tmp_dir/second.out" >&2
  exit 1
fi

assertions="$(psql_test --command "
SELECT
  (SELECT count(*) FROM public.payments WHERE client_operation_id='55555555-5555-4555-8555-555555555555') || '|' ||
  (SELECT count(*) FROM public.account_transactions t JOIN public.payments p ON p.id=t.related_payment_id WHERE p.client_operation_id='55555555-5555-4555-8555-555555555555') || '|' ||
  (SELECT count(*) FROM public.audit_logs a JOIN public.payments p ON p.id::text=a.entity_id WHERE p.client_operation_id='55555555-5555-4555-8555-555555555555' AND a.entity_type='payment' AND a.action='create') || '|' ||
  (SELECT paid_amount::text FROM public.invoices WHERE id=$invoice_id);
")"
if [ "$assertions" != "1|1|1|1.00" ]; then
  echo "Concurrent payment side-effect invariant failed: $assertions" >&2
  exit 1
fi

echo "PAYMENT_IDEMPOTENCY_CONCURRENCY_ASSERTIONS_PASSED"
