# PowerHub Platform Authorization Contract v1

Status: DESIGN-APPROVED / NOT DEPLOYED
Scope: PowerHub Assistant + Smart Support Chat v1
Production changes: NONE

## 1. Purpose

Define a platform-level authorization contract for Support Center access without creating a parallel chat RBAC system and without treating every platform administrator as a support agent.

## 2. Separation of Authorization Domains

PowerHub has two authorization domains:

1. Tenant authorization: access to a generator owner's workspace and tenant operations. Existing `PowerRole` and `PowerCapability` remain responsible for this domain. `manageMessaging` remains a tenant capability for notifications/templates and is NOT Support Center authorization.
2. Platform authorization: access to platform-wide operational functions. Support Center uses the platform capability `manageSupportChat`.

`manageSupportChat` MUST NOT be added to the tenant `PowerRole` matrix and MUST NOT be accepted by tenant staff-permission RPCs.

## 3. Platform Capability

Canonical capability:

`manageSupportChat`

Meaning: permits a platform staff member to operate the PowerHub Support Center, including viewing the support queue, opening authorized support conversations, accepting/releasing assignments, and performing support workflow actions exposed by v1 RPCs.

It does NOT grant:
- financial operations
- invoice/payment mutations
- tenant permission administration
- arbitrary tenant data administration
- AI policy administration unless separately authorized
- knowledge-base publishing unless separately authorized

## 4. Identity Contract

For browser-originated security decisions, the trusted identity chain is:

`auth.uid()` -> `public.users.auth_user_id` -> `public.users.id`

RPCs MUST derive the caller from the authenticated session. They MUST NOT trust `p_actor_user_id`, `p_user_id`, or equivalent caller identity supplied by the frontend.

The caller must have an active account. Suspended/inactive accounts are denied.

## 5. Platform Role and Capability Evaluation

`public.users.platform_role` identifies the caller's platform role. The existing `platform_role_policies` table remains the policy store; no new chat-specific RBAC table is introduced.

For Support Center authorization, evaluation is explicitly platform-scoped:

1. Resolve caller from `auth.uid()`.
2. Confirm active account.
3. Read caller's `platform_role`.
4. Resolve `manageSupportChat` against the platform-role policy namespace.
5. Require an explicit allowed result for support access.
6. Never infer Support access merely from `users.role = 'admin'`, `platform_role = 'platform_owner'`, or `powerhub_is_platform_admin()`.

Until the executable policy resolver is implemented, this document is a contract only; no Production policy row is assumed.

## 6. Finance Admin Isolation

`finance_admin` MUST NOT receive `manageSupportChat` implicitly.

A finance administrator can access Support Center only if the platform authorization model explicitly grants `manageSupportChat` to that platform role. Existing platform-admin helpers MUST NOT be used as a blanket Support gate.

## 7. Existing Tenant RBAC Isolation

The following remain tenant-only:

- `manageMessaging`
- all existing `PowerCapability` values
- `staff_profiles.permissions`
- `custom_permission_roles.permissions`
- tenant `PowerRole` evaluation

`manageSupportChat` MUST NOT be inserted into:
- `PowerRole`
- `allCapabilities` used for tenant access
- `staff_profiles.permissions` validation
- `custom_permission_roles.permissions`
- tenant capability role matrices

## 8. Support RPC Authorization Contract

Every Support Center mutation MUST execute authorization server-side/RPC-side.

Required pattern:

`authenticated caller -> derived public user -> active account -> platform capability check -> operation-specific checks -> mutation`

Required Support RPCs include, at minimum:

- `chat_assign_support`
- support queue/status operations
- `chat_change_status` when actor is support
- `chat_close_conversation` when actor is support
- future support-only operations

The RPC MUST NOT accept a caller identity as an authority input.

## 9. Assignment Rules

For `chat_assign_support`:

- caller must have `manageSupportChat`;
- assignee must resolve to an active platform user with `manageSupportChat`;
- arbitrary tenant users cannot be assigned;
- one active/pending assignment per conversation;
- assignment and audit event must be atomic;
- releasing an assignment must be authorization checked again.

## 10. Conversation Scope

Platform support access is cross-tenant by design only for conversations present in the Support Center queue.

This does NOT mean that a support user receives unrestricted direct SQL access to all tenant tables.

Chat RLS/RPCs remain responsible for limiting support operations to the chat entities and fields required by the Support Center.

## 11. Realtime Contract

Support queue Realtime authorization MUST use the same `manageSupportChat` decision.

The channel topic is not a security boundary.

Required queue topic:

`chat:support:queue`

Clients use private Realtime channels. Realtime authorization must not grant queue visibility merely because the user is a platform admin or knows the topic name.

## 12. Knowledge Base Separation

`manageSupportChat` does not automatically grant knowledge-base publishing.

Knowledge management remains a separate authorization decision. A support agent may consume published knowledge without automatically gaining draft/publish/archive rights.

## 13. AI Boundary

`manageSupportChat` permits human support workflow operations only.

It does not permit an AI model or support user to:

- execute payments;
- modify invoices;
- modify tenant permissions;
- change subscriptions;
- perform financial transactions;
- expose secrets or credentials.

AI execution remains server-side and must use approved PowerHub knowledge.

## 14. Security Matrix

| Actor | manageMessaging | manageSupportChat | Support Center |
|---|---:|---:|---:|
| Tenant owner | possible | no implicit grant | denied |
| Tenant manager | possible | no | denied |
| Tenant accountant | possible | no | denied |
| Tenant collector | possible | no | denied |
| Tenant technician | possible | no | denied |
| Tenant viewer | possible | no | denied |
| Finance admin | unrelated | no implicit grant | denied unless explicitly granted |
| Platform owner | unrelated | no implicit grant by role alone | denied unless explicitly granted |
| Platform support staff | unrelated | yes | allowed |
| Anonymous | no | no | denied |

## 15. Abuse Cases

The implementation must deny:

- anonymous access;
- forged actor/user IDs;
- tenant owner attempting to enter Support Center solely via tenant privileges;
- `manageMessaging` being treated as `manageSupportChat`;
- finance admin inheriting support access from a generic platform-admin helper;
- platform admin without explicit support capability entering the support queue;
- assignment to a user without support capability;
- Realtime queue subscription without support authorization;
- cross-tenant access to non-chat domain data through Support Center;
- direct browser mutation bypassing RPC authorization.

## 16. Implementation Constraint

Because the current `platform_role_policies` table is currently empty in Production and existing application code evaluates it in a tenant-role-oriented path, the executable implementation MUST first introduce a clearly platform-scoped capability resolver/contract rather than silently changing the semantics of existing tenant policy checks.

Preferred implementation order:

1. Add `PlatformCapability` type containing `manageSupportChat`.
2. Add a dedicated server-side `requirePlatformCapability` resolver that derives the authenticated caller and evaluates platform policy.
3. Reuse the existing `platform_role_policies` storage only if its semantics are made unambiguous for platform roles; otherwise make the smallest extension to the existing RBAC model rather than creating chat-specific RBAC.
4. Update Support RPC security contracts to call this resolver.
5. Add deterministic authorization tests.
6. Only then create executable Supabase migration/policy rows.

## 17. Production Gate

This contract does not authorize any Production change.

Before deployment, all of the following must pass:

- platform capability resolver implemented and tested;
- `manageSupportChat` absent from tenant capability validators;
- finance-admin isolation test passes;
- forged actor test passes;
- Support assignment authorization passes;
- Realtime queue authorization passes;
- Storage RLS gate passes;
- executable migration reviewed;
- CI passes;
- Production migration explicitly approved.

## 18. Decision

Platform Authorization Contract v1 is APPROVED as the design contract for Smart Support Chat v1.

Implementation and Production deployment are separate gates and remain NOT DEPLOYED.
