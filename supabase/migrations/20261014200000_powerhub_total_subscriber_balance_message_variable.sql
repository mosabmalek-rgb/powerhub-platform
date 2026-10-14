-- Add a tenant/site/subscriber-scoped total outstanding balance token to invoice-context messages.
-- Only issued, partially-paid, and overdue invoices with a positive balance contribute.
-- This deliberately excludes drafts, cancelled invoices, and fully paid invoices.
do $migration$
declare
  v_record record;
  v_definition text;
  v_patched text;
  v_trigger_patched boolean := false;
  v_selected_patched boolean := false;
  v_mobile_patched boolean := false;
  v_guard_patched boolean := false;
  v_target text;
  v_replacement text;
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
      if position('{{total_balance}}' in v_definition) > 0 then
        v_trigger_patched := true;
        continue;
      end if;
      v_target := $target$v_rendered_text := replace(v_rendered_text,'{{balance_due}}',new.balance_due::text);$target$;
      v_replacement := $replacement$v_rendered_text := replace(v_rendered_text,'{{balance_due}}',new.balance_due::text);
  v_rendered_text := replace(v_rendered_text,'{{total_balance}}',coalesce((select sum(i.balance_due)::text from public.invoices i where i.tenant_id=new.tenant_id and i.site_id=new.site_id and i.subscriber_id=new.subscriber_id and i.status in ('issued','partially_paid','overdue') and i.balance_due>0),'0'));$replacement$;
      v_patched := replace(v_patched, v_target, v_replacement);
      if v_patched = v_definition then raise exception 'INVOICE_SMS_TRIGGER_TOTAL_BALANCE_ANCHOR_NOT_FOUND'; end if;
      v_trigger_patched := true;

    elsif v_record.proname = 'powerhub_queue_selected_invoice_sms' then
      if position('{{total_balance}}' in v_definition) > 0 then
        v_selected_patched := true;
        continue;
      end if;
      v_target := $target$v_rendered_text:=replace(v_rendered_text,'{{balance_due}}',v_invoice.balance_due::text);$target$;
      v_replacement := $replacement$v_rendered_text:=replace(v_rendered_text,'{{balance_due}}',v_invoice.balance_due::text);
    v_rendered_text:=replace(v_rendered_text,'{{total_balance}}',coalesce((select sum(i.balance_due)::text from public.invoices i where i.tenant_id=v_invoice.tenant_id and i.site_id=v_invoice.site_id and i.subscriber_id=v_invoice.subscriber_id and i.status in ('issued','partially_paid','overdue') and i.balance_due>0),'0'));$replacement$;
      v_patched := replace(v_patched, v_target, v_replacement);
      if v_patched = v_definition then raise exception 'SELECTED_INVOICE_SMS_TOTAL_BALANCE_ANCHOR_NOT_FOUND'; end if;
      v_selected_patched := true;

    elsif v_record.proname = 'powerhub_approve_and_issue_mobile_reading' then
      if position('{{total_balance}}' in v_definition) > 0 then
        v_mobile_patched := true;
        continue;
      end if;
      v_target := $target$v_rendered:=replace(v_rendered,'{{consumption_kwh}}',coalesce(v_reading.consumption_kwh::text,''));$target$;
      v_replacement := $replacement$v_rendered:=replace(v_rendered,'{{consumption_kwh}}',coalesce(v_reading.consumption_kwh::text,''));
v_rendered:=replace(v_rendered,'{{total_balance}}',coalesce((select sum(i.balance_due)::text from public.invoices i where i.tenant_id=p_tenant_id and i.site_id=p_site_id and i.subscriber_id=v_subscriber.id and i.status in ('issued','partially_paid','overdue') and i.balance_due>0),'0'));$replacement$;
      v_patched := replace(v_patched, v_target, v_replacement);
      if v_patched = v_definition then raise exception 'MOBILE_READING_TOTAL_BALANCE_ANCHOR_NOT_FOUND'; end if;
      v_mobile_patched := true;
    end if;

    execute v_patched;
  end loop;

  if not v_trigger_patched or not v_selected_patched or not v_mobile_patched then
    raise exception 'INVOICE_TOTAL_BALANCE_TEMPLATE_FUNCTIONS_NOT_FOUND';
  end if;

  select pg_get_functiondef(p.oid) into v_definition
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='powerhub_prepare_manual_message_campaign' and p.pronargs=6;
  if v_definition is null then raise exception 'POWERHUB_MANUAL_CAMPAIGN_FUNCTION_NOT_FOUND'; end if;

  if position('total_balance' in v_definition) = 0 then
    v_target := $target$previous_reading|current_reading|consumption_kwh|due_date$target$;
    v_replacement := $replacement$previous_reading|current_reading|consumption_kwh|total_balance|due_date$replacement$;
    v_patched := replace(v_definition, v_target, v_replacement);
    if v_patched = v_definition then raise exception 'MANUAL_CAMPAIGN_TOTAL_BALANCE_GUARD_ANCHOR_NOT_FOUND'; end if;
    execute v_patched;
  end if;
end;
$migration$;
