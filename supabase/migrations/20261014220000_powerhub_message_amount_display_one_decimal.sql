-- Display monetary template variables with one decimal place only.
-- Stored amounts and balance aggregation remain unchanged; rounding is presentation-only.
do $migration$
declare
  v_record record;
  v_definition text;
  v_patched text;
begin
  for v_record in
    select p.oid, p.proname, p.pronargs, pg_get_functiondef(p.oid) as definition
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'powerhub_queue_invoice_sms_after_issue',
        'powerhub_queue_selected_invoice_sms',
        'powerhub_approve_and_issue_mobile_reading'
      )
  loop
    v_definition := v_record.definition;
    v_patched := v_definition;
    v_patched := replace(v_patched, 'new.total_amount::text', 'round(new.total_amount, 1)::text');
    v_patched := replace(v_patched, 'new.balance_due::text', 'round(new.balance_due, 1)::text');
    v_patched := replace(v_patched, 'v_invoice.total_amount::text', 'round(v_invoice.total_amount, 1)::text');
    v_patched := replace(v_patched, 'v_invoice.balance_due::text', 'round(v_invoice.balance_due, 1)::text');
    v_patched := replace(v_patched, 'v_total_amount::text', 'round(v_total_amount, 1)::text');
    v_patched := replace(v_patched,
      'coalesce((select sum(i.balance_due)::text',
      'coalesce((select round(sum(i.balance_due), 1)::text');
    v_patched := replace(v_patched,
      'coalesce((select sum(i.balance_due)::text',
      'coalesce((select round(sum(i.balance_due), 1)::text');
    if v_patched <> v_definition then
      execute v_patched;
    end if;
  end loop;
end;
$migration$;
