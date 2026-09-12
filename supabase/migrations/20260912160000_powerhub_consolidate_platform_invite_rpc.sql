-- Consolidate the platform invitation RPC contract.
-- The canonical admin runtime uses the 5-argument RPC created in 0088.
-- Remove the obsolete 4-argument overload introduced by the later adapter migration.
-- This is intentionally additive/cleanup-only and must be applied before Production cutover.

drop function if exists public.powerhub_admin_invite_platform_access(bigint, text, text, integer);
