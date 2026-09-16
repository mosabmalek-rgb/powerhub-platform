# PowerHub Platform Capability Resolver Contract v1

Status: DESIGN-APPROVED / NOT DEPLOYED
Scope: Platform Support Authorization for Smart Support Chat v1
Production changes: NONE

## 1. Decision

The existing `platform_role_policies` table is tenant-role scoped by its current schema (`owner`, `manager`, `accountant`, `collector`, `technician`, `viewer`) and therefore MUST NOT be repurposed silently for platform capabilities.

The smallest safe extension is a generic platform capability policy namespace, separate from tenant `PowerCapability` validation. It is authorization infrastructure, not chat-specific RBAC.

Canonical capability for this feature:

`manageSupportChat`

Future platform capabilities may reuse the same resolver without changing tenant RBAC.

## 2. Trusted Identity

The resolver MUST derive identity from the authenticated session:

`auth.uid()` -> `public.users.auth_user_id` -> `public.users.id`

Inputs such as `p_actor_user_id` or `p_user_id` are never authority-bearing.

Required caller checks:
- authenticated session exists;
- matching `public.users` row exists;
- `account_status = 'active'`;
- `platform_role` is present;
- explicit capability policy evaluates to `true`.

## 3. Platform Policy Namespace

Preferred executable model:

`private.platform_capability_policies`

Minimum contract:
- `id bigint identity primary key`
- `platform_role text NOT NULL`
- `capability text NOT NULL`
- `is_allowed boolean NOT NULL DEFAULT false`
- `updated_by_user_id bigint REFERENCES public.users(id)`
- `updated_at timestamptz NOT NULL DEFAULT now()`
- unique `(platform_role, capability)`

The table is platform-scoped. It must not be exposed as a tenant permission source.

For v1 the allowed platform roles are the existing values:
- `platform_owner`
- `platform_admin`
- `finance_admin`

No role receives support automatically. A row with `is_allowed = true` is required.

## 4. Resolver Contract

Canonical internal resolver:

`private.powerhub_has_platform_capability(p_capability text) returns boolean`

Required behavior:
1. Resolve the caller from `auth.uid()`.
2. Resolve `public.users.id` and account status.
3. Reject missing/inactive callers.
4. Read `platform_role`.
5. Read exactly one matching platform policy row.
6. Return `true` only when an explicit row exists and `is_allowed = true`.
7. Return `false` for missing policy, null role, inactive caller, or unsupported capability.
8. Never use `users.role = 'admin'` as a support grant.
9. Never use `powerhub_is_platform_admin()` as a support grant.
10. Never inspect tenant membership or `staff_profiles.permissions` to grant platform support.

## 5. Administrative Mutation Contract

Policy changes MUST be server/RPC controlled.

Required pattern:

`authenticated platform administrator -> derived caller -> authorized policy-management capability -> validate platform role/capability -> atomic upsert -> audit`

A browser must not receive direct INSERT/UPDATE/DELETE authority over the policy table.

Existing `public.powerhub_admin_save_role_policy(...)` remains tenant-role policy management and MUST NOT be modified to accept `manageSupportChat` or platform roles.

## 6. Security Separation

The following mappings are forbidden:

- `manageMessaging` -> `manageSupportChat`
- tenant `owner` -> Support Center
- tenant `manager` -> Support Center
- `users.role = 'admin'` -> Support Center
- `platform_role = 'platform_owner'` -> Support Center without explicit policy
- `powerhub_is_platform_admin()` -> Support Center
- `finance_admin` -> Support Center without explicit policy
- participant row -> platform authorization

## 7. Support Resolver Usage

All Support Center server/RPC operations must call the resolver before operation-specific checks:

`requirePlatformCapability('manageSupportChat')`

Then apply operation-specific authorization, for example:
- conversation queue visibility;
- assignment eligibility;
- status transitions;
- close/reopen rules;
- attachment access.

The resolver does not itself authorize arbitrary tenant data access.

## 8. Realtime

The same resolver must be reflected in the RLS policy for the private Support queue topic.

Knowing `chat:support:queue` is never sufficient.

## 9. Tests Required Before Executable Migration

Positive:
- active platform support user + explicit allow -> PASS;
- multiple allowed support roles -> PASS;
- capability remains valid across tenants -> PASS.

Negative:
- anonymous -> DENY;
- inactive caller -> DENY;
- tenant owner -> DENY;
- tenant manager with `manageMessaging` -> DENY;
- finance admin without explicit allow -> DENY;
- platform owner without explicit allow -> DENY;
- platform admin without explicit allow -> DENY;
- forged actor ID -> ignored and DENY/actual caller decision applies;
- missing policy row -> DENY;
- policy `is_allowed=false` -> DENY.

## 10. Migration Gate

This document is a design contract only.

Before executable migration:
- schema design reviewed;
- resolver implementation reviewed;
- policy-management RPC reviewed;
- tenant RBAC regression tests pass;
- Support authorization tests pass;
- Realtime queue test passes;
- Storage RLS test passes;
- CI passes.

Production migration remains NOT APPROVED.
