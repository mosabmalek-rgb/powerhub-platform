-- Preserve the reading-approval audit in the mobile invoice path.
-- The policy-aware invoice issuer writes the invoice-issue audit itself.
-- Avoid relying on a notification-specific text anchor: staging may have an older
-- notification implementation while sharing the same audit semantics.
do $migration$
declare
  v_definition text;
  v_patched text;
  v_actor_anchor text := 'select platform_role into v_platform_role from public.users where id=p_user_id;';
  v_actor_pos integer;
  v_region_start integer;
  v_audit_relative_pos integer;
  v_audit_pos integer;
  v_audit_end integer;
  v_audit_statement text;
  v_approval_audit text := $replacement$
insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data)
values(p_tenant_id,p_site_id,p_user_id,v_platform_role,'meter_reading',p_reading_id::text,'approve',jsonb_build_object('status','approved','versionNo',v_version));
$replacement$;
begin
  v_definition := pg_get_functiondef(
    'public.powerhub_approve_and_issue_mobile_reading(bigint,bigint,bigint,bigint,integer,timestamptz,text,numeric)'::regprocedure
  );

  if position('from public.powerhub_issue_invoice_from_reading(' in v_definition) = 0 then
    raise exception 'MOBILE_APPROVAL_AUDIT_REQUIRES_POLICY_ISSUER';
  end if;

  v_actor_pos := position(v_actor_anchor in v_definition);
  if v_actor_pos = 0 then
    raise exception 'MOBILE_APPROVAL_AUDIT_ACTOR_ANCHOR_NOT_FOUND';
  end if;
  v_region_start := v_actor_pos + length(v_actor_anchor);

  v_audit_relative_pos := position(
    'insert into public.audit_logs'
    in substring(v_definition from v_region_start)
  );

  if v_audit_relative_pos = 0 then
    v_patched := overlay(v_definition placing E'\n  ' || v_approval_audit || E'\n'
      from v_region_start for 0);
  else
    v_audit_pos := v_region_start + v_audit_relative_pos - 1;
    v_audit_end := v_audit_pos
      + position(';' in substring(v_definition from v_audit_pos)) - 1;
    if v_audit_end < v_audit_pos then
      raise exception 'MOBILE_APPROVAL_AUDIT_STATEMENT_END_NOT_FOUND';
    end if;

    v_audit_statement := substring(v_definition from v_audit_pos for v_audit_end - v_audit_pos + 1);
    if position('''meter_reading''' in v_audit_statement) > 0
       and position('''approve''' in v_audit_statement) > 0 then
      raise notice 'Mobile reading approval audit is already correct.';
      return;
    elsif position('''invoice''' in v_audit_statement) > 0
       and position('''issue''' in v_audit_statement) > 0 then
      v_patched := overlay(v_definition placing v_approval_audit
        from v_audit_pos for v_audit_end - v_audit_pos + 1);
    else
      raise exception 'MOBILE_APPROVAL_AUDIT_UNEXPECTED_STATEMENT';
    end if;
  end if;

  v_actor_pos := position(v_actor_anchor in v_patched);
  v_region_start := v_actor_pos + length(v_actor_anchor);
  if position('''meter_reading''' in substring(v_patched from v_region_start))
       = 0
     or position('''approve''' in substring(v_patched from v_region_start)) = 0 then
    raise exception 'MOBILE_APPROVAL_AUDIT_VALIDATION_FAILED';
  end if;

  execute v_patched;
end;
$migration$;
