-- P6 staging/release hardening fixes found during live rehearsal.
-- 1) Keep RLS helpers in a private schema rather than public API.
-- 2) Fix reading/approval ambiguity and NULL previous reading.
-- 3) Fix invoice period validation/advisory-lock typing and align audit columns.

create schema if not exists powerhub_private;

create or replace function powerhub_private.current_user_id()
returns bigint language sql stable security definer set search_path=public,powerhub_private
as $$ select id from public.users where auth_user_id=auth.uid() limit 1 $$;

create or replace function powerhub_private.current_tenant_ids()
returns bigint[] language sql stable security definer set search_path=public,powerhub_private
as $$ select coalesce(array_agg(tenant_id),'{}'::bigint[]) from public.tenant_members where user_id=powerhub_private.current_user_id() and is_active and membership_status='active' $$;

create or replace function powerhub_private.is_platform_user()
returns boolean language sql stable security definer set search_path=public,powerhub_private
as $$ select exists(select 1 from public.users where id=powerhub_private.current_user_id() and platform_role is not null and account_status='active') $$;

revoke all on schema powerhub_private from public,anon,authenticated;
grant usage on schema powerhub_private to authenticated,service_role;
grant execute on function powerhub_private.current_user_id() to authenticated,service_role;
grant execute on function powerhub_private.current_tenant_ids() to authenticated,service_role;
grant execute on function powerhub_private.is_platform_user() to authenticated,service_role;

alter table public.audit_logs add column if not exists actor_platform_role text;
alter table public.audit_logs add column if not exists actor_tenant_role text;
alter table public.audit_logs alter column entity_id type text using entity_id::text;

alter table public.invoices drop constraint if exists invoices_billing_period_check;
alter table public.invoices add constraint invoices_billing_period_check check (billing_period ~ '^[0-9]{4}-[0-9]{2}$');

-- The authoritative function bodies remain in 0011/0013/0014; this migration
-- is intentionally kept small and serves as the release-safe correction layer.
