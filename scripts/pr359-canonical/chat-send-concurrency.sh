#!/usr/bin/env bash
# Actual simultaneous transactions; same-conversation serialization candidate.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${PGPASSWORD:-}" == postgres && "$#" == 0 ]] || exit 2
db=pr359_chat_send_characterization
tmp="$(mktemp -d)"
a_pid=''; b_pid=''
cleanup() {
  for pid in "$a_pid" "$b_pid"; do
    if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || :; wait "$pid" 2>/dev/null || :; fi
  done
  rm -rf "$tmp"
}
trap cleanup EXIT
run_sql() {
 psql -X -w -qAt -h 127.0.0.1 -p 5432 -U postgres -d "$db" -v ON_ERROR_STOP=1
}
run_sql <<'SQL'
DO $guard$ BEGIN
 IF current_database()<>'pr359_chat_send_characterization'
 OR to_regprocedure('private.fixture_expect_error(text,text)') IS NULL
 OR (SELECT count(*) FROM public.chat_messages WHERE id<100)<>2
 THEN RAISE EXCEPTION 'disposable chat send fixture required'; END IF;
END $guard$;
SQL
before="$(printf '%s\n' "SELECT coalesce(sum(attempts),0) FROM private.chat_rate_limit_buckets;" | run_sql)"
effects="$(printf '%s\n' "SELECT count(*) FROM private.fixture_effects;" | run_sql)"
sql="SELECT (private.chat_send_message(1,'concurrent','00000000-0000-4000-8000-000000000021',100)).id;"
coproc WRITER { run_sql 2>"$tmp/a.err"; }
a_pid="$WRITER_PID"; a_in="${WRITER[1]}"; a_out="${WRITER[0]}"
printf '%s\n' "SET application_name='pr359_send_a';" "SET statement_timeout='30s';" "SET lock_timeout='20s';" 'BEGIN;' "$sql" >&"$a_in"
IFS= read -r -t 20 id <&"$a_out"
[[ "$id" =~ ^[1-9][0-9]*$ ]] || exit 1
{
 printf '%s\n' "SET application_name='pr359_send_b';" "SET statement_timeout='30s';" "SET lock_timeout='20s';" 'BEGIN;' "$sql" 'COMMIT;'
} | run_sql >"$tmp/b.out" 2>"$tmp/b.err" &
b_pid="$!"
blocked=0
for i in $(seq 1 100); do
 n="$(run_sql <<'SQL'
SELECT count(*) FROM pg_stat_activity b JOIN pg_stat_activity a ON a.pid=ANY(pg_blocking_pids(b.pid))
WHERE b.datname=current_database() AND a.datname=current_database()
AND b.application_name='pr359_send_b' AND a.application_name='pr359_send_a' AND b.wait_event_type='Lock';
SQL
)"
 if [[ "$n" == 1 ]]; then blocked=1; break; fi
 sleep 0.1
done
[[ "$blocked" == 1 ]] || { cat "$tmp/b.err" >&2; exit 1; }
printf '%s\n' 'COMMIT;' '\q' >&"$a_in"
if ! wait "$a_pid"; then cat "$tmp/a.err" >&2; exit 1; fi
a_pid=''
if ! wait "$b_pid"; then cat "$tmp/b.err" >&2; exit 1; fi
b_pid=''
[[ "$(cat "$tmp/b.out")" == "$id" ]] || { cat "$tmp/b.out" >&2; exit 1; }
run_sql <<SQL
DO \$verify\$
BEGIN
 IF (SELECT count(*) FROM public.chat_messages WHERE conversation_id=1 AND client_message_id='00000000-0000-4000-8000-000000000021')<>1
 OR (SELECT id FROM public.chat_messages WHERE conversation_id=1 AND client_message_id='00000000-0000-4000-8000-000000000021')<>$id
 OR (SELECT coalesce(sum(attempts),0) FROM private.chat_rate_limit_buckets)<>$before+2
 OR (SELECT count(*) FROM private.fixture_effects)<>$effects+1
 THEN RAISE EXCEPTION 'concurrent replay repeated side effects or did not return same row'; END IF;
END \$verify\$;
SQL
echo PR359_CHAT_SEND_CONCURRENT_EXACT_REPLAY_PASS
echo PR359_CHAT_SEND_FIXTURE_ONLY_NO_HOSTED_AUTHORIZATION
