#!/usr/bin/env bash
# Actual independent PostgreSQL sessions; synthetic business/identity fixture.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${PGPASSWORD:-}" == postgres && "$#" == 0 ]] || exit 2
db=pr359_chat_receipt_characterization
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
DO $guard$
BEGIN
 IF current_database()<>'pr359_chat_receipt_characterization'
 OR to_regprocedure('private.chat_mark_read(bigint)') IS NULL
 OR to_regprocedure('private.chat_mark_read_up_to(bigint,bigint)') IS NULL
 OR (SELECT count(*) FROM public.chat_messages WHERE conversation_id=1 AND id IN (100,101,102,103,104,105))<>6
 OR (SELECT count(*) FROM public.chat_participants WHERE conversation_id=1 AND user_id=10)<>1
 THEN RAISE EXCEPTION 'disposable receipt concurrency fixture required'; END IF;
END $guard$;
SQL
run_case() {
  local name="$1" a_sql="$2" b_sql="$3" a_expected="$4" b_expected="$5"
  local line blocked=0 n
  run_sql <<'SQL'
BEGIN;
DELETE FROM public.chat_message_receipts WHERE conversation_id=1 AND user_id=10;
UPDATE public.chat_participants SET last_read_message_id=100,last_read_at=NULL WHERE conversation_id=1 AND user_id=10;
COMMIT;
SQL
  coproc WRITER { run_sql 2>"$tmp/a.err"; }
  a_pid="$WRITER_PID"
  local a_in="${WRITER[1]}" a_out="${WRITER[0]}"
  printf '%s\n' "SET application_name='pr359_chat_a';" "SET statement_timeout='30s';" "SET lock_timeout='20s';" 'BEGIN;' "$a_sql" >&"$a_in"
  IFS= read -r -t 20 line <&"$a_out"
  [[ "$line" == "$a_expected" ]] || { echo "unexpected A result: $line" >&2; exit 1; }
  {
    printf '%s\n' "SET application_name='pr359_chat_b';" "SET statement_timeout='30s';" "SET lock_timeout='20s';" 'BEGIN;' "$b_sql" 'COMMIT;'
  } | run_sql >"$tmp/b.out" 2>"$tmp/b.err" &
  b_pid="$!"
  for i in $(seq 1 100); do
    n="$(run_sql <<'SQL'
SELECT count(*) FROM pg_stat_activity b JOIN pg_stat_activity a ON a.pid=ANY(pg_blocking_pids(b.pid))
WHERE b.datname=current_database() AND a.datname=current_database()
AND b.application_name='pr359_chat_b' AND a.application_name='pr359_chat_a' AND b.wait_event_type='Lock';
SQL
)"
    if [[ "$n" == 1 ]]; then blocked=1; break; fi
    sleep 0.1
  done
  [[ "$blocked" == 1 ]] || { echo "$name: actual lock contention not observed" >&2; cat "$tmp/b.err" >&2; exit 1; }
  printf '%s\n' 'COMMIT;' '\q' >&"$a_in"
  if ! wait "$a_pid"; then cat "$tmp/a.err" >&2; exit 1; fi
  a_pid=''
  if ! wait "$b_pid"; then cat "$tmp/b.err" >&2; exit 1; fi
  b_pid=''
  [[ "$(cat "$tmp/b.out")" == "$b_expected" ]] || { echo "$name: unexpected B result" >&2; cat "$tmp/b.out" >&2; exit 1; }
  run_sql <<'SQL'
DO $verify$
BEGIN
 IF (SELECT last_read_message_id FROM public.chat_participants WHERE conversation_id=1 AND user_id=10) IS DISTINCT FROM 104::bigint
 OR (SELECT count(*) FROM public.chat_message_receipts WHERE conversation_id=1 AND user_id=10 AND read_at IS NOT NULL AND message_id IN (100,101,103,104))<>4
 OR EXISTS(SELECT 1 FROM public.chat_message_receipts WHERE user_id=10 AND message_id IN (102,105,200))
 THEN RAISE EXCEPTION 'concurrent receipt or pointer invariant violated'; END IF;
END $verify$;
SQL
  echo "$name"
}
# Older bulk waits behind a newer single read on the participant row.
run_case PR359_CHAT_CONCURRENT_SINGLE_NEWER_BULK_OLDER_PASS \
  "SELECT (private.chat_mark_read(104)).message_id;" "SELECT private.chat_mark_read_up_to(1,103);" 104 3
# Overlapping bulk operations contend on receipts: replay must count zero.
run_case PR359_CHAT_CONCURRENT_OVERLAPPING_BULK_EXACT_COUNT_PASS \
  "SELECT private.chat_mark_read_up_to(1,104);" "SELECT private.chat_mark_read_up_to(1,103);" 4 0
# Newer single read follows an older bulk and advances the pointer.
run_case PR359_CHAT_CONCURRENT_BULK_OLDER_SINGLE_NEWER_PASS \
  "SELECT private.chat_mark_read_up_to(1,103);" "SELECT (private.chat_mark_read(104)).message_id;" 3 104
echo PR359_CHAT_CONCURRENCY_FIXTURE_ONLY_NO_HOSTED_AUTHORIZATION
