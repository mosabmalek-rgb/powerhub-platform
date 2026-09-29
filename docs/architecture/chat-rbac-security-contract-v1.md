# PowerHub Smart Support Chat — RBAC Security Contract v1

**Status:** Design-only / not production / not a migration

**Target branch:** `feature/powerhub-smart-support-chat-v1`

## 1. Purpose

Define the authorization boundary for Smart Support Chat v1 without introducing a parallel chat-specific RBAC system.

The contract separates:

- tenant messaging capability (`manageMessaging`)
- platform Support Center capability (`manageSupportChat`)
- platform administration (`powerhub_is_platform_admin()`)

These are not interchangeable.

## 2. Existing RBAC that remains authoritative

The implementation must continue to reuse the existing PowerHub RBAC model:

- `PowerRole`: `owner | manager | accountant | collector | technician | viewer`
- `PowerCapability`
- `custom_permission_roles`
- `platform_role_policies`
- `staff_profiles.permissions`
- existing Supabase security helpers

No `chat_roles`, `chat_permissions`, or chat-specific role hierarchy is introduced.

The current code defines `manageMessaging` as an existing tenant capability and labels it `إدارة الإشعارات والقوالب`. It is currently assigned through the existing tenant-role capability matrix and must not be silently reinterpreted as Support Center access.

## 3. New capability: `manageSupportChat`

`manageSupportChat` is a **platform-level support capability**.

It authorizes access to the internal Support Center and support operations such as:

- viewing the support queue
- viewing conversations assigned/available to support
- accepting or releasing support assignments
- responding as support
- changing support conversation status
- creating/processing human handoffs

It does **not** grant:

- tenant financial permissions
- invoice/payment operations
- subscription changes
- permission administration
- unrestricted access to tenant data outside the support conversation context

### Important boundary

`manageMessaging` != `manageSupportChat`.

`powerhub_is_platform_admin()` != automatic Support Center access.

This is intentional because the existing platform-admin helper includes `finance_admin`; a finance-oriented platform role must not automatically gain visibility into all support conversations.

## 4. Scope model

| Capability | Scope | Purpose |
|---|---|---|
| `manageMessaging` | Tenant | Existing tenant notifications/templates capability |
| `manageSupportChat` | Platform | Internal cross-tenant Support Center |
| `powerhub_is_platform_admin()` | Platform | Existing broad platform administration; not a chat authorization shortcut |

`manageSupportChat` must not be added to the `PowerRole` tenant-role matrix as if it were a tenant capability.

## 5. Representation decision

The existing `PowerCapability` type should be extended to include `manageSupportChat` so the application has one canonical capability vocabulary.

However, the existing `capabilityRoles` tenant-role map must **not** assign `manageSupportChat` to `owner`, `manager`, or another tenant role.

Therefore the implementation must distinguish capability scope from tenant role mapping.

Recommended model:

```ts
export type PowerCapability =
  | /* existing tenant capabilities */
  | "manageMessaging"
  | "manageSupportChat"
  | "viewAudit";
```

And:

```ts
const capabilityScopes: Record<PowerCapability, "tenant" | "platform"> = {
  // existing tenant capabilities => "tenant"
  manageMessaging: "tenant",
  manageSupportChat: "platform",
  viewAudit: "tenant",
};
```

`rolesWith("manageSupportChat")` must not infer tenant roles. Platform support access must be resolved from the platform authorization source, not from `PowerRole`.

## 6. Platform authorization source

The current platform authorization architecture already contains `platform_role_policies` and `users.platform_role`.

Before executable migration, the implementation must establish exactly how `manageSupportChat` is represented in that existing platform policy system.

Preferred direction:

- add `manageSupportChat` to the existing capability vocabulary;
- store its platform-level policy using the existing `platform_role_policies` mechanism;
- evaluate the caller's current platform role against that policy;
- do not create a second support-permission table.

If the current SQL policy functions cannot safely represent a platform capability distinct from tenant capabilities, extend those existing functions minimally. Do not create parallel RBAC tables.

## 7. Default access policy

The secure default is **deny**.

Until an explicit platform policy grants `manageSupportChat`:

- Support Center queue: denied
- cross-tenant support conversation list: denied
- support assignment actions: denied
- support response actions: denied

Tenant users continue to use their existing tenant authorization and can request a handoff. A handoff does not itself grant the requester Support Center privileges.

## 8. Finance isolation

A caller having a platform role such as `finance_admin` must not receive Support Center access merely because `powerhub_is_platform_admin()` returns true.

Chat RLS/RPC authorization must use a dedicated support capability check for support operations.

The broad helper may still be used for platform-administration operations where its existing semantics are appropriate, but never as the sole gate for Support Center access.

## 9. Tenant-side access

Tenant-side chat access remains tenant-scoped.

A tenant user may access a conversation only when all applicable conditions are true:

1. caller identity is derived from `auth.uid()`;
2. caller maps to `public.users.id` through the existing identity helper;
3. caller has active tenant membership;
4. conversation belongs to that tenant;
5. caller is an authorized participant/tenant actor according to the chat policy.

The participant row is not itself an authorization grant; current membership and capability must be re-evaluated.

For tenant messaging administration, reuse `manageMessaging` where the existing application semantics require it. Do not broaden it to platform support.

## 10. Support-side access

For Support Center operations, authorization must verify:

1. authenticated caller;
2. active caller account;
3. caller has explicit `manageSupportChat` platform capability;
4. requested conversation is in the support-visible scope;
5. assignment/status transition is permitted by the chat state machine;
6. tenant isolation is preserved at the data/RPC boundary.

Assignment must not accept an arbitrary user ID merely because the target user exists.

The assignee must independently possess `manageSupportChat` and be eligible for the requested support operation.

## 11. RPC contract impact

The existing Chat RPC security contract remains valid, with the following authorization refinement:

### `chat_send_message`

- tenant human messages: existing tenant authorization
- support messages: caller must have `manageSupportChat` and support access to the conversation
- `sender_user_id` always derived from the authenticated caller
- frontend-supplied sender identity is ignored

### `chat_request_handoff`

- tenant user may request handoff when authorized for the conversation
- creates `SUPPORT_PENDING`
- does not grant Support Center access

### `chat_assign_support`

- caller must have `manageSupportChat`
- assignee must have `manageSupportChat`
- no arbitrary cross-tenant role escalation

### `chat_change_status`

- support transitions require `manageSupportChat`
- tenant/user transitions remain explicitly limited by the state machine

### `chat_search_knowledge`

- published articles are readable by authenticated users
- draft/archive access requires the existing knowledge-management authorization path
- Support Center access alone does not automatically imply knowledge publishing rights

## 12. Realtime impact

Realtime topic authorization must use the same effective authorization rules as the database/RPC layer.

A topic name is not a security boundary.

### Conversation topic

`chat:conversation:{conversation_id}` is allowed only when the caller is currently authorized for that conversation.

### Support queue topic

`chat:support:queue` is allowed only when the caller has `manageSupportChat`.

No Realtime policy should use `powerhub_is_platform_admin()` alone for the support queue.

## 13. UI impact

The UI must not use visibility as the security control.

Recommended behavior:

- hide Support Center navigation when `manageSupportChat` is absent;
- still enforce the same capability on server/RPC and RLS paths;
- do not infer Support Center access from `manageMessaging`;
- do not infer Support Center access from a generic `admin`/`super_admin` label alone.

## 14. Required implementation touchpoints

Before the capability is considered implemented, review/update all of these consistently:

1. `shared/powerhub-rbac.ts`
   - add `manageSupportChat` to the canonical capability union;
   - add platform scope metadata;
   - do not add it to `capabilityRoles` tenant defaults.

2. Server capability vocabulary / `allCapabilities`
   - include `manageSupportChat`.

3. Existing capability validation in Supabase RPCs
   - accept the new capability where platform capability policy is stored;
   - preserve existing tenant capability validation.

4. `platform_role_policies`
   - define the platform policy representation for `manageSupportChat`.

5. Platform policy read/write functions
   - validate the capability;
   - enforce platform-admin authority for policy administration;
   - preserve deny-by-default behavior.

6. `staff_profiles` / custom permission paths
   - do not accidentally expose `manageSupportChat` as a tenant custom permission unless the existing architecture explicitly supports platform-scoped capabilities there.

7. Chat RLS and RPCs
   - use the dedicated support-capability check for support operations.

8. Realtime authorization
   - use the same support-capability decision for the support queue.

## 15. Security abuse matrix

| Abuse case | Expected result |
|---|---|
| Tenant owner with `manageMessaging` opens Support Center | DENY |
| Tenant manager opens Support Center | DENY unless explicitly granted platform support capability |
| `finance_admin` opens Support Center | DENY unless explicitly granted `manageSupportChat` |
| Platform support user opens unrelated tenant conversation without chat authorization | DENY |
| User spoofs `sender_user_id` | DENY / ignore spoofed ID |
| User spoofs `tenant_id` | DENY / derive tenant from authorized conversation |
| User assigns conversation to arbitrary staff user | DENY |
| Support user assigns to non-support user | DENY |
| User sends to closed conversation | DENY |
| Realtime client guesses support topic | DENY |
| User edits capability payload from frontend | DENY at server/RPC/DB boundary |

## 16. Gate status

| Gate | Status |
|---|---|
| Existing RBAC inspected | PASS |
| `manageMessaging` identified and preserved | PASS |
| Parallel chat RBAC rejected | PASS |
| Dedicated `manageSupportChat` defined | PASS — design |
| Platform representation confirmed executable | **OPEN** |
| Production DDL applied | NOT APPROVED |
| Chat migration applied | NOT APPROVED |
| Storage RLS | BLOCKED / next security gate |
| Realtime support authorization | Design-ready, depends on capability implementation |

## 17. Release rule

No Smart Support Chat production migration is approved until:

- `manageSupportChat` has one canonical representation in the existing RBAC architecture;
- finance/platform-admin overreach is tested;
- tenant owners cannot enter the cross-tenant Support Center through `manageMessaging`;
- RPC and Realtime checks use the same authorization contract;
- Storage RLS is separately verified;
- executable SQL passes security review;
- Production remains unchanged until the release gate is explicitly approved.
