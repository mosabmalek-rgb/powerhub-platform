-- Reject invoice-reading tokens in generic manual campaigns, which have no invoice/reading context.
-- This prevents newly supported invoice variables from being queued as literal placeholders by manual subscriber broadcasts.
do $migration$
declare
  v_definition text;
  v_patched text;
  v_target text := $target$if v_rendered ~ '{{\\s*(invoice_no|billing_period|total_amount|balance_due|due_date|invoice_link)\\s*}}' then$target$;
  v_replacement text := $replacement$if v_rendered ~ '{{\s*(invoice_no|billing_period|total_amount|balance_due|previous_reading|current_reading|consumption_kwh|due_date|invoice_link)\s*}}' then$replacement$;
begin
  select pg_get_functiondef(p.oid) into v_definition
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
    and p.proname='powerhub_prepare_manual_message_campaign'
    and p.pronargs=6;

  if v_definition is null then
    raise exception 'POWERHUB_MANUAL_CAMPAIGN_FUNCTION_NOT_FOUND';
  end if;

  if position('previous_reading|current_reading|consumption_kwh' in v_definition)>0 then
    return;
  end if;

  v_patched := replace(v_definition, v_target, v_replacement);
  if v_patched = v_definition then
    raise exception 'MANUAL_CAMPAIGN_TEMPLATE_CONTEXT_GUARD_NOT_FOUND';
  end if;

  execute v_patched;
end;
$migration$;
