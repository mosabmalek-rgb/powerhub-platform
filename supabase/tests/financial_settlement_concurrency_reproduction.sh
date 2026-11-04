#!/usr/bin/env bash
set -Eeuo pipefail

DB_NAME="${PGDATABASE:-financial_settlement_concurrency_reproduction_test}"
PSQL=(psql --no-psqlrc --host 127.0.0.1 --port 5432 --username postgres --dbname "$DB_NAME" --set ON_ERROR_STOP=1 --tuples-only --no-align --quiet)
PAUSE_SECONDS=3
WRITER_APP="powerhub-settlement-race-writer"
WRITER_LOG="$(mktemp)"
cleanup() {
  "${PSQL[@]}" --command "
    DROP TRIGGER IF EXISTS aaa_test_pause_financial_source_write ON public.account_transactions;
    DROP FUNCTION IF EXISTS public.financial_settlement_test_pause_source_write();
  " >/dev/null 2>&1 || true
  rm -f "$WRITER_LOG"
}
trap cleanup EXIT

SETTLEMENT_ID="$("${PSQL[@]}" --command "
  SELECT settlement_id FROM public.financial_settlement_concurrency_test_state WHERE site_id=10
")"

"${PSQL[@]}" --command "
CREATE OR REPLACE FUNCTION public.financial_settlement_test_pause_source_write()
RETURNS trigger LANGUAGE plpgsql AS \$function\$
BEGIN
  IF NEW.site_id=10 AND NEW.description='FINANCIAL_SETTLEMENT_CONCURRENCY_REPRODUCTION' THEN
    PERFORM pg_sleep(3);
  END IF;
  RETURN NEW;
END;
\$function\$;
CREATE TRIGGER aaa_test_pause_financial_source_write AFTER INSERT ON public.account_transactions
FOR EACH ROW EXECUTE FUNCTION public.financial_settlement_test_pause_source_write();
" >/dev/null

PGAPPNAME="$WRITER_APP" "${PSQL[@]}" --command "
  SELECT * FROM public.powerhub_add_account_movement(
    1,10,1,100,'deposit',1,
    'FINANCIAL_SETTLEMENT_CONCURRENCY_REPRODUCTION',NULL
  );
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

"${PSQL[@]}" --command "
  SELECT * FROM public.powerhub_set_financial_settlement_status(
    1,10,3,${SETTLEMENT_ID},'locked'
  );
" >/dev/null

if ! wait "$WRITER_PID"; then cat "$WRITER_LOG"; echo "BASELINE_WRITER_UNEXPECTEDLY_FAILED" >&2; exit 1; fi

RACE_REPRODUCED="$("${PSQL[@]}" --command "
  SELECT CASE WHEN fs.status='locked'
    AND fs.ledger_snapshot->>'sourceFingerprint' IS DISTINCT FROM
      public.powerhub_financial_settlement_source_fingerprint(
        fs.tenant_id,fs.site_id,fs.period_start,fs.period_end)
    AND EXISTS (SELECT 1 FROM public.account_transactions tx
      WHERE tx.tenant_id=1 AND tx.site_id=10
        AND tx.description='FINANCIAL_SETTLEMENT_CONCURRENCY_REPRODUCTION')
    THEN 'YES' ELSE 'NO' END
  FROM public.financial_settlements fs WHERE fs.id=${SETTLEMENT_ID}
")"
if [[ "$RACE_REPRODUCED" != "YES" ]]; then
  echo "EXPECTED_BASELINE_STALE_LOCK_WAS_NOT_REPRODUCED" >&2
  exit 1
fi
echo "FINANCIAL_SETTLEMENT_CONCURRENCY_BASELINE_RACE_REPRODUCED"