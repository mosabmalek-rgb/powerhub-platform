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

# Different request semantics under the same UUID must not return another
# visibility's message. A rolled-back first transaction must leave no effects.
run_mixed_case() {
 local mode="$1" key="$2" before effects id blocked=0 n second
 before="$(printf '%s\n' "SELECT coalesce(sum(attempts),0) FROM private.chat_rate_limit_buckets;" | run_sql)"
 effects="$(printf '%s\n' "SELECT count(*) FROM private.fixture_effects;" | run_sql)"
 coproc WRITER { run_sql 2>"$tmp/a.err"; }
 a_pid="$WRITER_PID"
 local a_in="${WRITER[1]}" a_out="${WRITER[0]}"
 printf '%s\n' "SET application_name='pr359_send_a';" "SET statement_timeout='30s';" "SET lock_timeout='20s';" 'BEGIN;' \
  "SELECT (private.chat_send_message(1,'mixed','$key',100)).id;" >&"$a_in"
 IFS= read -r -t 20 id <&"$a_out"
 [[ "$id" =~ ^[1-9][0-9]*$ ]] || exit 1
 if [[ "$mode" == commit ]]; then
  second="SELECT private.fixture_expect_error('SELECT private.chat_send_internal_note(1,''mixed'',''$key'')','IDEMPOTENCY_CONFLICT');"
 else
  second="SELECT (private.chat_send_internal_note(1,'mixed','$key')).id;"
 fi
 {
  printf '%s\n' "SET application_name='pr359_send_b';" "SET statement_timeout='30s';" "SET lock_timeout='20s';" 'BEGIN;' "$second" 'COMMIT;'
 } | run_sql >"$tmp/b.out" 2>"$tmp/b.err" &
 b_pid="$!"
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
 if [[ "$mode" == commit ]]; then
  printf '%s\n' 'COMMIT;' '\q' >&"$a_in"
 else
  printf '%s\n' 'ROLLBACK;' '\q' >&"$a_in"
 fi
 if ! wait "$a_pid"; then cat "$tmp/a.err" >&2; exit 1; fi
 a_pid=''
 if ! wait "$b_pid"; then cat "$tmp/b.err" >&2; exit 1; fi
 b_pid=''
 if [[ "$mode" == commit ]]; then
  [[ -z "$(cat "$tmp/b.out")" ]] || exit 1
  run_sql <<SQL
DO \$verify\$ BEGIN
 IF (SELECT count(*) FROM public.chat_messages WHERE conversation_id=1 AND client_message_id='$key' AND visibility='public' AND id=$id)<>1
 OR (SELECT count(*) FROM public.chat_messages WHERE conversation_id=1 AND client_message_id='$key')<>1
 OR (SELECT coalesce(sum(attempts),0) FROM private.chat_rate_limit_buckets)<>$before+2
 OR (SELECT count(*) FROM private.fixture_effects)<>$effects+1
 THEN RAISE EXCEPTION 'mixed commit visibility/effects mismatch'; END IF;
END \$verify\$;
SQL
  echo PR359_CHAT_SEND_CONCURRENT_VISIBILITY_CONFLICT_PASS
 else
  local replacement
  replacement="$(cat "$tmp/b.out")"
  [[ "$replacement" =~ ^[1-9][0-9]*$ && "$replacement" != "$id" ]] || exit 1
  run_sql <<SQL
DO \$verify\$ BEGIN
 IF (SELECT count(*) FROM public.chat_messages WHERE conversation_id=1 AND client_message_id='$key' AND visibility='internal' AND id=$replacement)<>1
 OR (SELECT count(*) FROM public.chat_messages WHERE conversation_id=1 AND client_message_id='$key')<>1
 OR EXISTS(SELECT 1 FROM public.chat_messages WHERE id=$id)
 OR (SELECT coalesce(sum(attempts),0) FROM private.chat_rate_limit_buckets)<>$before
 OR (SELECT count(*) FROM private.fixture_effects)<>$effects+1
 THEN RAISE EXCEPTION 'mixed rollback leaked message/rate/effects'; END IF;
END \$verify\$;
SQL
  echo PR359_CHAT_SEND_CONCURRENT_ROLLBACK_RECOVERY_PASS
 fi
}
run_mixed_case commit 00000000-0000-4000-8000-000000000022
run_mixed_case rollback 00000000-0000-4000-8000-000000000023
echo PR359_CHAT_SEND_FIXTURE_ONLY_NO_HOSTED_AUTHORIZATION
