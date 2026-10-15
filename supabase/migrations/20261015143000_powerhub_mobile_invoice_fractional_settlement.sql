-- Keep the mobile/manual-reading approval path on the same policy-aware invoice issuer.
-- Previously this SECURITY DEFINER RPC copied invoice math and bypassed the site billing policy,
-- so automatic tenths discount, carry-forward, and invoice minimums were silently skipped.
-- Replace only the duplicated invoice construction block; preserve approval and messaging behavior.
do $migration$
declare
  v_definition text;
  v_patched text;
  v_start integer;
  v_end integer;
  v_replacement text := $replacement$
select issued.invoice_id, issued.invoice_no, issued.total_amount
into v_invoice_id, v_invoice_no, v_total_amount
from public.powerhub_issue_invoice_from_reading(
  p_tenant_id,
  p_site_id,
  p_user_id,
  p_reading_id,
  v_tariff.id,
  p_billing_period,
  p_due_date,
  p_discount_amount,
  null
) as issued;
$replacement$;
  v_duplicate_invoice_audit text := $audit$
insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data) values(p_tenant_id,p_site_id,p_user_id,v_platform_role,'invoice',v_invoice_id::text,'issue',jsonb_build_object('readingId',p_reading_id,'tariffId',v_tariff.id,'invoiceNo',v_invoice_no,'billingPeriod',p_billing_period,'totalAmount',v_total_amount,'automaticInvoice',true));
$audit$;
begin
  v_definition := pg_get_functiondef(
    'public.powerhub_approve_and_issue_mobile_reading(bigint,bigint,bigint,bigint,integer,timestamptz,text,numeric)'::regprocedure
  );

  if position('from public.powerhub_issue_invoice_from_reading(' in v_definition) > 0 then
    raise notice 'Mobile reading approval already delegates invoice construction to the policy-aware issuer.';
    return;
  end if;

  v_start := position('insert into public.powerhub_invoice_sequences(invoice_year,next_sequence)' in v_definition);
  v_end := position('select platform_role into v_platform_role from public.users where id=p_user_id;' in v_definition);

  if v_start = 0 or v_end = 0 or v_end <= v_start then
    raise exception 'MOBILE_INVOICE_POLICY_PATCH_ANCHOR_NOT_FOUND';
  end if;

  v_patched := overlay(v_definition placing v_replacement from v_start for v_end - v_start);

  if position(v_duplicate_invoice_audit in v_patched) = 0 then
    raise exception 'MOBILE_INVOICE_DUPLICATE_AUDIT_ANCHOR_NOT_FOUND';
  end if;

  -- The central issuer writes the authoritative invoice issuance audit itself.
  v_patched := replace(v_patched, v_duplicate_invoice_audit, '');

  if position('from public.powerhub_issue_invoice_from_reading(' in v_patched) = 0
     or position('insert into public.powerhub_invoice_sequences(invoice_year,next_sequence)' in v_patched) > 0 then
    raise exception 'MOBILE_INVOICE_POLICY_PATCH_VALIDATION_FAILED';
  end if;

  execute v_patched;
end;
$migration$;
