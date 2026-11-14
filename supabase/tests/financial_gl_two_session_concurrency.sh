#!/usr/bin/env bash
# Independent two-session race regression against disposable PostgreSQL 17.
set -euo pipefail
export PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-5432}" PGUSER="${PGUSER:-postgres}"
export PGDATABASE="${PGDATABASE:-financial_gl_two_session_test}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

original="$(psql -XAt --set ON_ERROR_STOP=1 -c "SELECT public.powerhub_financial_accrual_journal_create(901,9101,9901,'2026-09','5100','2100',73.29,'Independent concurrency fixture for accrual to GL posting','gl-two-session-original');")"
[[ "$original" =~ ^[0-9]+$ ]] || { echo "Invalid original journal id"; exit 1; }

run_pair () {
  local journal_id="$1" period="$2" stem="$3"
  # A coordinator holds the SAME period advisory lock acquired by the actual
  # posting RPC. Both independent psql processes queue on it before release.
  (
    psql -XqAt --set ON_ERROR_STOP=1 -c "SELECT pg_advisory_lock(hashtextextended('powerhub:accrual-period:901:9101:$period',0));
    SELECT pg_sleep(2);
    SELECT pg_advisory_unlock(hashtextextended('powerhub:accrual-period:901:9101:$period',0));" > /dev/null
  ) &
  local coordinator=$!
  local ready=0
  for attempt in $(seq 1 25); do
    if [[ "$(psql -XAt --set ON_ERROR_STOP=1 -c "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND granted;")" -gt 0 ]]; then
      ready=1
      break
    fi
    sleep 0.05
  done
  [[ "$ready" == 1 ]] || { echo "Coordinator never acquired the advisory lock"; wait "$coordinator" || true; exit 1; }
  local sql="SELECT pg_backend_pid()::text||'|'||(r->>'glEntryId')||'|'||(r->>'alreadyPosted')||'|'||(r->>'glAlreadyPosted')
  FROM (SELECT public.powerhub_financial_accrual_post_and_gl(901,9101,$journal_id,9902) r) x;"
  psql -XAt --set ON_ERROR_STOP=1 -c "$sql" > "$tmp/$stem-one" &
  local one=$!
  psql -XAt --set ON_ERROR_STOP=1 -c "$sql" > "$tmp/$stem-two" &
  local two=$!
  wait "$one"
  wait "$two"
  wait "$coordinator"
  local first second
  first="$(cat "$tmp/$stem-one")"
  second="$(cat "$tmp/$stem-two")"
  local pid1 id1 p1 gp1 pid2 id2 p2 gp2
  IFS='|' read -r pid1 id1 p1 gp1 <<< "$first"
  IFS='|' read -r pid2 id2 p2 gp2 <<< "$second"
  [[ "$pid1" =~ ^[0-9]+$ && "$pid2" =~ ^[0-9]+$ && "$pid1" != "$pid2" ]] ||
    { echo "$stem did not use distinct database backends"; exit 1; }
  [[ "$id1" =~ ^[0-9]+$ && "$id1" == "$id2" ]] ||
    { echo "$stem concurrent results returned distinct GL entries"; exit 1; }
  [[ "$p1" != "$p2" && "$gp1" != "$gp2" ]] ||
    { echo "$stem did not show one original result and one replay"; exit 1; }
  [[ "$p1" == false || "$p2" == false ]] ||
    { echo "$stem has no original successful posting"; exit 1; }
  [[ "$p1" == true || "$p2" == true ]] ||
    { echo "$stem has no idempotent replay"; exit 1; }
  echo "$id1"
}

original_gl="$(run_pair "$original" '2026-09' original)"
[[ "$original_gl" =~ ^[0-9]+$ ]] || { echo "Original GL result invalid"; exit 1; }

reversal="$(psql -XAt --set ON_ERROR_STOP=1 -c "SELECT public.powerhub_financial_accrual_journal_reverse(
901,9101,$original,9901,'2026-10','Independent concurrency reversal against posted GL source','gl-two-session-reversal');")"
[[ "$reversal" =~ ^[0-9]+$ ]] || { echo "Invalid reversal journal id"; exit 1; }
reversal_gl="$(run_pair "$reversal" '2026-10' reversal)"
[[ "$reversal_gl" =~ ^[0-9]+$ && "$reversal_gl" != "$original_gl" ]] ||
  { echo "Invalid GL reversal identity"; exit 1; }

psql -XAt --set ON_ERROR_STOP=1 <<'SQL' > "$tmp/assertion"
DO $assert$
DECLARE n bigint; lines bigint; net numeric;
BEGIN
 SELECT count(*) INTO n FROM public.financial_gl_entries
 WHERE tenant_id=901 AND site_id=9101 AND source_type='accrual_adjustment';
 IF n<>2 THEN RAISE EXCEPTION 'TWO_SESSION_DUPLICATE_LEDGER_ENTRY'; END IF;
 SELECT count(*),coalesce(sum(CASE WHEN side='debit' THEN amount ELSE -amount END),0)
 INTO lines,net FROM public.financial_gl_lines WHERE tenant_id=901 AND site_id=9101;
 IF lines<>4 OR net<>0 THEN RAISE EXCEPTION 'TWO_SESSION_LEDGER_OUT_OF_BALANCE'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.financial_gl_entries e
 JOIN public.financial_gl_entries r ON r.reverses_entry_id=e.id
 WHERE e.tenant_id=901 AND e.site_id=9101 AND r.tenant_id=901 AND r.site_id=9101
 AND e.source_type='accrual_adjustment' AND r.source_type='accrual_adjustment')
 THEN RAISE EXCEPTION 'TWO_SESSION_REVERSAL_LINK_MISSING'; END IF;
END;$assert$;
SQL
echo "PASS: independent original-post and reversal-post races are exactly once and balanced"
