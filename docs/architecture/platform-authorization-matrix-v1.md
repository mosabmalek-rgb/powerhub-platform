# PowerHub Platform Authorization Matrix v1

Status: DESIGN-APPROVED / NOT DEPLOYED

## Trusted Decision Path

`auth.uid()` -> `users.auth_user_id` -> `users.id` -> active account -> `users.platform_role` -> platform capability policy -> `manageSupportChat` -> operation-specific authorization

## Support Center Decisions

| Check | Required | Failure |
|---|---|---|
| Authenticated session | yes | deny |
| Caller maps to `public.users` | yes | deny |
| Account active | yes | deny |
| Platform capability explicitly granted | yes | deny |
| Tenant membership | no for queue access | not a Support prerequisite |
| Tenant `manageMessaging` | no | must not substitute |
| Generic platform-admin helper | no | must not substitute |
| Finance-admin role alone | no | deny |
| Assignee has `manageSupportChat` | yes | deny assignment |
| Conversation is accessible through Support workflow | yes | deny |

## Required Negative Tests

1. Anonymous caller -> denied.
2. Authenticated generator owner -> denied without platform support capability.
3. Tenant manager with `manageMessaging` -> denied.
4. Finance admin without `manageSupportChat` -> denied.
5. Platform admin without explicit `manageSupportChat` -> denied.
6. Forged `p_actor_user_id` -> ignored; authenticated caller is authoritative.
7. Support agent assigning a user without `manageSupportChat` -> denied.
8. Unauthorized user subscribing to `chat:support:queue` -> denied.
9. Support agent attempting financial mutation through chat RPC -> denied by domain boundary.
10. Cross-tenant direct access outside chat scope -> denied.

## Required Positive Tests

1. Active platform support user with `manageSupportChat` -> Support Center allowed.
2. Authorized support user -> queue visibility allowed.
3. Authorized support user -> assignment allowed only to another authorized support user.
4. Authorized support user -> support status transitions allowed according to state machine.
5. Authorized support user -> private conversation Realtime allowed only for authorized conversation.

## Non-Goals

- No new chat-specific RBAC tables.
- No automatic Support access for platform admin.
- No automatic Support access for finance admin.
- No expansion of tenant `PowerCapability`.
- No Production policy rows in this design phase.
