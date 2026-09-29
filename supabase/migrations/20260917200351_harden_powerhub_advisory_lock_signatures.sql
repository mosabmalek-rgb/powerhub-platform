do $$
declare
  r record;
  v_def text;
  v_new text;
begin
  for r in
    select p.oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname like 'powerhub_%'
  loop
    v_def := pg_get_functiondef(r.oid);
    v_new := v_def;
    v_new := replace(v_new,'pg_advisory_xact_lock(p_tenant_id,hashtext(''tenant-owner-transfer''))','pg_advisory_xact_lock(hashtext(''tenant-owner-transfer:'' || p_tenant_id::text)::bigint)');
    v_new := replace(v_new,'pg_advisory_xact_lock(p_site_id,hashtext(''payroll-approve:'' || p_payroll_run_id::text))','pg_advisory_xact_lock(hashtext(''payroll-approve:'' || p_site_id::text || '':'' || p_payroll_run_id::text)::bigint)');
    v_new := replace(v_new,'pg_advisory_xact_lock(p_tenant_id, hashtext(''staff-assignment''))','pg_advisory_xact_lock(hashtext(''staff-assignment:'' || p_tenant_id::text)::bigint)');
    v_new := replace(v_new,'pg_advisory_xact_lock(p_tenant_id,hashtext(''staff-assignment''))','pg_advisory_xact_lock(hashtext(''staff-assignment:'' || p_tenant_id::text)::bigint)');
    v_new := replace(v_new,'pg_advisory_xact_lock(p_tenant_id,hashtext(''employee-create''))','pg_advisory_xact_lock(hashtext(''employee-create:'' || p_tenant_id::text)::bigint)');
    v_new := replace(v_new,'pg_advisory_xact_lock(p_tenant_id,hashtext(''employee-adjustment-create''))','pg_advisory_xact_lock(hashtext(''employee-adjustment-create:'' || p_tenant_id::text)::bigint)');
    v_new := replace(v_new,'pg_advisory_xact_lock(p_site_id, hashtext(''payroll-draft:'' || p_period))','pg_advisory_xact_lock(hashtext(''payroll-draft:'' || p_site_id::text || '':'' || p_period)::bigint)');
    v_new := replace(v_new,'pg_advisory_xact_lock(p_tenant_id, v_item.employee_id::integer)','pg_advisory_xact_lock(hashtext(''payroll-item:'' || p_tenant_id::text || '':'' || v_item.employee_id::text)::bigint)');
    v_new := replace(v_new,'pg_advisory_xact_lock(p_tenant_id,hashtext(''branch-policy''))','pg_advisory_xact_lock(hashtext(''branch-policy:'' || p_tenant_id::text)::bigint)');
    v_new := replace(v_new,'pg_advisory_xact_lock(p_tenant_id,hashtext(''custom-permission-role''))','pg_advisory_xact_lock(hashtext(''custom-permission-role:'' || p_tenant_id::text)::bigint)');
    v_new := replace(v_new,'pg_advisory_xact_lock(p_site_id, p_user_id::integer)','pg_advisory_xact_lock(hashtext(''collector-session:'' || p_site_id::text || '':'' || p_user_id::text)::bigint)');
    v_new := replace(v_new,'pg_advisory_xact_lock(p_site_id, hashtext(''payroll-pay:'' || p_payroll_run_id::text))','pg_advisory_xact_lock(hashtext(''payroll-pay:'' || p_site_id::text || '':'' || p_payroll_run_id::text)::bigint)');
    v_new := replace(v_new,'pg_advisory_xact_lock(p_tenant_id, hashtext(''subscription-upgrade''))','pg_advisory_xact_lock(hashtext(''subscription-upgrade:'' || p_tenant_id::text)::bigint)');
    v_new := replace(v_new,'pg_advisory_xact_lock(p_tenant_id,hashtext(''subscription-upgrade''))','pg_advisory_xact_lock(hashtext(''subscription-upgrade:'' || p_tenant_id::text)::bigint)');
    v_new := replace(v_new,'pg_advisory_xact_lock(p_tenant_id,hashtext(''employee-update''))','pg_advisory_xact_lock(hashtext(''employee-update:'' || p_tenant_id::text)::bigint)');
    v_new := replace(v_new,'pg_advisory_xact_lock(p_tenant_id,hashtext(''staff-profile-permissions''))','pg_advisory_xact_lock(hashtext(''staff-profile-permissions:'' || p_tenant_id::text)::bigint)');
    v_new := replace(v_new,'pg_advisory_xact_lock(p_tenant_id,hashtext(''staff-profile-status''))','pg_advisory_xact_lock(hashtext(''staff-profile-status:'' || p_tenant_id::text)::bigint)');
    v_new := replace(v_new,'pg_advisory_xact_lock(p_tenant_id, hashtext(''attendance:'' || p_employee_id::text || '':'' || p_work_date::text))','pg_advisory_xact_lock(hashtext(''attendance:'' || p_tenant_id::text || '':'' || p_employee_id::text || '':'' || p_work_date::text)::bigint)');
    v_new := replace(v_new,'pg_advisory_xact_lock(p_tenant_id,p_invoice_id)','pg_advisory_xact_lock(hashtext(''invoice-share:'' || p_tenant_id::text || '':'' || p_invoice_id::text)::bigint)');
    v_new := replace(v_new,'pg_advisory_xact_lock(p_tenant_id,p_site_id)','pg_advisory_xact_lock(hashtext(''tenant-site:'' || p_tenant_id::text || '':'' || p_site_id::text)::bigint)');
    v_new := replace(v_new,'pg_advisory_xact_lock(p_tenant_id, p_site_id)','pg_advisory_xact_lock(hashtext(''tenant-site:'' || p_tenant_id::text || '':'' || p_site_id::text)::bigint)');
    v_new := replace(v_new,'pg_advisory_xact_lock(least(p_from_account_id, p_to_account_id))','pg_advisory_xact_lock(hashtext(''company-transfer:'' || least(p_from_account_id,p_to_account_id)::text || '':'' || greatest(p_from_account_id,p_to_account_id)::text)::bigint)');
    v_new := replace(v_new,'pg_advisory_xact_lock(greatest(p_from_account_id, p_to_account_id))','pg_advisory_xact_lock(hashtext(''company-transfer:'' || least(p_from_account_id,p_to_account_id)::text || '':'' || greatest(p_from_account_id,p_to_account_id)::text)::bigint)');
    if v_new <> v_def then execute v_new; end if;
  end loop;
end $$;
select pg_notify('pgrst','reload schema');
