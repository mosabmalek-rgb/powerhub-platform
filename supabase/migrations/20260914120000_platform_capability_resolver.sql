-- Platform capability authorization foundation for Smart Support Chat v1.
-- SECURITY NOTE: no default capability grants are inserted here.
-- Production deployment is intentionally gated until authorization tests pass.

create schema if not exists private;

create table if not exists private.platform_capability_policies (
  id bigint generated always as identity primary key,
  platform_role text not null,
  capability text not null,
  is_allowed boolean not null default false,
  updated_by_user_id bigint references public.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint platform_capability_policies_role_check
    check (platform_role in ('platform_owner', 'platform_admin', 'finance_admin')),
  constraint platform_capability_policies_capability_check
    check (capability in ('manageSupportChat')),
  constraint platform_capability_policies_role_capability_key
    unique (platform_role, capability)
);

comment on table private.platform_capability_policies is
  'Platform-scoped authorization policy. Deliberately separate from tenant PowerCapability and platform_role_policies.';

comment on column private.platform_capability_policies.capability is
  'Platform capability namespace; v1 supports manageSupportChat only.';

revoke all on table private.platform_capability_policies from public;
revoke all on table private.platform_capability_policies from anon;
revoke all on table private.platform_capability_policies from authenticated;

create or replace function private.powerhub_has_platform_capability(p_capability text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.users u
    join private.platform_capability_policies policy
      on policy.platform_role = u.platform_role
     and policy.capability = p_capability
     and policy.is_allowed = true
    where u.auth_user_id = auth.uid()
      and u.account_status = 'active'
      and u.platform_role in ('platform_owner', 'platform_admin', 'finance_admin')
  );
$$;

comment on function private.powerhub_has_platform_capability(text) is
  'Explicit platform capability resolver. Identity is derived only from auth.uid(); tenant RBAC and powerhub_is_platform_admin() are intentionally not consulted.';

revoke all on function private.powerhub_has_platform_capability(text) from public;
revoke all on function private.powerhub_has_platform_capability(text) from anon;
grant execute on function private.powerhub_has_platform_capability(text) to authenticated;

create index if not exists platform_capability_policies_lookup_idx
  on private.platform_capability_policies(platform_role, capability)
  where is_allowed = true;

-- No INSERT/UPDATE/DELETE grants are provided to browser roles.
-- No manageSupportChat policy row is seeded; absence is deny-by-default.
