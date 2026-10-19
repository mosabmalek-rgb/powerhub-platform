-- Align actual SMS template rendering with the site's fractional-settlement policy.
-- When either fraction policy is active, hide fractional currency digits without rounding debt upward.
-- Otherwise preserve the one-decimal presentation rule. Stored financial values are never changed.
do $migration$
declare
  v_record record;
  v_definition text;
  v_patched text;
  v_site_expr text;
  v_tenant_expr text;
  v_value_expr text;
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
      v_tenant_expr := 'new.tenant_id';
      v_site_expr := 'new.site_id';
      v_patched := replace(v_patched, 'round(new.total_amount, 1)::text',
        'case when exists (select 1 from public.site_billing_policies as policy where policy.tenant_id = new.tenant_id and policy.site_id = new.site_id and (policy.automatic_fraction_discount_enabled or policy.fraction_carry_enabled)) then trunc(new.total_amount)::text else round(new.total_amount, 1)::text end');
      v_patched := replace(v_patched, 'round(new.balance_due, 1)::text',
        'case when exists (select 1 from public.site_billing_policies as policy where policy.tenant_id = new.tenant_id and policy.site_id = new.site_id and (policy.automatic_fraction_discount_enabled or policy.fraction_carry_enabled)) then trunc(new.balance_due)::text else round(new.balance_due, 1)::text end');
      v_patched := replace(v_patched, 'round(sum(i.balance_due), 1)::text',
        'case when exists (select 1 from public.site_billing_policies as policy where policy.tenant_id = new.tenant_id and policy.site_id = new.site_id and (policy.automatic_fraction_discount_enabled or policy.fraction_carry_enabled)) then trunc(sum(i.balance_due))::text else round(sum(i.balance_due), 1)::text end');
      v_patched := replace(v_patched, '),''0.0'')',
        '),case when exists (select 1 from public.site_billing_policies as policy where policy.tenant_id = new.tenant_id and policy.site_id = new.site_id and (policy.automatic_fraction_discount_enabled or policy.fraction_carry_enabled)) then ''0'' else ''0.0'' end)');
    elsif v_record.proname = 'powerhub_queue_selected_invoice_sms' then
      v_tenant_expr := 'v_invoice.tenant_id';
      v_site_expr := 'v_invoice.site_id';
      v_patched := replace(v_patched, 'round(v_invoice.total_amount, 1)::text',
        'case when exists (select 1 from public.site_billing_policies as policy where policy.tenant_id = v_invoice.tenant_id and policy.site_id = v_invoice.site_id and (policy.automatic_fraction_discount_enabled or policy.fraction_carry_enabled)) then trunc(v_invoice.total_amount)::text else round(v_invoice.total_amount, 1)::text end');
      v_patched := replace(v_patched, 'round(v_invoice.balance_due, 1)::text',
        'case when exists (select 1 from public.site_billing_policies as policy where policy.tenant_id = v_invoice.tenant_id and policy.site_id = v_invoice.site_id and (policy.automatic_fraction_discount_enabled or policy.fraction_carry_enabled)) then trunc(v_invoice.balance_due)::text else round(v_invoice.balance_due, 1)::text end');
      v_patched := replace(v_patched, 'round(sum(i.balance_due), 1)::text',
        'case when exists (select 1 from public.site_billing_policies as policy where policy.tenant_id = v_invoice.tenant_id and policy.site_id = v_invoice.site_id and (policy.automatic_fraction_discount_enabled or policy.fraction_carry_enabled)) then trunc(sum(i.balance_due))::text else round(sum(i.balance_due), 1)::text end');
      v_patched := replace(v_patched, '),''0.0'')',
        '),case when exists (select 1 from public.site_billing_policies as policy where policy.tenant_id = v_invoice.tenant_id and policy.site_id = v_invoice.site_id and (policy.automatic_fraction_discount_enabled or policy.fraction_carry_enabled)) then ''0'' else ''0.0'' end)');
    else
      v_tenant_expr := 'p_tenant_id';
      v_site_expr := 'p_site_id';
      v_patched := replace(v_patched, 'round(v_total_amount, 1)::text',
        'case when exists (select 1 from public.site_billing_policies as policy where policy.tenant_id = p_tenant_id and policy.site_id = p_site_id and (policy.automatic_fraction_discount_enabled or policy.fraction_carry_enabled)) then trunc(v_total_amount)::text else round(v_total_amount, 1)::text end');
      v_patched := replace(v_patched, 'round(sum(i.balance_due), 1)::text',
        'case when exists (select 1 from public.site_billing_policies as policy where policy.tenant_id = p_tenant_id and policy.site_id = p_site_id and (policy.automatic_fraction_discount_enabled or policy.fraction_carry_enabled)) then trunc(sum(i.balance_due))::text else round(sum(i.balance_due), 1)::text end');
      v_patched := replace(v_patched, '),''0.0'')',
        '),case when exists (select 1 from public.site_billing_policies as policy where policy.tenant_id = p_tenant_id and policy.site_id = p_site_id and (policy.automatic_fraction_discount_enabled or policy.fraction_carry_enabled)) then ''0'' else ''0.0'' end)');
    end if;

    if v_patched <> v_definition then
      execute v_patched;
    end if;
  end loop;
end;
$migration$;

-- Fail the migration rather than silently retaining stale three-decimal or fixed one-decimal rendering.
do $validation$
declare
  v_definition text;
  v_name text;
  v_args integer;
begin
  for v_name, v_args in
    select * from (values
      ('powerhub_queue_invoice_sms_after_issue', 0),
      ('powerhub_queue_selected_invoice_sms', 4),
      ('powerhub_approve_and_issue_mobile_reading', 8)
    ) as expected(name, args)
  loop
    select pg_get_functiondef(p.oid) into v_definition
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_name and p.pronargs = v_args;
    if v_definition is null
       or position('automatic_fraction_discount_enabled' in v_definition) = 0
       or position('fraction_carry_enabled' in v_definition) = 0
       or position('trunc(' in v_definition) = 0 then
      raise exception 'POLICY_AWARE_SMS_AMOUNT_VALIDATION_FAILED for %', v_name;
    end if;
  end loop;
end;
$validation$;
