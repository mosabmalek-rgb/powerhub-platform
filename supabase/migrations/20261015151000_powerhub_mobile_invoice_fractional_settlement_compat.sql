-- Make the mobile invoice policy cutover safe for both production and older staging function bodies.
-- Production may already use the central issuer; older staging copies the calculation inline.
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
  p_tenant_id,p_site_id,p_user_id,p_reading_id,v_tariff.id,
  p_billing_period,p_due_date,p_discount_amount,null
) as issued;
$replacement$;
  v_audit_start integer;
  v_audit_end integer;
begin
  v_definition := pg_get_functiondef(
    'public.powerhub_approve_and_issue_mobile_reading(bigint,bigint,bigint,bigint,integer,timestamptz,text,numeric)'::regprocedure
  );
  if position('from public.powerhub_issue_invoice_from_reading(' in v_definition)>0 then
    raise notice 'Mobile reading approval already delegates to the policy-aware invoice issuer.';
    return;
  end if;

  v_start := position('insert into public.powerhub_invoice_sequences(invoice_year,next_sequence)' in v_definition);
  if v_start=0 then
    v_start := position('v_energy_amount:=round' in v_definition);
  end if;
  v_end := position('select platform_role into v_platform_role from public.users where id=p_user_id;' in v_definition);
  if v_start=0 or v_end=0 or v_end<=v_start then
    raise exception 'MOBILE_INVOICE_POLICY_COMPAT_ANCHOR_NOT_FOUND';
  end if;

  v_patched := overlay(v_definition placing v_replacement from v_start for v_end-v_start);
  v_end := position('select platform_role into v_platform_role from public.users where id=p_user_id;' in v_patched);
  if v_end=0 then raise exception 'MOBILE_INVOICE_POLICY_COMPAT_AUDIT_ANCHOR_NOT_FOUND'; end if;
  v_audit_start := v_end + position('insert into public.audit_logs' in substring(v_patched from v_end))-1;
  if v_audit_start<v_end then raise exception 'MOBILE_INVOICE_POLICY_COMPAT_AUDIT_NOT_FOUND'; end if;
  v_audit_end := v_audit_start + position(';' in substring(v_patched from v_audit_start))-1;
  if v_audit_end<=v_audit_start then raise exception 'MOBILE_INVOICE_POLICY_COMPAT_AUDIT_END_NOT_FOUND'; end if;
  v_patched := overlay(v_patched placing '' from v_audit_start for v_audit_end-v_audit_start+1);

  if position('from public.powerhub_issue_invoice_from_reading(' in v_patched)=0
     or position('insert into public.invoices' in substring(v_patched from v_start))>0 then
    raise exception 'MOBILE_INVOICE_POLICY_COMPAT_VALIDATION_FAILED';
  end if;
  execute v_patched;
end;
$migration$;