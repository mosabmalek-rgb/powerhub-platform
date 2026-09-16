-- PowerHub Platform Authorization SQL Contract v1
-- DESIGN ONLY. DO NOT EXECUTE AGAINST PRODUCTION.
-- Purpose: define the executable shape for platform Support authorization.

-- 1. Platform capabilities are intentionally separate from tenant PowerCapability.
-- Canonical capability: manageSupportChat

-- 2. Trusted identity must be derived inside SQL/RPC from auth.uid().
-- Frontend actor IDs are never authoritative.

-- 3. Preferred resolver contract:
--
-- private.powerhub_has_platform_capability(p_capability text)
-- returns boolean
--
-- Required behavior:
--   a) resolve auth.uid() -> public.users.auth_user_id -> public.users.id;
--   b) reject missing/inactive caller;
--   c) read public.users.platform_role;
--   d) evaluate the platform-scoped policy for that role/capability;
--   e) return true only for an explicit allowed policy decision;
--   f) never use users.role='admin' as a Support authorization shortcut;
--   g) never use private.powerhub_is_platform_admin() as a blanket Support shortcut;
--   h) finance_admin has no implicit support access.

-- 4. The current production platform_role_policies table is empty.
-- No policy row is implied by this contract.
--
-- 5. IMPORTANT semantic boundary:
-- Existing tenant authorization code evaluates platform_role_policies using a tenant
-- PowerRole. That path MUST NOT be silently repurposed for platform capabilities.
-- Before executable deployment, either:
--   A) establish an explicit platform-role namespace in the existing policy model,
--      with a resolver that distinguishes platform_role from tenant role; OR
--   B) make the smallest documented extension to the existing RBAC model.
-- Do not create chat_roles/chat_permissions.

-- 6. Suggested test cases for the future SQL implementation:
--   anonymous -> false
--   tenant owner -> false unless explicitly represented as platform support
--   tenant manager + manageMessaging -> false
--   finance_admin without manageSupportChat -> false
--   platform_owner without explicit capability -> false
--   platform support role + explicit manageSupportChat -> true
--   forged actor id -> irrelevant; auth.uid() remains source of truth

-- 7. Production gate:
-- This file contains no CREATE FUNCTION/ALTER TABLE/INSERT statements intentionally.
-- Executable migration requires separate review after the platform policy namespace
-- is finalized and Storage RLS is closed.
