#!/usr/bin/env bash
# D8 regression: real versioned D6 C4 close versus D4 payroll writer, independent PG sessions.
# Fake source-coverage aggregator only; real D4 guard and D6-versioned C4 close RPCs.
# Both participants run in different PostgreSQL backends and contend on May period key.
set -euo pipefail
: "$PGPASSWORD"
[[ "$PGHOST" == 127.0.0.1 && "$PGPORT" == 5432 &&
   "$PGDATABASE" == financial_d6_fingerprint_test ]] || {
  echo D8_NOT_ISOLATED_PG17_TEST;exit 1;
}
tmp="$(mktemp -d)";trap 'rm -rf "$tmp"' EXIT
sql(){ psql -XAt -v ON_ERROR_STOP=1 -c "$1"; }
lock="hashtextextended('powerhub:accrual-period:901:9101:2026-05',0)"
(sql "SELECT pg_advisory_lock($lock);SELECT pg_sleep(3);SELECT pg_advisory_unlock($lock);" >/dev/null) &
barrier=$!
ready=0
for i in $(seq 1 60);do
 if [[ "$(sql "SELECT NOT pg_try_advisory_lock($lock);")" == t ]];then ready=1;break;fi
 sleep .05
done
[[ "$ready" == 1 ]] || { wait "$barrier" || true;echo D8_BARRIER_UNAVAILABLE;exit 1; }
psql -XAt -v ON_ERROR_STOP=1 \
 -c "SELECT pg_backend_pid();" \
 -c "INSERT INTO public.payroll_runs
  (id,tenant_id,site_id,period,status,total_gross,total_deductions,total_net,created_by_user_id)
  VALUES(901,901,9101,'2026-05','approved',20,3,17,9901);" >"$tmp/payroll" 2>&1 &
payroll_pid=$!
psql -XAt -v ON_ERROR_STOP=1 \
 -c "SELECT pg_backend_pid();" \
 -c "SELECT public.powerhub_financial_accrual_period_lock(901,9101,'2026-05',9902)->>'status';" >"$tmp/close" 2>&1 &
close_pid=$!
set +e
wait "$payroll_pid";p_rc=$?
wait "$close_pid";c_rc=$?
wait "$barrier";b_rc=$?
set -e
first="$(head -1 "$tmp/payroll")";second="$(head -1 "$tmp/close")"
[[ "$b_rc" -eq 0 && "$first" =~ ^[0-9]+$ && "$second" =~ ^[0-9]+$ &&
   "$first" != "$second" && $(( (p_rc==0)+(c_rc==0) )) -eq 1 ]] || {
 echo D8_NON_SERIALIZABLE_PAYROLL_CLOSE;cat "$tmp/payroll" "$tmp/close";exit 1; }
if [[ "$p_rc" -eq 0 ]];then
 grep -q 'ACCRUAL_CLOSE_UNRESOLVED_SOURCE_invalidPayrollCount' "$tmp/close" || {
  echo D8_CLOSE_IGNORED_APPROVED_PAYROLL;cat "$tmp/close";exit 1; }
 [[ "$(sql "SELECT status FROM public.financial_accrual_period_reviews WHERE tenant_id=901 AND site_id=9101 AND period='2026-05';")" == draft ]] || exit 1
 [[ "$(sql "SELECT count(*) FROM public.payroll_runs WHERE id=901;")" == 1 ]] || exit 1
else
 grep -q 'ERROR:  D4_ACCRUAL_SOURCE_PERIOD_LOCKED' "$tmp/payroll" || {
  echo D8_PAYROLL_WRITER_IGNORED_LOCK;cat "$tmp/payroll";exit 1; }
 [[ "$(tail -1 "$tmp/close")" == locked ]] || exit 1
 [[ "$(sql "SELECT count(*) FROM public.payroll_runs WHERE id=901;")" == 0 ]] || exit 1
fi
echo D8_PAYROLL_VS_C4_CLOSE_INDEPENDENT_BACKENDS_LINEARIZABLE_PASS
