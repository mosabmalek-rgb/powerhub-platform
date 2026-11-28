#!/usr/bin/env bash
# D3: actual C4 close + guarded expense insert race in disposable PostgreSQL.
set -euo pipefail
: "$PGPASSWORD"
[[ "$PGHOST" == "127.0.0.1" && "$PGPORT" == 5432 &&
   "$PGDATABASE" == "financial_d3_source_guard_test" ]] || {
 echo D3_REFUSE_NON_DISPOSABLE_DATABASE;exit 1; }
tmp="$(mktemp -d)";trap 'rm -rf "$tmp"' EXIT
sql() { psql -XAt -v ON_ERROR_STOP=1 -c "$1"; }
lock="hashtextextended('powerhub:accrual-period:901:9101:2026-05',0)"
(sql "SELECT pg_advisory_lock($lock);SELECT pg_sleep(3);SELECT pg_advisory_unlock($lock);" >/dev/null) &
coord=$!
ready=0
for i in $(seq 1 60);do
 if [[ "$(sql "SELECT NOT pg_try_advisory_lock($lock);")" == t ]];then ready=1;break;fi
 sleep .05
done
[[ "$ready" -eq 1 ]] || { wait "$coord" || true;echo D3_BARRIER_NOT_ACQUIRED;exit 1; }
psql -XAt -v ON_ERROR_STOP=1 -c "SELECT pg_backend_pid();" -c "
 INSERT INTO public.expenses VALUES
 (901,901,9101,'maintenance','Concurrent source write versus C4 May close',2.34,
  '2026-05-15 12:00:00+03','operating',NULL,'D3-RACE');" > "$tmp/source" 2>&1 &
source_pid=$!
psql -XAt -v ON_ERROR_STOP=1 -c "SELECT pg_backend_pid();" -c "
 SELECT public.powerhub_financial_accrual_period_lock(901,9101,'2026-05',9902)->>'status';" > "$tmp/close" 2>&1 &
close_pid=$!
set +e
wait "$source_pid";source_rc=$?
wait "$close_pid";close_rc=$?
wait "$coord";coord_rc=$?
set -e
pa="$(head -1 "$tmp/source")";pb="$(head -1 "$tmp/close")"
[[ "$pa" =~ ^[0-9]+$ && "$pb" =~ ^[0-9]+$ && "$pa" != "$pb" &&
   "$coord_rc" -eq 0 && $(( (source_rc==0)+(close_rc==0) )) -eq 1 ]] || {
 echo D3_SOURCE_CLOSE_NOT_LINEARIZABLE
 cat "$tmp/source" "$tmp/close";exit 1; }
if [[ "$source_rc" == 0 ]];then
 grep -q 'ACCRUAL_CLOSE_UNRESOLVED_SOURCE_invalidExpenseCount' "$tmp/close" || {
 echo D3_CLOSE_DID_NOT_RECHECK_SOURCE;cat "$tmp/close";exit 1; }
 [[ "$(sql "SELECT status FROM public.financial_accrual_period_reviews WHERE tenant_id=901 AND site_id=9101 AND period='2026-05';")" == draft ]] || exit 1
 [[ "$(sql "SELECT count(*) FROM public.expenses WHERE id=901;")" == 1 ]] || exit 1
else
 grep -q D3_ACCRUAL_SOURCE_PERIOD_LOCKED "$tmp/source" || {
 echo D3_SOURCE_NOT_GUARDED_AFTER_CLOSE;cat "$tmp/source";exit 1; }
 [[ "$(tail -1 "$tmp/close")" == locked ]] || exit 1
 [[ "$(sql "SELECT count(*) FROM public.expenses WHERE id=901;")" == 0 ]] || exit 1
fi
echo D3_SOURCE_VS_C4_CLOSE_INDEPENDENT_BACKENDS_LINEARIZABLE_PASS
