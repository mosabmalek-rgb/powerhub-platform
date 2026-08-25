-- Tenant isolation for direct Supabase access. Vercel server routes may use a server-only
-- service role key, but every authenticated client remains restricted by these policies.

create or replace function public.powerhub_current_user_id()
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select id from public.users where auth_user_id = auth.uid() limit 1;
$$;

create or replace function public.powerhub_has_tenant_access(target_tenant_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.tenant_members membership
    where membership.tenant_id = target_tenant_id
      and membership.user_id = public.powerhub_current_user_id()
      and membership.is_active = true
      and membership.membership_status = 'active'
      and (membership.expires_at is null or membership.expires_at > now())
  );
$$;

create or replace function public.powerhub_is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users
    where id = public.powerhub_current_user_id()
      and platform_role in ('platform_owner', 'platform_admin', 'finance_admin')
      and account_status = 'active'
  );
$$;

create or replace function public.powerhub_create_profile_for_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  insert into public.users (auth_user_id, name, email, login_method)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.email,
    'supabase'
  )
  on conflict (auth_user_id) do update
  set email = excluded.email,
      name = coalesce(excluded.name, public.users.name),
      last_signed_in = now(),
      updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_powerhub on auth.users;
create trigger on_auth_user_created_powerhub
after insert on auth.users
for each row execute function public.powerhub_create_profile_for_auth_user();

create policy users_self_read on public.users
for select to authenticated
using (auth_user_id = auth.uid() or public.powerhub_is_platform_admin());

create policy users_self_update on public.users
for update to authenticated
using (auth_user_id = auth.uid() or public.powerhub_is_platform_admin())
with check (auth_user_id = auth.uid() or public.powerhub_is_platform_admin());

create policy tenants_member_read on public.tenants
for select to authenticated
using (public.powerhub_has_tenant_access(id) or public.powerhub_is_platform_admin());

create policy tenant_members_member_read on public.tenant_members
for select to authenticated
using (public.powerhub_has_tenant_access(tenant_id) or public.powerhub_is_platform_admin());

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'tenant_owner_profiles', 'sites', 'custom_permission_roles', 'staff_profiles',
    'generators', 'subscribers', 'tariffs', 'meter_readings', 'invoices',
    'invoice_lines', 'collector_sessions', 'payments', 'mobile_api_sessions',
    'mobile_sync_events', 'audit_logs', 'tenant_subscriptions', 'tenant_branch_settings',
    'sms_package_requests', 'subscription_upgrade_requests', 'site_portal_settings',
    'access_invitations', 'company_accounts', 'company_account_sites',
    'account_transactions', 'expenses', 'financial_settlements', 'employees',
    'employee_attendance', 'employee_adjustments', 'payroll_runs',
    'offline_sync_operations', 'invoice_share_links', 'tenant_messaging_configurations',
    'tenant_invoice_message_templates', 'tenant_payment_receipt_message_templates',
    'notification_messages', 'messaging_schedule_runs', 'complaints'
  ]
  loop
    execute format(
      'create policy %I on public.%I for all to authenticated using (public.powerhub_has_tenant_access(tenant_id) or public.powerhub_is_platform_admin()) with check (public.powerhub_has_tenant_access(tenant_id) or public.powerhub_is_platform_admin())',
      table_name || '_tenant_isolation', table_name
    );
  end loop;
end;
$$;

create policy payroll_items_tenant_isolation on public.payroll_items
for all to authenticated
using (
  exists (
    select 1 from public.payroll_runs payroll
    where payroll.id = payroll_run_id
      and (public.powerhub_has_tenant_access(payroll.tenant_id) or public.powerhub_is_platform_admin())
  )
)
with check (
  exists (
    select 1 from public.payroll_runs payroll
    where payroll.id = payroll_run_id
      and (public.powerhub_has_tenant_access(payroll.tenant_id) or public.powerhub_is_platform_admin())
  )
);

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'platform_role_policies', 'platform_sms_plans', 'platform_access_invitations',
    'platform_security_events', 'platform_security_settings', 'platform_tariff_policies',
    'platform_settings'
  ]
  loop
    execute format(
      'create policy %I on public.%I for all to authenticated using (public.powerhub_is_platform_admin()) with check (public.powerhub_is_platform_admin())',
      table_name || '_platform_admin_only', table_name
    );
  end loop;
end;
$$;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
