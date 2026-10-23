-- Align staging membership-based RLS scope with the canonical production guard.
-- Active membership flags do not override an explicit membership expiry timestamp.

create or replace function powerhub_private.current_tenant_ids()
returns bigint[]
language sql
stable
security definer
set search_path = public, powerhub_private
as $$
  select coalesce(array_agg(tm.tenant_id), '{}'::bigint[])
  from public.tenant_members tm
  where tm.user_id = powerhub_private.current_user_id()
    and tm.is_active = true
    and tm.membership_status = 'active'
    and (tm.expires_at is null or tm.expires_at > now());
$$;

create or replace function powerhub_private.has_tenant_access(target_tenant_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public, powerhub_private
as $$
  select exists (
    select 1
    from public.tenant_members tm
    where tm.tenant_id = target_tenant_id
      and tm.user_id = powerhub_private.current_user_id()
      and tm.is_active = true
      and tm.membership_status = 'active'
      and (tm.expires_at is null or tm.expires_at > now())
  );
$$;

create or replace function powerhub_private.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public, powerhub_private
as $$
  select exists (
    select 1
    from public.users u
    where u.id = powerhub_private.current_user_id()
      and u.platform_role in ('platform_owner', 'platform_admin', 'finance_admin')
      and u.account_status = 'active'
  );
$$;

revoke all on function powerhub_private.has_tenant_access(bigint) from public, anon;
grant usage on schema powerhub_private to authenticated;
grant execute on function powerhub_private.has_tenant_access(bigint) to authenticated;
revoke all on function powerhub_private.is_platform_admin() from public, anon;
grant execute on function powerhub_private.is_platform_admin() to authenticated;

drop policy if exists account_transaction_tenant_access on public.account_transactions;
drop policy if exists account_transactions_tenant_isolation on public.account_transactions;
create policy account_transactions_tenant_isolation on public.account_transactions
for all to authenticated
using (powerhub_private.has_tenant_access(tenant_id) or powerhub_private.is_platform_admin())
with check (powerhub_private.has_tenant_access(tenant_id) or powerhub_private.is_platform_admin());

drop policy if exists audit_tenant_access on public.audit_logs;
drop policy if exists audit_logs_tenant_isolation on public.audit_logs;
create policy audit_logs_tenant_isolation on public.audit_logs
for all to authenticated
using (powerhub_private.has_tenant_access(tenant_id) or powerhub_private.is_platform_admin())
with check (powerhub_private.has_tenant_access(tenant_id) or powerhub_private.is_platform_admin());

drop policy if exists company_account_tenant_access on public.company_accounts;
drop policy if exists company_accounts_tenant_isolation on public.company_accounts;
create policy company_accounts_tenant_isolation on public.company_accounts
for all to authenticated
using (powerhub_private.has_tenant_access(tenant_id) or powerhub_private.is_platform_admin())
with check (powerhub_private.has_tenant_access(tenant_id) or powerhub_private.is_platform_admin());

drop policy if exists expense_tenant_access on public.expenses;
drop policy if exists expenses_tenant_isolation on public.expenses;
create policy expenses_tenant_isolation on public.expenses
for all to authenticated
using (powerhub_private.has_tenant_access(tenant_id) or powerhub_private.is_platform_admin())
with check (powerhub_private.has_tenant_access(tenant_id) or powerhub_private.is_platform_admin());

drop policy if exists generator_tenant_access on public.generators;
drop policy if exists generators_tenant_isolation on public.generators;
create policy generators_tenant_isolation on public.generators
for all to authenticated
using (powerhub_private.has_tenant_access(tenant_id) or powerhub_private.is_platform_admin())
with check (powerhub_private.has_tenant_access(tenant_id) or powerhub_private.is_platform_admin());

drop policy if exists reading_tenant_access on public.meter_readings;
drop policy if exists meter_readings_tenant_isolation on public.meter_readings;
create policy meter_readings_tenant_isolation on public.meter_readings
for all to authenticated
using (powerhub_private.has_tenant_access(tenant_id) or powerhub_private.is_platform_admin())
with check (powerhub_private.has_tenant_access(tenant_id) or powerhub_private.is_platform_admin());
