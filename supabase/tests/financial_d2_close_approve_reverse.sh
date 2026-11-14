#!/usr/bin/env bash
# PowerHub D2: actual C4 close and journal RPCs, isolated-source fixture only.
# Two independent PostgreSQL backends compete; database must be disposable CI.
set -euo pipefail
: "$PGPASSWORD"
[[ "$PGHOST" == 127.0.0.1 && "$PGPORT" == 5432 &&
   "$PGDATABASE" == financial_d2_close_race_test ]] || { echo D2_REFUSE_NON_DISPOSABLE_DATABASE;exit 1; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
sql() { psql -XAt -v ON_ERROR_STOP=1 -c "$1"; }
barrier() {
 local key="hashtextextended('powerhub:accrual-period:901:9101:$1',0)"
 (sql "SELECT pg_advisory_lock($key);SELECT pg_sleep(3);SELECT pg_advisory_unlock($key);" >/dev/null) &
 coordinator=$!
 ready=0
 for _ in $(seq 1 50);do
   if [[ "$(sql "SELECT NOT pg_try_advisory_lock($key);")" == t ]];then ready=1;break;fi
   sleep .05
 done
 [[ "$ready" == 1 ]] || { wait "$coordinator" || true;echo D2_LOCK_BARRIER_FAILED;exit 1; }
}
worker() {
 psql -XAt -v ON_ERROR_STOP=1 -c "SELECT pg_backend_pid();" -c "$1" > "$2" 2>&1
}
verify_backends() {
 local a b
 a="$(head -1 "$1")";b="$(head -1 "$2")"
 [[ "$a" =~ ^[0-9]+$ && "$b" =~ ^[0-9]+$ && "$a" != "$b" ]] ||
  { echo D2_BACKENDS_NOT_INDEPENDENT;cat "$1" "$2";exit 1; }
}
journal="$(sql "SELECT public.powerhub_financial_accrual_journal_create(901,9101,9901,'2026-09','5100','2100',30.25,'Pending September adjustment for D2 close-versus-approval','d2-close-approval-source');")"
[[ "$journal" =~ ^[0-9]+$ ]] || exit 1
barrier 2026-09
worker "SELECT public.powerhub_financial_accrual_journal_post(901,9101,$journal,9902)->>'status';" "$tmp/approval" &
a_pid=$!
worker "SELECT public.powerhub_financial_accrual_period_lock(901,9101,'2026-09',9903)->>'status';" "$tmp/close_a" &
b_pid=$!
set +e
wait "$a_pid";a_rc=$?
wait "$b_pid";b_rc=$?
wait "$coordinator";c_rc=$?
set -e
verify_backends "$tmp/approval" "$tmp/close_a"
[[ "$c_rc" -eq 0 ]] || { echo D2_APPROVAL_BARRIER_FAILED;exit 1; }
# Two valid serial histories exist: (1) close observes pending draft and
# rejects, then approval posts; (2) approval completes first, then close sees
# no unresolved draft and may succeed. Closing BEFORE a pending draft is posted
# must never succeed, and no draft may persist in a locked period.
[[ "$a_rc" -eq 0 ]] || {
 echo D2_APPROVAL_NEVER_COMPLETED
 cat "$tmp/approval" "$tmp/close_a";exit 1; }
[[ "$(tail -1 "$tmp/approval")" == posted ]] || exit 1
if [[ "$b_rc" -eq 0 ]];then
 [[ "$(tail -1 "$tmp/close_a")" == locked ]] || exit 1
 [[ "$(sql "SELECT status FROM public.financial_accrual_period_reviews WHERE period='2026-09';")" == locked ]] || exit 1
 [[ "$(sql "SELECT count(*) FROM public.financial_accrual_journals WHERE tenant_id=901 AND site_id=9101 AND period='2026-09' AND status='draft';")" == 0 ]] || {
  echo D2_LOCKED_PERIOD_CONTAINS_PENDING_DRAFT;exit 1; }
else
 grep -q ACCRUAL_SOURCES_NOT_RECONCILED "$tmp/close_a" || {
  echo D2_CLOSE_APPROVE_WRONG_DENIAL
  cat "$tmp/close_a";exit 1; }
 [[ "$(sql "SELECT status FROM public.financial_accrual_period_reviews WHERE period='2026-09';")" == draft ]] || exit 1
fi
[[ "$(sql "SELECT count(*) FROM public.financial_accrual_journals WHERE id=$journal;")" == 1 ]] || exit 1
echo D2_CLOSE_VS_APPROVE_TWO_BACKENDS_CONSISTENT

original="$(sql "SELECT public.powerhub_financial_accrual_journal_create(901,9101,9901,'2026-07','5100','2100',21.35,'Older posted source for reverse-versus-close in D2','d2-close-reverse-original');")"
[[ "$original" =~ ^[0-9]+$ ]] || exit 1
[[ "$(sql "SELECT public.powerhub_financial_accrual_journal_post(901,9101,$original,9902)->>'status';")" == posted ]] || exit 1
barrier 2026-10
worker "SELECT public.powerhub_financial_accrual_journal_reverse(901,9101,$original,9901,'2026-10','October reversal competing against independent period close','d2-close-versus-reverse');" "$tmp/reverse" &
a_pid=$!
worker "SELECT public.powerhub_financial_accrual_period_lock(901,9101,'2026-10',9903)->>'status';" "$tmp/close_b" &
b_pid=$!
set +e
wait "$a_pid";a_rc=$?
wait "$b_pid";b_rc=$?
wait "$coordinator";c_rc=$?
set -e
verify_backends "$tmp/reverse" "$tmp/close_b"
[[ "$c_rc" -eq 0 ]] || exit 1
if [[ "$a_rc" -eq 0 && "$b_rc" -ne 0 ]];then
 reverse_id="$(tail -1 "$tmp/reverse")"
 [[ "$reverse_id" =~ ^[0-9]+$ ]] || exit 1
 grep -q ACCRUAL_SOURCES_NOT_RECONCILED "$tmp/close_b" || {
 echo D2_REVERSE_WON_CLOSE_WRONG_FAILURE;cat "$tmp/close_b";exit 1; }
 [[ "$(sql "SELECT status FROM public.financial_accrual_period_reviews WHERE period='2026-10';")" == draft ]] || exit 1
 [[ "$(sql "SELECT count(*) FROM public.financial_accrual_journals WHERE id=$reverse_id AND reverses_journal_id=$original AND status='draft';")" == 1 ]] || exit 1
elif [[ "$a_rc" -ne 0 && "$b_rc" -eq 0 ]];then
 grep -q ACCRUAL_PERIOD_LOCKED "$tmp/reverse" || {
 echo D2_CLOSE_WON_REVERSE_NOT_BLOCKED;cat "$tmp/reverse";exit 1; }
 [[ "$(tail -1 "$tmp/close_b")" == locked ]] || exit 1
 [[ "$(sql "SELECT status FROM public.financial_accrual_period_reviews WHERE period='2026-10';")" == locked ]] || exit 1
 [[ "$(sql "SELECT count(*) FROM public.financial_accrual_journals WHERE reverses_journal_id=$original;")" == 0 ]] || exit 1
else
 echo D2_CLOSE_REVERSE_NOT_EXCLUSIVE
 cat "$tmp/reverse" "$tmp/close_b";exit 1
fi
echo D2_CLOSE_VS_REVERSE_TWO_BACKENDS_CONSISTENT

# Separate deterministic proof: locked month cannot accept journal, and a
# source-revision change is reported as drift (not silently certified).
[[ "$(sql "SELECT public.powerhub_financial_accrual_period_lock(901,9101,'2026-06',9902)->>'status';")" == locked ]] || exit 1
sql "UPDATE public.d2_sources SET revision=revision+1 WHERE tenant_id=901 AND site_id=9101 AND period='2026-06';" >/dev/null
sql "DO \$proof\$
DECLARE r jsonb; denied boolean:=false;
BEGIN
 r:=public.powerhub_financial_accrual_period_review_status(901,9101,'2026-06');
 IF r->>'status'<>'locked' OR (r->>'driftDetected')::boolean IS DISTINCT FROM true
   OR (r->>'isCertifiedProfit')::boolean IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'D2_POST_CLOSE_DRIFT_NOT_DETECTED';END IF;
 BEGIN
  PERFORM public.powerhub_financial_accrual_journal_create(
   901,9101,9901,'2026-06','5100','2100',8.11,
   'Post-close entry must be rejected by the actual trigger',
   'd2-after-close-source');
 EXCEPTION WHEN OTHERS THEN denied:=SQLERRM LIKE '%ACCRUAL_PERIOD_LOCKED%';END;
 IF NOT denied THEN RAISE EXCEPTION 'D2_LOCKED_PERIOD_ACCEPTED_ENTRY';END IF;
 denied:=false;
 BEGIN
  PERFORM public.powerhub_financial_accrual_period_lock(902,9101,'2026-06',9903);
 EXCEPTION WHEN OTHERS THEN denied:=SQLERRM LIKE '%INVALID_ACCRUAL_CLOSE_SCOPE%';END;
 IF NOT denied THEN RAISE EXCEPTION 'D2_CROSS_TENANT_LOCK_ACCEPTED';END IF;
END \$proof\$;" >/dev/null
echo D2_POST_CLOSE_SOURCE_DRIFT_LOCKED_JOURNAL_TENANT_SCOPE_PASS
