-- Message display follows the site's fractional-settlement policy without changing stored money.
-- If either automatic fractional discount or carry-forward is enabled, suppress decimals.
-- If neither is enabled (or no policy row exists), render at most one decimal place.
create or replace function public.powerhub_format_message_amount(
  p_tenant_id bigint,
  p_site_id bigint,
  p_amount numeric
)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select case
    when p_amount is null then ''
    when exists (
      select 1
      from public.site_billing_policies p
      where p.tenant_id = p_tenant_id
        and p.site_id = p_site_id
        and (
          coalesce(p.automatic_fraction_discount_enabled, false)
          or coalesce(p.fraction_carry_enabled, false)
        )
    ) then round(p_amount, 0)::text
    else round(p_amount, 1)::text
  end;
$function$;

revoke all on function public.powerhub_format_message_amount(bigint,bigint,numeric) from public, anon, authenticated;
grant execute on function public.powerhub_format_message_amount(bigint,bigint,numeric) to service_role;

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
      and (
        (p.proname = 'powerhub_queue_invoice_sms_after_issue' and p.pronargs = 0)
        or (p.proname = 'powerhub_queue_selected_invoice_sms' and p.pronargs = 4)
        or (p.proname = 'powerhub_approve_and_issue_mobile_reading' and p.pronargs = 8)
      )
  loop
    v_definition := v_record.definition;
    v_patched := v_definition;

    if v_record.proname = 'powerhub_queue_invoice_sms_after_issue' then
      v_patched := replace(v_patched, 'round(new.total_amount, 1)::text',
        'public.powerhub_format_message_amount(new.tenant_id, new.site_id, new.total_amount)');
      v_patched := replace(v_patched, 'round(new.balance_due, 1)::text',
        'public.powerhub_format_message_amount(new.tenant_id, new.site_id, new.balance_due)');
      v_patched := replace(v_patched, 'round(sum(i.balance_due), 1)::text',
        'public.powerhub_format_message_amount(new.tenant_id, new.site_id, sum(i.balance_due))');
    elsif v_record.proname = 'powerhub_queue_selected_invoice_sms' then
      v_patched := replace(v_patched, 'round(v_invoice.total_amount, 1)::text',
        'public.powerhub_format_message_amount(v_invoice.tenant_id, v_invoice.site_id, v_invoice.total_amount)');
      v_patched := replace(v_patched, 'round(v_invoice.balance_due, 1)::text',
        'public.powerhub_format_message_amount(v_invoice.tenant_id, v_invoice.site_id, v_invoice.balance_due)');
      v_patched := replace(v_patched, 'round(sum(i.balance_due), 1)::text',
        'public.powerhub_format_message_amount(v_invoice.tenant_id, v_invoice.site_id, sum(i.balance_due))');
    elsif v_record.proname = 'powerhub_approve_and_issue_mobile_reading' then
      v_patched := replace(v_patched, 'round(v_total_amount, 1)::text',
        'public.powerhub_format_message_amount(p_tenant_id, p_site_id, v_total_amount)');
      v_patched := replace(v_patched, 'round(v_total_amount,1)::text',
        'public.powerhub_format_message_amount(p_tenant_id, p_site_id, v_total_amount)');
      v_patched := replace(v_patched, 'round(sum(i.balance_due), 1)::text',
        'public.powerhub_format_message_amount(p_tenant_id, p_site_id, sum(i.balance_due))');
    end if;

    if v_patched = v_definition then
      -- Idempotent reruns are valid when a prior attempt already rewrote this function.
      if position('powerhub_format_message_amount' in v_definition) > 0 then
        continue;
      end if;
      raise exception 'MESSAGE_AMOUNT_POLICY_FORMAT_ANCHOR_NOT_FOUND: %/%', v_record.proname, v_record.pronargs;
    end if;
    execute v_patched;
  end loop;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname='powerhub_queue_invoice_sms_after_issue' and p.pronargs=0
      and position('powerhub_format_message_amount' in pg_get_functiondef(p.oid)) > 0
  ) then raise exception 'INVOICE_TRIGGER_POLICY_FORMAT_VALIDATION_FAILED'; end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname='powerhub_queue_selected_invoice_sms' and p.pronargs=4
      and position('powerhub_format_message_amount' in pg_get_functiondef(p.oid)) > 0
  ) then raise exception 'SELECTED_INVOICE_POLICY_FORMAT_VALIDATION_FAILED'; end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname='powerhub_approve_and_issue_mobile_reading' and p.pronargs=8
      and position('powerhub_format_message_amount' in pg_get_functiondef(p.oid)) > 0
  ) then raise exception 'MOBILE_INVOICE_POLICY_FORMAT_VALIDATION_FAILED'; end if;
end;
$migration$;
