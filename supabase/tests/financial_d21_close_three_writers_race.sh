#!/usr/bin/env bash
# D21: 3 operational writers vs D6 C4 close; FOUR real PostgreSQL 17
# backends, disposable-only. D3/D4 guards and C4/D6 lock are real;
# the month source aggregator is an explicitly synthetic D2 fixture.
set -euo pipefail
[[ "$PGHOST" == 127.0.0.1 && "$PGPORT" == 5432 &&
   "$PGUSER" == postgres && "$PGDATABASE" == financial_d6_fingerprint_test ]] || {
 echo D21_DISPOSABLE_POSTGRES_ONLY >&2;exit 2;
}
: "$PGPASSWORD"
sql(){ psql -XAt --no-psqlrc -v ON_ERROR_STOP=1 --dbname "$PGDATABASE" -c "$1"; }
[[ "$(sql "SELECT current_database();")" == financial_d6_fingerprint_test ]] || exit 2
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
barrier="hashtextextended('powerhub:accrual-period:901:9101:2026-04',0)"
deadlocks_before="$(sql "SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()")"
[[ "$deadlocks_before" =~ ^[0-9]+$ ]] || exit 1
(sql "SELECT pg_advisory_lock($barrier);SELECT pg_sleep(5);SELECT pg_advisory_unlock($barrier);" >"$tmp/barrier" 2>&1) &
barrier_pid=$!
held=0
for n in $(seq 1 60);do
 if [[ "$(sql "SELECT NOT pg_try_advisory_lock($barrier)")" == t ]];then held=1;break;fi
 sleep .05
done
[[ "$held" == 1 ]] || { wait "$barrier_pid" || true;echo D21_COORDINATOR_NOT_LOCKED >&2;exit 1; }
worker(){
 local name="$1" query="$2"
 psql -XAt --no-psqlrc -v ON_ERROR_STOP=1 --dbname "$PGDATABASE" \
  -c "SELECT pg_backend_pid()" -c "$query" >"$tmp/$name" 2>&1
}
worker expense_a \
 "INSERT INTO public.expenses
  (id,tenant_id,site_id,category,description,amount,occurred_at,
   expense_classification,reference_no)
 VALUES (89101,901,9101,'maintenance','D21 competing April expense A',2.25,
   '2026-04-10 12:00:00+03','operating','D21-EXP-A');" &
a=$!
worker expense_b \
 "INSERT INTO public.expenses
  (id,tenant_id,site_id,category,description,amount,occurred_at,
   expense_classification,reference_no)
 VALUES (89102,901,9101,'maintenance','D21 competing April expense B',3.15,
   '2026-04-12 12:00:00+03','operating','D21-EXP-B');" &
b=$!
worker payroll \
 "INSERT INTO public.payroll_runs
   (id,tenant_id,site_id,period,status,total_gross,total_deductions,total_net,created_by_user_id)
 VALUES(89301,901,9101,'2026-04','approved',20,3,17,9901);" &
c=$!
worker close \
 "SELECT public.powerhub_financial_accrual_period_lock(901,9101,'2026-04',9902)->>'status';" &
d=$!
max_waiters=0
for n in $(seq 1 75);do
 count="$(sql "SELECT count(DISTINCT pid) FROM pg_stat_activity
  WHERE datname=current_database() AND wait_event_type='Lock'
    AND (query LIKE '%D21 competing April%' OR query LIKE '%89301,901,9101%'
      OR query LIKE '%powerhub_financial_accrual_period_lock(901,9101%');")"
 [[ "$count" =~ ^[0-9]+$ ]] || exit 1
 if (( count > max_waiters ));then max_waiters="$count";fi
 if (( max_waiters >= 4 ));then break;fi
 sleep .05
done
set +e
wait "$a";rc_a=$?
wait "$b";rc_b=$?
wait "$c";rc_c=$?
wait "$d";rc_d=$?
wait "$barrier_pid";rc_barrier=$?
set -e
if [[ "$rc_barrier" != 0 || "$max_waiters" != 4 ]];then
 echo "D21_FOUR_WAITING_BACKENDS_NOT_PROVEN waiters=$max_waiters coordinator=$rc_barrier" >&2
 cat "$tmp"/* >&2;exit 1
fi
: >"$tmp/pids"
for name in expense_a expense_b payroll close;do
 pid="$(head -1 "$tmp/$name")"
 [[ "$pid" =~ ^[0-9]+$ ]] || { echo D21_BACKEND_PID_MISSING >&2;cat "$tmp/$name" >&2;exit 1; }
 if grep -Fxq "$pid" "$tmp/pids";then
  echo D21_DUPLICATE_BACKEND_PID >&2;exit 1
 fi
 echo "$pid" >>"$tmp/pids"
done
wins=$(( (rc_a==0)+(rc_b==0)+(rc_c==0) ))
if (( rc_d == 0 ));then
 [[ "$(tail -1 "$tmp/close")" == locked && "$wins" == 0 ]] || {
  echo D21_CLOSE_SUCCEEDED_WITH_COMMITTED_WRITER >&2;exit 1;
 }
 for name in expense_a expense_b;do
  grep -q D3_ACCRUAL_SOURCE_PERIOD_LOCKED "$tmp/$name" || {
   echo "D21_EXPENSE_ESCAPED_CLOSE:$name" >&2;cat "$tmp/$name" >&2;exit 1;
  }
 done
 grep -q D4_ACCRUAL_SOURCE_PERIOD_LOCKED "$tmp/payroll" || {
  echo D21_PAYROLL_ESCAPED_CLOSE >&2;cat "$tmp/payroll" >&2;exit 1;
 }
else
 (( wins >= 1 )) || {
  echo D21_CLOSE_FAILED_WITHOUT_ANY_SOURCE_CHANGE >&2;cat "$tmp"/* >&2;exit 1;
 }
 grep -q 'ACCRUAL_CLOSE_UNRESOLVED_SOURCE_' "$tmp/close" || {
  echo D21_CLOSE_REJECTED_WITH_WRONG_REASON >&2;cat "$tmp/close" >&2;exit 1;
 }
 [[ "$rc_a" == 0 ]] || grep -q D3_ACCRUAL_SOURCE_PERIOD_LOCKED "$tmp/expense_a"
 [[ "$rc_b" == 0 ]] || grep -q D3_ACCRUAL_SOURCE_PERIOD_LOCKED "$tmp/expense_b"
 [[ "$rc_c" == 0 ]] || grep -q D4_ACCRUAL_SOURCE_PERIOD_LOCKED "$tmp/payroll"
fi

sql "DO \$assert\$
DECLARE
 v_status text;v_close jsonb;v_expense int;v_payroll int;
 v_invalid_expense int;v_invalid_payroll int;
BEGIN
 SELECT status INTO v_status FROM public.financial_accrual_period_reviews
 WHERE tenant_id=901 AND site_id=9101 AND period='2026-04';
 SELECT count(*) INTO v_expense FROM public.expenses WHERE id IN(89101,89102);
 SELECT count(*) INTO v_payroll FROM public.payroll_runs WHERE id=89301;
 SELECT coalesce((blockers->>'invalidExpenseCount')::int,0),
        coalesce((blockers->>'invalidPayrollCount')::int,0)
 INTO v_invalid_expense,v_invalid_payroll FROM public.d2_sources
 WHERE tenant_id=901 AND site_id=9101 AND period='2026-04';
 v_close:=public.powerhub_financial_accrual_period_review_status(901,9101,'2026-04');
 IF v_status='locked' THEN
  IF v_expense<>0 OR v_payroll<>0 OR
    v_invalid_expense<>0 OR v_invalid_payroll<>0 OR
    v_close->>'driftDetected' IS DISTINCT FROM 'false' OR
    v_close->>'fingerprintVersion' IS DISTINCT FROM 'financial_v3' OR
    v_close->>'isCertifiedProfit' IS DISTINCT FROM 'false'
  THEN RAISE EXCEPTION 'D21_LOCKED_PERIOD_HAS_DIRTY_SOURCE';END IF;
 ELSIF v_status='draft' THEN
  IF v_expense+v_payroll<1
  OR v_invalid_expense<>(v_expense>0)::int
  OR v_invalid_payroll<>(v_payroll>0)::int
  OR v_close->>'isCertifiedProfit' IS DISTINCT FROM 'false'
  THEN RAISE EXCEPTION 'D21_SOURCE_WON_BUT_AGGREGATOR_OR_STATUS_MISMATCH';END IF;
 ELSE RAISE EXCEPTION 'D21_INVALID_PERIOD_STATE';END IF;
 IF EXISTS(SELECT 1 FROM public.financial_accrual_period_reviews
  WHERE period='2026-04' AND
   (tenant_id<>901 OR site_id<>9101 OR fingerprint_version<>'financial_v3'))
 THEN RAISE EXCEPTION 'D21_WRONG_PERIOD_OR_FINGERPRINT_VERSION';END IF;
END \$assert\$;" >/dev/null
[[ "$deadlocks_before" == "$(sql "SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()")" ]] || {
 echo D21_NEW_DEADLOCK_DETECTED >&2;exit 1
}
echo "D21_THREE_SOURCE_WRITERS_VS_V3_CLOSE_4_SIMULTANEOUS_BACKENDS_PASS waiters=$max_waiters writers_committed=$wins close_committed=$((rc_d==0)) deadlocks_added=0"
