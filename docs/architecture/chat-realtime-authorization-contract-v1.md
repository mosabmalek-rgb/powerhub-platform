# PowerHub Chat Realtime Authorization Contract v1

**Status:** DESIGN-APPROVED / NOT DEPLOYED

## 1. Purpose

Define the authorization boundary for PowerHub Chat v1 Realtime channels before any executable Realtime policy is deployed.

PostgreSQL remains the source of truth. Realtime is a delivery mechanism, not an authorization source.

## 2. Channels

### Conversation channel

Canonical topic:

`chat:conversation:{conversation_id}`

Access is allowed only when the authenticated user currently has access to the referenced conversation.

- Tenant owner/participant access is determined from the chat database authorization model.
- Support access requires the explicit platform capability `manageSupportChat`.
- Knowing or guessing `conversation_id` is never sufficient.
- A stale participant row must not bypass current RLS/database authorization.

### Support queue

Canonical topic:

`chat:support:queue`

Access requires the explicit platform capability `manageSupportChat`.

The following are NOT sufficient:

- `users.role = 'admin'`
- `platform_role = 'platform_owner'` by itself
- `platform_role = 'platform_admin'` by itself
- `platform_role = 'finance_admin'` by itself
- tenant role membership
- `manageMessaging`
- participant membership in an arbitrary conversation

## 3. Private channels

Clients MUST subscribe using private channels.

The topic name is not a security boundary. Authorization MUST be enforced by RLS on `realtime.messages` using the authenticated identity and topic-derived identifiers.

## 4. Authorization source

There must be one authoritative platform support capability:

`private.powerhub_has_platform_capability('manageSupportChat')`

Server-side tRPC Support procedures use the same capability resolver through `requirePlatformCapability` / `platformSupportProcedure`.

Realtime authorization must not introduce a second support-role hierarchy.

## 5. Conversation authorization

A future policy must resolve the topic's `conversation_id`, then verify:

1. caller is authenticated;
2. conversation exists;
3. caller has current authorized access to that conversation;
4. tenant consistency is preserved;
5. or caller has explicit `manageSupportChat` capability for support workflow access.

Authorization must be based on database state, not on a client-supplied tenant ID or actor ID.

## 6. Payload minimization

Realtime events should contain identifiers and event metadata, not full sensitive message content.

Preferred payload:

- `message_id`
- `conversation_id`
- `event_type`
- `created_at`

Clients fetch authoritative message content through the authorized application boundary.

## 7. Support queue isolation

`chat:support:queue` is a platform-scoped workflow channel. Tenant users must never be able to subscribe to it.

Cross-tenant support access is limited to the chat workflow entities and does not imply access to arbitrary tenant domain data.

## 8. Failure behavior

Default deny.

If topic parsing fails, conversation lookup fails, caller identity cannot be resolved, capability resolution fails, or the authorization state is ambiguous, Realtime access is denied.

## 9. Required executable tests

Before production deployment, execute authenticated integration tests for:

### Conversation channel

- anonymous caller -> DENY
- tenant user in conversation -> ALLOW
- tenant user outside conversation -> DENY
- user from another tenant -> DENY
- guessed conversation ID -> DENY
- support user with explicit `manageSupportChat` -> ALLOW
- support-capable user without conversation membership -> ALLOW only for the support workflow permitted by the final policy
- forged actor ID -> ignored; authenticated identity wins

### Support queue

- anonymous -> DENY
- tenant owner -> DENY
- tenant manager with `manageMessaging` -> DENY
- finance_admin without explicit grant -> DENY
- platform_owner without explicit grant -> DENY
- platform_admin without explicit grant -> DENY
- explicit `manageSupportChat` grant -> ALLOW
- policy removed/revoked -> DENY

## 10. Production gate

This contract does not authorize production changes.

Executable Realtime RLS policies require:

1. final chat schema and authorization tables;
2. authenticated integration identities;
3. policy tests recorded as PASS;
4. tenant-isolation tests recorded as PASS;
5. support queue isolation tests recorded as PASS;
6. review of Storage and Chat RLS together;
7. explicit approval before Production migration.
