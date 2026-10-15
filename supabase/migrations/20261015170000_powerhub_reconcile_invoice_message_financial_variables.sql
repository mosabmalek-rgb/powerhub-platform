-- Reconcile SQL-owned invoice message rendering with the shared one-decimal display rule.
-- This is intentionally idempotent: production may already have the earlier formatter
-- and total-balance migrations, while staging can have older function definitions.
-- Persisted invoice amounts, balances, settlement ledgers, and calculations are unchanged.
do $migration$
declare
  v_record record;
  v_definition text;
  v_patched text;
  v_target text;
  v_replacement text;
  v_anchor_pos integer;
  v_anchor_end integer;
  v_trigger_found boolean := false;
  v_selected_found boolean := false;
  v_mobile_found boolean := false;
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

    -- Presentation-only rounding; never write these formatted values back to invoices.
    v_patched := replace(v_patched, 'new.total_amount::text', 'round(new.total_amount, 1)::text');
    v_patched := replace(v_patched, 'new.balance_due::text', 'round(new.balance_due, 1)::text');
    v_patched := replace(v_patched, 'v_invoice.total_amount::text', 'round(v_invoice.total_amount, 1)::text');
    v_patched := replace(v_patched, 'v_invoice.balance_due::text', 'round(v_invoice.balance_due, 1)::text');
    v_patched := replace(v_patched, 'v_total_amount::text', 'round(v_total_amount, 1)::text');
    v_patched := replace(v_patched, 'sum(i.balance_due)::text', 'round(sum(i.balance_due), 1)::text');

    if v_record.proname = 'powerhub_queue_invoice_sms_after_issue' then
      v_trigger_found := true;
      if position('{{total_balance}}' in v_patched) = 0 then
        v_target := $target$v_rendered_text := replace(v_rendered_text,'{{balance_due}}',round(new.balance_due, 1)::text);$target$;
        v_replacement := $replacement$v_rendered_text := replace(v_rendered_text,'{{balance_due}}',round(new.balance_due, 1)::text);
  v_rendered_text := replace(v_rendered_text,'{{total_balance}}',coalesce((select round(sum(i.balance_due), 1)::text from public.invoices i where i.tenant_id=new.tenant_id and i.site_id=new.site_id and i.subscriber_id=new.subscriber_id and i.status in ('issued','partially_paid','overdue') and i.balance_due>0),'0.0'));$replacement$;
        v_patched := replace(v_patched, v_target, v_replacement);
        if v_patched = v_definition then
          raise exception 'INVOICE_SMS_TRIGGER_TOTAL_BALANCE_ANCHOR_NOT_FOUND';
        end if;
      end if;

    elsif v_record.proname = 'powerhub_queue_selected_invoice_sms' then
      v_selected_found := true;
      if position('{{total_balance}}' in v_patched) = 0 then
        v_target := $target$v_rendered_text:=replace(v_rendered_text,'{{balance_due}}',round(v_invoice.balance_due, 1)::text);$target$;
        v_replacement := $replacement$v_rendered_text:=replace(v_rendered_text,'{{balance_due}}',round(v_invoice.balance_due, 1)::text);
    v_rendered_text:=replace(v_rendered_text,'{{total_balance}}',coalesce((select round(sum(i.balance_due), 1)::text from public.invoices i where i.tenant_id=v_invoice.tenant_id and i.site_id=v_invoice.site_id and i.subscriber_id=v_invoice.subscriber_id and i.status in ('issued','partially_paid','overdue') and i.balance_due>0),'0.0'));$replacement$;
        v_patched := replace(v_patched, v_target, v_replacement);
        if v_patched = v_definition then
          raise exception 'SELECTED_INVOICE_SMS_TOTAL_BALANCE_ANCHOR_NOT_FOUND';
        end if;
      end if;

    elsif v_record.proname = 'powerhub_approve_and_issue_mobile_reading' then
      v_mobile_found := true;
      if position('{{total_balance}}' in v_patched) = 0 then
        -- Locate the reading-consumption substitution semantically. pg_get_functiondef
        -- can normalize whitespace, so matching the whole original line is too brittle.
        v_anchor_pos := strpos(v_patched, 'v_reading.consumption_kwh::text');
        if v_anchor_pos = 0 then
          raise exception 'MOBILE_READING_TOTAL_BALANCE_ANCHOR_NOT_FOUND';
        end if;
        v_anchor_end := strpos(substring(v_patched from v_anchor_pos), ';');
        if v_anchor_end = 0 then
          raise exception 'MOBILE_READING_TOTAL_BALANCE_STATEMENT_END_NOT_FOUND';
        end if;
        v_anchor_end := v_anchor_pos + v_anchor_end - 1;
        v_patched := overlay(
          v_patched placing E'\n    v_rendered := replace(v_rendered, ''{{total_balance}}'', coalesce((select round(sum(i.balance_due), 1)::text from public.invoices i where i.tenant_id=p_tenant_id and i.site_id=p_site_id and i.subscriber_id=v_subscriber.id and i.status in (''issued'',''partially_paid'',''overdue'') and i.balance_due>0), ''0.0''));\n'
          from v_anchor_end + 1 for 0
        );
      end if;
    end if;

    if v_patched <> v_definition then
      execute v_patched;
    end if;
  end loop;

  if not v_trigger_found or not v_selected_found or not v_mobile_found then
    raise exception 'INVOICE_MESSAGE_FINANCIAL_FUNCTIONS_NOT_FOUND';
  end if;

  -- The manual-message variable allow-list must accept the supported total-balance token.
  select pg_get_functiondef(p.oid)
    into v_definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'powerhub_prepare_manual_message_campaign'
    and p.pronargs = 6;

  if v_definition is null then
    raise exception 'POWERHUB_MANUAL_CAMPAIGN_FUNCTION_NOT_FOUND';
  end if;

  if position('total_balance' in v_definition) = 0 then
    v_target := $target$previous_reading|current_reading|consumption_kwh|due_date$target$;
    v_replacement := $replacement$previous_reading|current_reading|consumption_kwh|total_balance|due_date$replacement$;
    v_patched := replace(v_definition, v_target, v_replacement);
    if v_patched = v_definition then
      raise exception 'MANUAL_CAMPAIGN_TOTAL_BALANCE_GUARD_ANCHOR_NOT_FOUND';
    end if;
    execute v_patched;
  end if;

  -- Fail the migration instead of silently leaving a path with raw numeric display values.
  select pg_get_functiondef(p.oid) into v_definition
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'powerhub_queue_invoice_sms_after_issue' and p.pronargs = 0;
  if position('round(new.total_amount, 1)::text' in v_definition) = 0
     or position('round(new.balance_due, 1)::text' in v_definition) = 0
     or position('{{total_balance}}' in v_definition) = 0
     or position('round(sum(i.balance_due), 1)::text' in v_definition) = 0 then
    raise exception 'INVOICE_SMS_TRIGGER_FINANCIAL_FORMAT_VALIDATION_FAILED';
  end if;

  select pg_get_functiondef(p.oid) into v_definition
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'powerhub_queue_selected_invoice_sms' and p.pronargs = 4;
  if position('round(v_invoice.total_amount, 1)::text' in v_definition) = 0
     or position('round(v_invoice.balance_due, 1)::text' in v_definition) = 0
     or position('{{total_balance}}' in v_definition) = 0
     or position('round(sum(i.balance_due), 1)::text' in v_definition) = 0 then
    raise exception 'SELECTED_INVOICE_SMS_FINANCIAL_FORMAT_VALIDATION_FAILED';
  end if;

  select pg_get_functiondef(p.oid) into v_definition
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'powerhub_approve_and_issue_mobile_reading' and p.pronargs = 8;
  if position('round(v_total_amount, 1)::text' in v_definition) = 0
     or position('{{total_balance}}' in v_definition) = 0
     or position('round(sum(i.balance_due), 1)::text' in v_definition) = 0 then
    raise exception 'MOBILE_INVOICE_SMS_FINANCIAL_FORMAT_VALIDATION_FAILED';
  end if;

  select pg_get_functiondef(p.oid) into v_definition
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'powerhub_prepare_manual_message_campaign' and p.pronargs = 6;
  if position('previous_reading|current_reading|consumption_kwh|total_balance|due_date' in v_definition) = 0 then
    raise exception 'MANUAL_CAMPAIGN_TOTAL_BALANCE_GUARD_VALIDATION_FAILED';
  end if;
end;
$migration$;
