#!/bin/bash
# D2.1 independent PostgreSQL 17 race; isolated CI database ONLY
set -euo pipefail
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGDATABASE=financial_gl_two_session_test
: "$PGPASSWORD"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
orig="$(psql -XAt -v ON_ERROR_STOP=1 -c "SELECT public.powerhub_financial_accrual_journal_create(901,9101,9901,'2026-08','5100','2100',31.11,'Independent source for reversal concurrency in D2','d2-reverse-race-original');")"
[[ "$orig" =~ ^[0-9]+$ ]] || exit 1
entry="$(psql -XAt -v ON_ERROR_STOP=1 -c "SELECT public.powerhub_financial_accrual_post_and_gl(901,9101,$orig,9902)->>'glEntryId';")"
[[ "$entry" =~ ^[0-9]+$ ]] || exit 1
key="hashtextextended('powerhub:accrual-period:901:9101:2026-10',0)"
(psql -XAt -v ON_ERROR_STOP=1 -c "SELECT pg_advisory_lock($key);SELECT pg_sleep(3);SELECT pg_advisory_unlock($key);" >/dev/null) &
coord=$!
ready=0
for i in $(seq 1 40);do
 if [[ "$(psql -XAt -v ON_ERROR_STOP=1 -c "SELECT NOT pg_try_advisory_lock($key);")" == "t" ]];then ready=1;break;fi
 sleep .05
done
[[ "$ready" -eq 1 ]] || { wait "$coord" || true;echo D2_BARRIER_FAILURE;exit 1; }
psql -XAt -v ON_ERROR_STOP=1 -c "SELECT pg_backend_pid();" -c "SELECT public.powerhub_financial_accrual_journal_reverse(901,9101,$orig,9901,'2026-10','First independent reversal of posted D2 source','d2-reversal-actor-one');" >"$tmp/a" 2>&1 &
a_pid=$!
psql -XAt -v ON_ERROR_STOP=1 -c "SELECT pg_backend_pid();" -c "SELECT public.powerhub_financial_accrual_journal_reverse(901,9101,$orig,9902,'2026-10','Second independent reversal of posted D2 source','d2-reversal-actor-two');" >"$tmp/b" 2>&1 &
b_pid=$!
set +e
wait "$a_pid";a=$?
wait "$b_pid";b=$?
wait "$coord";c=$?
set -e
if [[ "$c" -ne 0 || $(( (a==0)+(b==0) )) -ne 1 ]];then
 echo D2_WRONG_WINNER_COUNT;cat "$tmp/a" "$tmp/b";exit 1;fi
pid_a="$(head -1 "$tmp/a")";pid_b="$(head -1 "$tmp/b")"
[[ "$pid_a" =~ ^[0-9]+$ && "$pid_b" =~ ^[0-9]+$ && "$pid_a" != "$pid_b" ]] ||
 { echo D2_NOT_INDEPENDENT_SESSIONS;exit 1; }
if [[ "$a" -eq 0 ]];then winner="$(tail -1 "$tmp/a")";loser="$tmp/b"
else winner="$(tail -1 "$tmp/b")";loser="$tmp/a";fi
[[ "$winner" =~ ^[0-9]+$ ]] || exit 1
grep -q ACCRUAL_REVERSAL_ALREADY_EXISTS "$loser" || { cat "$loser";exit 1; }
reviewer="$(psql -XAt -v ON_ERROR_STOP=1 -c "SELECT CASE WHEN created_by_user_id=9901 THEN 9902 ELSE 9901 END FROM public.financial_accrual_journals WHERE id=$winner;")"
reverse_entry="$(psql -XAt -v ON_ERROR_STOP=1 -c "SELECT public.powerhub_financial_accrual_post_and_gl(901,9101,$winner,$reviewer)->>'glEntryId';")"
[[ "$reverse_entry" =~ ^[0-9]+$ ]] || exit 1
psql -XAt -v ON_ERROR_STOP=1 -c "DO \$v\$
DECLARE n bigint;net numeric;
BEGIN
 SELECT count(*) INTO n FROM public.financial_accrual_journals WHERE reverses_journal_id=$orig AND status<>'void';
 IF n<>1 THEN RAISE EXCEPTION 'D2_DUPLICATE_REVERSAL';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.financial_gl_entries WHERE id=$reverse_entry AND reverses_entry_id=$entry AND tenant_id=901 AND site_id=9101)
 THEN RAISE EXCEPTION 'D2_BAD_GL_REVERSAL_LINK';END IF;
 SELECT coalesce(sum(CASE WHEN side='debit' THEN amount ELSE -amount END),0) INTO net
 FROM public.financial_gl_lines WHERE entry_id IN($entry,$reverse_entry);
 IF net<>0 THEN RAISE EXCEPTION 'D2_UNBALANCED_REVERSAL';END IF;
END \$v\$;" >/dev/null
echo D2_REVERSE_REVERSE_TWO_INDEPENDENT_SESSIONS_PASS
