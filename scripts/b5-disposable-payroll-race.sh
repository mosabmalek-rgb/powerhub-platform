#!/usr/bin/env bash
set -euo pipefail
[[ "${PGDATABASE:-}" == powerhub_b5_synthetic_payroll_test ]] || exit 2
[[ "${PGHOST:-}" == 127.0.0.1 || "${PGHOST:-}" == localhost ]] || exit 2
[[ "${PGUSER:-}" == postgres ]] || exit 2
db() { psql -XAt --no-psqlrc --set ON_ERROR_STOP=1 --dbname "$PGDATABASE" "$@"; }
[[ "$(db -c 'SELECT current_database()')" == powerhub_b5_synthetic_payroll_test ]] || exit 2
dir="$(mktemp -d)"; trap 'rm -rf "$dir"' EXIT

# Distinct PostgreSQL connections race to approve the SAME payroll, using two
# independent eligible reviewers. One wins and exactly one conflicting actor
# must be denied without creating a second audit.
(
  db -c "SET ROLE service_role; SELECT * FROM public.powerhub_approve_payroll(901,9101,9902,10401);"    > "$dir/a.out" 2> "$dir/a.err"; echo $? > "$dir/a.status"
) &
pid1=$!
(
  db -c "SET ROLE service_role; SELECT * FROM public.powerhub_approve_payroll(901,9101,9903,10401);"    > "$dir/b.out" 2> "$dir/b.err"; echo $? > "$dir/b.status"
) &
pid2=$!
wait "$pid1" || true
wait "$pid2" || true
a=1; b=1
[[ -e "$dir/a.status" ]] && a="$(cat "$dir/a.status")"
[[ -e "$dir/b.status" ]] && b="$(cat "$dir/b.status")"
if ! { [[ "$a" == 0 && "$b" != 0 ]] || [[ "$b" == 0 && "$a" != 0 ]]; }; then
  echo "B5_EXPECTED_SINGLE_PAYROLL_WINNER a=$a b=$b" >&2
  cat "$dir/a.err" "$dir/b.err" >&2; exit 1
fi
if [[ "$a" != 0 ]]; then grep -q PAYROLL_APPROVAL_REPLAY_CONFLICT "$dir/a.err" || exit 1; fi
if [[ "$b" != 0 ]]; then grep -q PAYROLL_APPROVAL_REPLAY_CONFLICT "$dir/b.err" || exit 1; fi
db -c "DO \$guard\$
DECLARE n int; actor bigint;
BEGIN
 SELECT count(*),max(approved_by_user_id) INTO n,actor FROM public.payroll_runs
 WHERE id=10401 AND status='approved' AND approved_by_user_id IN (9902,9903);
 IF n<>1 THEN RAISE EXCEPTION 'B5_PAYROLL_RACE_APPROVAL_MISMATCH'; END IF;
 SELECT count(*) INTO n FROM public.audit_logs WHERE entity_type='payroll_run'
 AND entity_id='10401' AND action='approve' AND user_id=actor;
 IF n<>1 THEN RAISE EXCEPTION 'B5_PAYROLL_RACE_DUPLICATE_AUDIT'; END IF;
END \$guard\$;"
echo B5_PAYROLL_TWO_REVIEWER_SAME_RUN_RACE_ONE_WINNER_PASS
