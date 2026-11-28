#!/usr/bin/env bash
# D2: two different checkers race to post the same accrual and GL source.
# Disposable PostgreSQL test only.
set -euo pipefail
: "$PGPASSWORD"
[[ "$PGDATABASE" == financial_gl_two_session_test && "$PGHOST" == 127.0.0.1 && "$PGPORT" == 5432 ]] || {
 echo D2_NOT_DISPOSABLE_DB;exit 1; }
tmp="$(mktemp -d)";trap 'rm -rf "$tmp"' EXIT
sql() { psql -XAt -v ON_ERROR_STOP=1 -c "$1"; }
sql "INSERT INTO public.users(id) VALUES (9903) ON CONFLICT DO NOTHING;" >/dev/null
journal="$(sql "SELECT public.powerhub_financial_accrual_journal_create(901,9101,9901,'2026-07','5100','2100',22.45,'Two independent checkers compete on identical approved source','d2-two-checker-original');")"
[[ "$journal" =~ ^[0-9]+$ ]] || { echo D2_JOURNAL_NOT_CREATED;exit 1; }
lock="hashtextextended('powerhub:accrual-period:901:9101:2026-07',0)"
(sql "SELECT pg_advisory_lock($lock);SELECT pg_sleep(3);SELECT pg_advisory_unlock($lock);" >/dev/null) &
coord=$!
ready=0
for i in $(seq 1 50);do
 if [[ "$(sql "SELECT NOT pg_try_advisory_lock($lock);")" == t ]];then ready=1;break;fi
 sleep .05
done
[[ "$ready" == 1 ]] || { wait "$coord" || true;echo D2_LOCK_NOT_HELD;exit 1; }
psql -XAt -v ON_ERROR_STOP=1 -c "SELECT pg_backend_pid();" -c "SELECT public.powerhub_financial_accrual_post_and_gl(901,9101,$journal,9902)->>'glEntryId';" > "$tmp/a" 2>&1 &
pid_a=$!
psql -XAt -v ON_ERROR_STOP=1 -c "SELECT pg_backend_pid();" -c "SELECT public.powerhub_financial_accrual_post_and_gl(901,9101,$journal,9903)->>'glEntryId';" > "$tmp/b" 2>&1 &
pid_b=$!
set +e
wait "$pid_a";rc_a=$?
wait "$pid_b";rc_b=$?
wait "$coord";rc_coord=$?
set -e
b_a="$(head -1 "$tmp/a")";b_b="$(head -1 "$tmp/b")"
[[ "$b_a" =~ ^[0-9]+$ && "$b_b" =~ ^[0-9]+$ && "$b_a" != "$b_b" && "$rc_coord" -eq 0 && $(( (rc_a==0)+(rc_b==0) )) -eq 1 ]] || {
 echo D2_APPROVAL_RACE_NOT_EXCLUSIVE;cat "$tmp/a" "$tmp/b";exit 1; }
if [[ "$rc_a" == 0 ]];then
 winner="$(tail -1 "$tmp/a")";loser="$tmp/b";actor=9902
else winner="$(tail -1 "$tmp/b")";loser="$tmp/a";actor=9903;fi
[[ "$winner" =~ ^[0-9]+$ ]] || { echo D2_NO_GL_WINNER;exit 1; }
grep -q ACCRUAL_JOURNAL_ALREADY_POSTED "$loser" || { echo D2_WRONG_APPROVAL_LOSER;cat "$loser";exit 1; }
sql "DO \$d\$
DECLARE n bigint;net numeric;
BEGIN
 IF (SELECT approved_by_user_id FROM public.financial_accrual_journals WHERE id=$journal)<>$actor
 THEN RAISE EXCEPTION 'D2_WINNER_APPROVER_MISMATCH';END IF;
 SELECT count(*) INTO n FROM public.financial_gl_entries
 WHERE tenant_id=901 AND site_id=9101 AND source_type='accrual_adjustment' AND source_id='$journal';
 IF n<>1 THEN RAISE EXCEPTION 'D2_DOUBLE_APPROVAL_GL';END IF;
 SELECT coalesce(sum(CASE WHEN side='debit' THEN amount ELSE -amount END),0)
 INTO net FROM public.financial_gl_lines WHERE entry_id=$winner;
 IF net<>0 THEN RAISE EXCEPTION 'D2_APPROVAL_GL_NOT_BALANCED';END IF;
END \$d\$;" >/dev/null
echo D2_INDEPENDENT_APPROVE_APPROVE_EXACTLY_ONE_WINNER_AND_ONE_GL_PASS
