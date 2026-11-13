#!/usr/bin/env bash
# C6 two independent backends on disposable PostgreSQL 17 ONLY.
set -euo pipefail
: "$PGDATABASE"
[[ "$PGDATABASE" == financial_c6_two_session_close_test &&
   "$PGHOST" == 127.0.0.1 && "$PGPORT" == 5432 ]] || {
 echo C6_REJECT_NON_DISPOSABLE_DATABASE; exit 1; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
sql() { psql -XAt -v ON_ERROR_STOP=1 -c "$1"; }
sql "DO \$b\$ BEGIN
 BEGIN
 PERFORM public.powerhub_financial_accrual_period_lock(901,9101,'2026-09',9901);
 RAISE EXCEPTION 'C6_MAKER_WAS_ALLOWED';
 EXCEPTION WHEN OTHERS THEN
 IF SQLERRM NOT LIKE '%ACCRUAL_SEPARATION_OF_DUTIES%' THEN RAISE; END IF;
 END; END \$b\$;"
(
 sql "SELECT pg_advisory_lock(hashtextextended('powerhub:accrual-period:901:9101:2026-09',0));
 SELECT pg_sleep(4); SELECT pg_advisory_unlock(hashtextextended('powerhub:accrual-period:901:9101:2026-09',0));" > "$tmp/coordinator"
) &
coordinator=$!
sleep 0.5
race() {
 local checker="$1" outfile="$2"
 psql -XAt -v ON_ERROR_STOP=1 -c "
 DO \$race\$ DECLARE output jsonb; marker text;
 BEGIN
  BEGIN
   output:=public.powerhub_financial_accrual_period_lock(901,9101,'2026-09',$checker);
   IF output->>'status' IS DISTINCT FROM 'locked'
     OR (output->>'alreadyLocked')::boolean IS DISTINCT FROM false
     OR (output->>'isCertifiedProfit')::boolean IS DISTINCT FROM false
   THEN RAISE EXCEPTION 'C6_BAD_WINNER'; END IF;
   marker:='WIN';
  EXCEPTION WHEN OTHERS THEN
   IF SQLERRM LIKE '%PERIOD_ALREADY_LOCKED%' THEN marker:='DENIED';
   ELSE RAISE; END IF;
  END;
  PERFORM set_config('powerhub.c6_result',marker,true);
 END \$race\$;
 SELECT pg_backend_pid() || '|' || current_setting('powerhub.c6_result');" > "$outfile"
}
race 9902 "$tmp/a" & a_pid=$!
race 9903 "$tmp/b" & b_pid=$!
wait "$a_pid";wait "$b_pid";wait "$coordinator"
a="$(cat "$tmp/a")"; b="$(cat "$tmp/b")"
IFS='|' read -r backend_a result_a <<< "$a"
IFS='|' read -r backend_b result_b <<< "$b"
[[ "$backend_a" =~ ^[0-9]+$ && "$backend_b" =~ ^[0-9]+$ &&
 "$backend_a" != "$backend_b" ]] || { echo C6_NOT_TWO_BACKENDS;exit 1; }
[[ "$result_a" == WIN && "$result_b" == DENIED ||
   "$result_b" == WIN && "$result_a" == DENIED ]] || {
 echo C6_RACE_NOT_EXACTLY_ONE_WIN;exit 1; }
winner=9902;loser=9903
if [[ "$result_b" == WIN ]]; then winner=9903;loser=9902;fi

# A separate completed month has a corrupt invoice source. It must be rejected
# by the REAL C4 DB writer, without creating a permanent lock.
sql "DO \$negative\$ DECLARE rejected boolean:=false;
BEGIN
 BEGIN
  PERFORM public.powerhub_financial_accrual_period_lock(901,9101,'2026-08',9902);
 EXCEPTION WHEN OTHERS THEN
  rejected:=SQLERRM LIKE '%ACCRUAL_CLOSE_UNRESOLVED_SOURCE_invalidInvoiceCount%';
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'C6_CORRUPT_INVOICE_SOURCE_ALLOWED'; END IF;
 IF (SELECT status FROM public.financial_accrual_period_reviews
   WHERE tenant_id=901 AND site_id=9101 AND period='2026-08')<>'draft'
 THEN RAISE EXCEPTION 'C6_SOURCE_NEGATIVE_CHANGED_REVIEW'; END IF;
END \$negative\$;"

sql "DO \$test\$ DECLARE replay jsonb; denied boolean:=false; n integer;
 BEGIN
 replay:=public.powerhub_financial_accrual_period_lock(901,9101,'2026-09',$winner);
 IF replay->>'status' IS DISTINCT FROM 'locked'
 OR (replay->>'alreadyLocked')::boolean IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'C6_WINNER_REPLAY_NOT_IDEMPOTENT'; END IF;
 BEGIN
 PERFORM public.powerhub_financial_accrual_period_lock(901,9101,'2026-09',$loser);
 EXCEPTION WHEN OTHERS THEN denied:=SQLERRM LIKE '%PERIOD_ALREADY_LOCKED%'; END;
 IF NOT denied THEN RAISE EXCEPTION 'C6_OTHER_CHECKER_REPLAY_ALLOWED'; END IF;
 SELECT count(*) INTO n FROM public.financial_accrual_period_reviews
 WHERE tenant_id=901 AND site_id=9101 AND period='2026-09'
 AND status='locked' AND locked_by_user_id=$winner;
 IF n<>1 THEN RAISE EXCEPTION 'C6_NOT_EXACTLY_ONE_LOCK'; END IF;
 END \$test\$;"
sql "UPDATE public.c6_sources SET revision=revision+1
 WHERE tenant_id=901 AND site_id=9101 AND period='2026-09';"
sql "DO \$test\$ DECLARE r jsonb;denied boolean:=false;
 BEGIN
 r:=public.powerhub_financial_accrual_period_review_status(901,9101,'2026-09');
 IF r->>'status' IS DISTINCT FROM 'locked'
 OR (r->>'driftDetected')::boolean IS DISTINCT FROM true
 OR (r->>'isCertifiedProfit')::boolean IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'C6_POST_LOCK_DRIFT_NOT_REPORTED'; END IF;
 BEGIN
 PERFORM public.powerhub_financial_accrual_period_lock(902,9101,'2026-09',9902);
 EXCEPTION WHEN OTHERS THEN denied:=SQLERRM LIKE '%INVALID_ACCRUAL_CLOSE_SCOPE%'; END;
 IF NOT denied THEN RAISE EXCEPTION 'C6_CROSS_TENANT_LOCK_ACCEPTED'; END IF;
 IF (SELECT count(*) FROM public.financial_accrual_period_reviews)<>2
 THEN RAISE EXCEPTION 'C6_UNEXPECTED_REVIEW_ROWS'; END IF;
 END \$test\$;"
echo C6_TWO_INDEPENDENT_SESSIONS_ONE_LOCK_REPLAY_DENIAL_DRIFT_PASS
