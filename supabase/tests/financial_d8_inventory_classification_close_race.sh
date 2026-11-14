#!/usr/bin/env bash
# D8 inventory-item category/treatment update vs real C4 close, two independent PG sessions.
# Synthetic D2 source-coverage marker; D5 item guard and C4 close RPCs are real migration code.
set -euo pipefail
: "$PGPASSWORD"
[[ "$PGHOST" == 127.0.0.1 && "$PGPORT" == 5432 &&
   "$PGDATABASE" == financial_d5_inventory_item_guard_test ]] || {
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
 -c "UPDATE public.inventory_items
  SET category='other',accounting_treatment='capital_asset'
  WHERE id=10 AND tenant_id=901;" >"$tmp/item" 2>&1 &
item_pid=$!
psql -XAt -v ON_ERROR_STOP=1 \
 -c "SELECT pg_backend_pid();" \
 -c "SELECT public.powerhub_financial_accrual_period_lock(901,9101,'2026-05',9902)->>'status';" >"$tmp/close" 2>&1 &
close_pid=$!
set +e
wait "$item_pid";i_rc=$?
wait "$close_pid";c_rc=$?
wait "$barrier";b_rc=$?
set -e
first="$(head -1 "$tmp/item")";second="$(head -1 "$tmp/close")"
[[ "$b_rc" -eq 0 && "$first" =~ ^[0-9]+$ && "$second" =~ ^[0-9]+$ &&
   "$first" != "$second" && $(( (i_rc==0)+(c_rc==0) )) -eq 1 ]] || {
 echo D8_NON_SERIALIZABLE_CLASSIFICATION_CLOSE;cat "$tmp/item" "$tmp/close";exit 1; }
if [[ "$i_rc" -eq 0 ]];then
 grep -q 'ACCRUAL_CLOSE_UNRESOLVED_SOURCE_invalidInventoryCount' "$tmp/close" || {
  echo D8_CLOSE_IGNORED_CLASSIFICATION;cat "$tmp/close";exit 1; }
 [[ "$(sql "SELECT status FROM public.financial_accrual_period_reviews WHERE tenant_id=901 AND site_id=9101 AND period='2026-05';")" == draft ]] || exit 1
 [[ "$(sql "SELECT count(*) FROM public.inventory_items WHERE id=10 AND accounting_treatment='capital_asset';")" == 1 ]] || exit 1
else
 grep -q 'D5_INVENTORY_CLASSIFICATION_ACCRUAL_PERIOD_LOCKED' "$tmp/item" || {
  echo D8_ITEM_WRITER_IGNORED_LOCK;cat "$tmp/item";exit 1; }
 [[ "$(tail -1 "$tmp/close")" == locked ]] || exit 1
 [[ "$(sql "SELECT count(*) FROM public.inventory_items WHERE id=10 AND accounting_treatment='capital_asset';")" == 0 ]] || exit 1
fi
echo D8_ITEM_VS_C4_CLOSE_INDEPENDENT_BACKENDS_LINEARIZABLE_PASS
