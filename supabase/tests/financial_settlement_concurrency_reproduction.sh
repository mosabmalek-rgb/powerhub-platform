#!/usr/bin/env bash
set -Eeuo pipefail

DB_NAME="${PGDATABASE:-financial_settlement_concurrency_reproduction_test}"
PSQL=(psql --no-psqlrc --host 127.0.0.1 --port 5432 --username postgres --dbname "$DB_NAME" --set ON_ERROR_STOP=1 --tuples-only --no-align --quiet)
WRITER_APP="powerhub-settlement-race-writer"
WRITER_LOG="$(mktemp)"
LOCK_LOG="$(mktemp)"
POST_LOCK_LOG="$(mktemp)"
cleanup() {
  "${PSQL[@]}" --command "
    DROP TRIGGER IF EXISTS aaa_test_pause_financial_source_write ON public.account_transactions;
    DROP FUNCTION IF EXISTS public.financial_settlement_test_pause_source_write();
  " >/dev/null 2>&1 || true
  rm -f "$WRITER_LOG" "$LOCK_LOG" "$POST_LOCK_LOG"
}
trap cleanup EXIT

SETTLEMENT_ID="$("${PSQL[@]}" --command "
  SELECT settlement_id FROM public.financial_settlement_concurrency_test_state WHERE site_id=10
")"

"${PSQL[@]}" --command "
CREATE OR REPLACE FUNCTION public.financial_settlement_test_pause_source_write()
RETURNS trigger LANGUAGE plpgsql AS \$function\$
BEGIN
  IF NEW.site_id=10 AND NEW.description='FINANCIAL_SETTLEMENT_CONCURRENCY_SERIALIZATION' THEN
    PERFORM pg_sleep(3);
  END IF;
  RETURN NEW;
END;
\$function\$;
CREATE TRIGGER aaa_test_pause_financial_source_write AFTER INSERT ON public.account_transactions
FOR EACH ROW EXECUTE FUNCTION public.financial_settlement_test_pause_source_write();
" >/dev/null

# The writer obtains the shared tenant/site lock in its BEFORE trigger, then
# pauses after inserting but before commit. Settlement approval must wait.
PGAPPNAME="$WRITER_APP" "${PSQL[@]}" --command "
  INSERT INTO public.account_transactions(
    tenant_id,site_id,account_id,transaction_type,amount,description,created_by_user_id,occurred_at
  ) VALUES (1,10,100,'deposit',1,
    'FINANCIAL_SETTLEMENT_CONCURRENCY_SERIALIZATION',1,now());
" >"$WRITER_LOG" 2>&1 &
WRITER_PID=$!

SLEEP_SEEN=0
for _ in $(seq 1 60); do
  WAIT_EVENT="$("${PSQL[@]}" --command "
    SELECT coalesce(wait_event,'') FROM pg_stat_activity
    WHERE application_name='${WRITER_APP}' LIMIT 1
  ")"
  if [[ "$WAIT_EVENT" == "PgSleep" ]]; then SLEEP_SEEN=1; break; fi
  sleep 0.1
done
if [[ "$SLEEP_SEEN" != "1" ]]; then
  cat "$WRITER_LOG"
  kill "$WRITER_PID" >/dev/null 2>&1 || true
  wait "$WRITER_PID" >/dev/null 2>&1 || true
  echo "WRITER_DID_NOT_REACH_CONTROLLED_CONCURRENCY_WINDOW" >&2
  exit 1
fi

# This waits for the writer lock, then must reject the stale pre-write snapshot.
if "${PSQL[@]}" --command "
  SELECT * FROM public.powerhub_set_financial_settlement_status(
    1,10,3,${SETTLEMENT_ID},'locked'
  );
" >"$LOCK_LOG" 2>&1; then
  echo "STALE_SETTLEMENT_SNAPSHOT_WAS_LOCKED_DURING_CONCURRENT_SOURCE_WRITE" >&2
  exit 1
fi
if ! grep -q "SETTLEMENT_SOURCE_LEDGER_CHANGED" "$LOCK_LOG"; then
  cat "$LOCK_LOG"
  echo "EXPECTED_STALE_SNAPSHOT_REJECTION_NOT_FOUND" >&2
  exit 1
fi
if ! wait "$WRITER_PID"; then cat "$WRITER_LOG"; echo "SOURCE_WRITER_FAILED" >&2; exit 1; fi

RACE_SERIALIZED="$("${PSQL[@]}" --command "
  SELECT CASE WHEN fs.status='approved'
    AND fs.ledger_snapshot->>'sourceFingerprint' IS DISTINCT FROM
      public.powerhub_financial_settlement_source_fingerprint(
        fs.tenant_id,fs.site_id,fs.period_start,fs.period_end)
    AND EXISTS (SELECT 1 FROM public.account_transactions tx
      WHERE tx.tenant_id=1 AND tx.site_id=10
        AND tx.description='FINANCIAL_SETTLEMENT_CONCURRENCY_SERIALIZATION')
    THEN 'YES' ELSE 'NO' END
  FROM public.financial_settlements fs WHERE fs.id=${SETTLEMENT_ID}
")"
if [[ "$RACE_SERIALIZED" != "YES" ]]; then
  echo "CONCURRENT_WRITE_WAS_NOT_SERIALIZED_WITH_SETTLEMENT_APPROVAL" >&2
  exit 1
fi

# Rebuild a fresh snapshot after the writer committed, then lock it normally.
FRESH_SETTLEMENT_ID="$("${PSQL[@]}" --command "
  SELECT c.settlement_id FROM public.powerhub_create_financial_settlement(
    1,10,1,date_trunc('month',now()),
    date_trunc('month',now())+interval '1 month'-interval '1 microsecond',
    NULL,'Fresh post-write settlement snapshot'
  ) c
")"
"${PSQL[@]}" --command "SELECT * FROM public.powerhub_set_financial_settlement_status(1,10,1,${FRESH_SETTLEMENT_ID},'submitted');" >/dev/null
"${PSQL[@]}" --command "SELECT * FROM public.powerhub_set_financial_settlement_status(1,10,2,${FRESH_SETTLEMENT_ID},'approved');" >/dev/null
"${PSQL[@]}" --command "SELECT * FROM public.powerhub_set_financial_settlement_status(1,10,3,${FRESH_SETTLEMENT_ID},'locked');" >/dev/null

# Direct SQL writes must be blocked too, not only the known RPC.
if "${PSQL[@]}" --command "
  INSERT INTO public.account_transactions(
    tenant_id,site_id,account_id,transaction_type,amount,description,created_by_user_id,occurred_at
  ) VALUES (1,10,100,'deposit',2,'DIRECT_WRITE_AFTER_LOCK',1,now());
" >"$POST_LOCK_LOG" 2>&1; then
  echo "DIRECT_FINANCIAL_SOURCE_WRITE_BYPASSED_LOCKED_SETTLEMENT_GUARD" >&2
  exit 1
fi
if ! grep -q "FINANCIAL_PERIOD_LOCKED" "$POST_LOCK_LOG"; then
  cat "$POST_LOCK_LOG"
  echo "EXPECTED_LOCKED_PERIOD_REJECTION_NOT_FOUND" >&2
  exit 1
fi

# A different site in the same tenant must remain writable.
"${PSQL[@]}" --command "
  INSERT INTO public.account_transactions(
    tenant_id,site_id,account_id,transaction_type,amount,description,created_by_user_id,occurred_at
  ) VALUES (1,11,103,'deposit',3,'OTHER_SITE_MUST_REMAIN_WRITABLE',1,now());
" >/dev/null

echo "FINANCIAL_SETTLEMENT_SOURCE_WRITE_GUARD_SERIALIZATION_OK"
