-- Add meter reading tokens to every live invoice-message creation path.
-- Preserve the deployed bodies, signatures, security modes, and grants by patching only rendering anchors.
do $migration$
declare
  v_record record;
  v_definition text;
  v_patched text;
  v_trigger_patched boolean := false;
  v_selected_patched boolean := false;
  v_mobile_patched boolean := false;
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
      v_target := $target$v_rendered_text := replace(v_rendered_text,'{{balance_due}}',new.balance_due::text);$target$;
      v_replacement := $replacement$v_rendered_text := replace(v_rendered_text,'{{balance_due}}',new.balance_due::text);
  v_rendered_text := replace(v_rendered_text,'{{previous_reading}}',coalesce(new.previous_reading::text,''));
  v_rendered_text := replace(v_rendered_text,'{{current_reading}}',coalesce(new.current_reading::text,''));
  v_rendered_text := replace(v_rendered_text,'{{consumption_kwh}}',coalesce(new.consumption_kwh::text,''));$replacement$;
      v_patched := replace(v_patched, v_target, v_replacement);
      if v_patched = v_definition then
        raise exception 'INVOICE_SMS_TRIGGER_READING_TOKEN_ANCHOR_NOT_FOUND';
      end if;
      v_trigger_patched := true;

    elsif v_record.proname = 'powerhub_queue_selected_invoice_sms' then
      v_target := $target$v_rendered_text:=replace(v_rendered_text,'{{balance_due}}',v_invoice.balance_due::text);$target$;
      v_replacement := $replacement$v_rendered_text:=replace(v_rendered_text,'{{balance_due}}',v_invoice.balance_due::text);
    v_rendered_text:=replace(v_rendered_text,'{{previous_reading}}',coalesce(v_invoice.previous_reading::text,''));
    v_rendered_text:=replace(v_rendered_text,'{{current_reading}}',coalesce(v_invoice.current_reading::text,''));
    v_rendered_text:=replace(v_rendered_text,'{{consumption_kwh}}',coalesce(v_invoice.consumption_kwh::text,''));$replacement$;
      v_patched := replace(v_patched, v_target, v_replacement);
      if v_patched = v_definition then
        raise exception 'SELECTED_INVOICE_SMS_READING_TOKEN_ANCHOR_NOT_FOUND';
      end if;
      v_selected_patched := true;

    elsif v_record.proname = 'powerhub_approve_and_issue_mobile_reading' then
      v_target := $target$),'{{due_date}}',to_char(p_due_date at time zone 'Asia/Gaza','DD/MM/YYYY'));$target$;
      v_replacement := $replacement$),'{{due_date}}',to_char(p_due_date at time zone 'Asia/Gaza','DD/MM/YYYY'));
v_rendered:=replace(v_rendered,'{{previous_reading}}',coalesce(v_reading.previous_reading_value::text,''));
v_rendered:=replace(v_rendered,'{{current_reading}}',coalesce(v_reading.reading_value::text,''));
v_rendered:=replace(v_rendered,'{{consumption_kwh}}',coalesce(v_reading.consumption_kwh::text,''));$replacement$;
      v_patched := replace(v_patched, v_target, v_replacement);
      if v_patched = v_definition then
        raise exception 'MOBILE_READING_INVOICE_TEMPLATE_ANCHOR_NOT_FOUND';
      end if;
      v_mobile_patched := true;
    end if;

    execute v_patched;
  end loop;

  if not v_trigger_patched or not v_selected_patched or not v_mobile_patched then
    raise exception 'INVOICE_READING_TEMPLATE_FUNCTIONS_NOT_FOUND';
  end if;
end;
$migration$;
