#!/usr/bin/env bash
# D22: close-first branch with 3 operational writers, PostgreSQL 17 disposable only.
# Real C4/D6 close and D3/D4 guards; D2 source aggregator is synthetic.
set -euo pipefail
[[ "$PGHOST" == 127.0.0.1 && "$PGPORT" == 5432 &&
   "$PGUSER" == postgres && "$PGDATABASE" == financial_d6_fingerprint_test ]] ||
   { echo D22_DISPOSABLE_ONLY >&2; exit 2; }
: "$PGPASSWORD"
sql(){ psql -XAt --no-psqlrc -v ON_ERROR_STOP=1 --dbname "$PGDATABASE" -c "$1"; }
[[ "$(sql "SELECT current_database()")" == financial_d6_fingerprint_test ]] || exit 2
dir="$(mktemp -d)";trap 'rm -rf "$dir"' EXIT
key="hashtextextended('powerhub:accrual-period:901:9101:2026-03',0)"
dead_before="$(sql "SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()")"
[[ "$dead_before" =~ ^[0-9]+$ ]] || exit 1

# Hold the ACTUAL close transaction open after it takes its period lock.
psql -XAt --no-psqlrc -v ON_ERROR_STOP=1 --dbname "$PGDATABASE" \
 -c "SELECT pg_backend_pid()" -c "BEGIN" \
 -c "SELECT pg_advisory_xact_lock($key)" \
 -c "SELECT public.powerhub_financial_accrual_period_lock(901,9101,'2026-03',9902)->>'status'" \
 -c "SELECT pg_sleep(6)" -c "COMMIT" >"$dir/close" 2>&1 &
closer=$!
held=0
for i in $(seq 1 80);do
 if [[ "$(sql "SELECT NOT pg_try_advisory_lock($key)")" == t ]];then held=1;break;fi
 sleep .05
done
if [[ "$held" != 1 ]];then
 wait "$closer" || true;echo D22_CLOSE_LOCK_NOT_OBSERVED >&2;cat "$dir/close" >&2;exit 1
fi
writer(){
 psql -XAt --no-psqlrc -v ON_ERROR_STOP=1 --dbname "$PGDATABASE" \
  -c "SELECT pg_backend_pid()" -c "$2" >"$dir/$1" 2>&1
}
writer expense_a "INSERT INTO public.expenses
 (id,tenant_id,site_id,category,description,amount,occurred_at,expense_classification,reference_no)
 VALUES (89201,901,9101,'maintenance','D22 March expense A',2.25,
 '2026-03-10 12:00:00+03','operating','D22-EXP-A');" &
a=$!
writer expense_b "INSERT INTO public.expenses
 (id,tenant_id,site_id,category,description,amount,occurred_at,expense_classification,reference_no)
 VALUES (89202,901,9101,'maintenance','D22 March expense B',3.15,
 '2026-03-12 12:00:00+03','operating','D22-EXP-B');" &
b=$!
writer payroll "INSERT INTO public.payroll_runs
 (id,tenant_id,site_id,period,status,total_gross,total_deductions,total_net,created_by_user_id)
 VALUES (89302,901,9101,'2026-03','approved',20,3,17,9901);" &
c=$!
waiters=0
for i in $(seq 1 80);do
 n="$(sql "SELECT count(DISTINCT pid) FROM pg_stat_activity
  WHERE datname=current_database() AND wait_event_type='Lock'
   AND (query LIKE '%D22 March expense%' OR query LIKE '%89302,901,9101%')")"
 [[ "$n" =~ ^[0-9]+$ ]] || exit 1
 if (( n>waiters ));then waiters="$n";fi
 if (( waiters>=3 ));then break;fi
 sleep .05
done
set +e
wait "$a";ra=$?
wait "$b";rb=$?
wait "$c";rc=$?
wait "$closer";rl=$?
set -e
if [[ "$waiters" != 3 || "$ra" == 0 || "$rb" == 0 ||
      "$rc" == 0 || "$rl" != 0 ]];then
 echo "D22_CLOSE_FIRST_ORDER_NOT_PROVEN waiters=$waiters codes=$ra,$rb,$rc,$rl" >&2
 cat "$dir"/* >&2;exit 1
fi
[[ "$(grep -cx locked "$dir/close")" == 1 ]] || {
 echo D22_CLOSE_NOT_LOCKED >&2;cat "$dir/close" >&2;exit 1;
}
for name in expense_a expense_b;do
 grep -q D3_ACCRUAL_SOURCE_PERIOD_LOCKED "$dir/$name" || {
 echo "D22_EXPENSE_GUARD_NOT_ENFORCED_$name" >&2;cat "$dir/$name" >&2;exit 1;
 }
done
grep -q D4_ACCRUAL_SOURCE_PERIOD_LOCKED "$dir/payroll" || {
 echo D22_PAYROLL_GUARD_NOT_ENFORCED >&2;cat "$dir/payroll" >&2;exit 1;
}
: >"$dir/pids"
for name in close expense_a expense_b payroll;do
 pid="$(head -1 "$dir/$name")"
 [[ "$pid" =~ ^[0-9]+$ ]] || { echo D22_BACKEND_PID_MISSING >&2;exit 1; }
 if grep -Fxq "$pid" "$dir/pids";then echo D22_DUPLICATED_BACKEND >&2;exit 1;fi
 echo "$pid" >>"$dir/pids"
done
[[ "$dead_before" == "$(sql "SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()")" ]] || {
 echo D22_DEADLOCK_ADDED >&2;exit 1;
}
sql "DO \$assert\$
DECLARE v jsonb;
BEGIN
 IF (SELECT status FROM public.financial_accrual_period_reviews
  WHERE tenant_id=901 AND site_id=9101 AND period='2026-03') IS DISTINCT FROM 'locked'
 OR (SELECT fingerprint_version FROM public.financial_accrual_period_reviews
  WHERE tenant_id=901 AND site_id=9101 AND period='2026-03') IS DISTINCT FROM 'financial_v3'
 OR EXISTS(SELECT 1 FROM public.expenses WHERE id IN (89201,89202))
 OR EXISTS(SELECT 1 FROM public.payroll_runs WHERE id=89302)
 OR (SELECT blockers FROM public.d2_sources
  WHERE tenant_id=901 AND site_id=9101 AND period='2026-03') IS DISTINCT FROM '{}'::jsonb
 THEN RAISE EXCEPTION 'D22_CLOSED_PERIOD_ACCEPTED_DIRTY_SOURCE';END IF;
 v:=public.powerhub_financial_accrual_period_review_status(901,9101,'2026-03');
 IF v->>'status' IS DISTINCT FROM 'locked'
 OR v->>'driftDetected' IS DISTINCT FROM 'false'
 OR v->>'fingerprintVersion' IS DISTINCT FROM 'financial_v3'
 OR v->>'isCertifiedProfit' IS DISTINCT FROM 'false'
 THEN RAISE EXCEPTION 'D22_CLOSE_SNAPSHOT_INVALID';END IF;
END \$assert\$;" >/dev/null
echo "D22_CLOSE_FIRST_THREE_WRITERS_BLOCKED_FOUR_BACKENDS_PASS waiters=$waiters deadlocks_added=0"
