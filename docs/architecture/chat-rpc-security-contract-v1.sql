-- PowerHub Smart Support Chat v1
-- RPC SECURITY CONTRACT v1 — DESIGN ONLY
-- IMPORTANT: This file is NOT an executable migration.
-- Do NOT deploy to Production until support authorization, SQL review,
-- tests, and an isolated Supabase migration gate are complete.

/*
IDENTITY RULE
-------------
Every chat RPC derives the caller from auth.uid() through:
  private.powerhub_current_user_id()
The frontend MUST NOT supply an authoritative actor/user id.
Any actor/user id supplied by UI is ignored or treated as non-authoritative metadata.

AUTHORIZATION RULE
------------------
1. Resolve caller -> public.users.id.
2. Verify account_status = 'active'.
3. Resolve tenant membership using active membership_status + expiry.
4. Verify conversation belongs to the requested tenant.
5. Verify participant/access scope using the approved RLS/security helper.
6. For tenant staff, effective messaging capability must be resolved from the
   existing staff_profiles/custom_permission_roles model and platform policy.
7. Support Center cross-tenant access MUST NOT use
   private.powerhub_is_platform_admin() as a blanket grant because that helper
   currently includes finance_admin.
8. A dedicated Support capability/scope (candidate: manageSupportChat) remains
   a separate approval gate.

TRANSACTION RULE
----------------
Mutating RPCs must perform authorization, validation, mutation, audit event,
and authoritative event publication atomically where possible.

IDEMPOTENCY RULE
----------------
chat_send_message requires client_message_id and must return the existing message
when the same client_message_id is retried for the same conversation.

STATE MACHINE
-------------
AI_ACTIVE       -> SUPPORT_PENDING | remains AI_ACTIVE
SUPPORT_PENDING -> SUPPORT_ACTIVE
SUPPORT_ACTIVE  -> WAITING_USER | RESOLVED
WAITING_USER    -> SUPPORT_ACTIVE
RESOLVED        -> CLOSED | SUPPORT_ACTIVE
CLOSED          -> terminal
No frontend direct status updates.

RPC: chat_create_conversation
-----------------------------
Inputs (proposed):
  p_conversation_type text
  p_tenant_id bigint
  p_subject text nullable
  p_initial_message text nullable
  p_priority text default 'normal'

Security:
  - caller derived from auth.uid()
  - p_tenant_id is validated against active membership
  - owner/support scope required according to conversation type
  - initial message, if present, is created in the same transaction
  - created_by_user_id is caller-derived
  - tenant_id cannot be chosen independently of caller authorization

Output:
  conversation_id, tenant_id, status, last_message_at

RPC: chat_send_message
-----------------------
Inputs (proposed):
  p_conversation_id bigint
  p_client_message_id uuid
  p_body text
  p_reply_to_message_id bigint nullable
  p_metadata jsonb default '{}'

Security:
  - caller derived from auth.uid()
  - conversation access rechecked at mutation time
  - sender_user_id = caller-derived users.id
  - sender_type forced to 'human'
  - sender_type/body/message_type cannot be spoofed by client
  - tenant_id derived from conversation, never trusted from client
  - reply target must belong to the same conversation and tenant
  - CLOSED conversations reject new messages
  - idempotency by (conversation_id, client_message_id)
  - update conversation.last_message_at transactionally
  - write chat_message_sent audit event

AI/system messages:
  - MUST NOT be created through this public human-message RPC.
  - They require a separate server-only boundary.

RPC: chat_mark_read
--------------------
Inputs:
  p_conversation_id bigint
  p_last_read_message_id bigint

Security:
  - caller derived from auth.uid()
  - participant/access check
  - message must belong to conversation
  - cannot advance read cursor beyond an existing message
  - cannot modify another participant's read state

RPC: chat_request_handoff
--------------------------
Inputs:
  p_conversation_id bigint
  p_trigger text
  p_reason text
  p_category text nullable
  p_priority text default 'normal'
  p_current_page text nullable
  p_context_snapshot jsonb default '{}'

Security:
  - caller derived from auth.uid()
  - accessible conversation required
  - allowed triggers only
  - context_snapshot must reject obvious credentials/secrets/tokens
  - never store API keys, passwords, access tokens, or credentials
  - create handoff + transition conversation to SUPPORT_PENDING atomically
  - create system/handoff message atomically
  - create audit event
  - notify private support queue through authoritative server event

RPC: chat_assign_support
-------------------------
Inputs:
  p_conversation_id bigint
  p_assigned_user_id bigint

Security:
  - caller derived from auth.uid()
  - caller must have approved Support Center capability
  - assigned user must also have approved Support Center capability
  - cross-tenant assignment requires explicit platform support scope
  - no assignment based solely on chat participant rows
  - lock conversation/active assignment row before mutation
  - enforce one pending/active assignment per conversation
  - assignment target cannot be arbitrary tenant user
  - audit assignment change

RPC: chat_change_status
------------------------
Inputs:
  p_conversation_id bigint
  p_status text

Security:
  - caller derived from auth.uid()
  - caller must be authorized for requested transition
  - transition must match the state machine
  - CLOSED cannot transition further
  - resolved_at/closed_at maintained by server, not client
  - audit every status change

RPC: chat_close_conversation
-----------------------------
Inputs:
  p_conversation_id bigint

Security:
  - caller derived from auth.uid()
  - authorized support/owner scope required
  - transition must be RESOLVED -> CLOSED (or explicit approved close rule)
  - released active assignment if required by policy
  - set closed_at server-side
  - audit closure

RPC: chat_search_knowledge
---------------------------
Inputs (proposed):
  p_query text
  p_category text nullable
  p_limit integer default 5

Security:
  - authenticated caller only
  - published articles only for normal user search
  - drafts/archived articles require explicit knowledge-management authorization
  - no tenant-specific knowledge leakage in v1 because KB is platform-wide
  - retrieval must never be treated as permission to execute a financial/domain mutation

SERVER-ONLY AI BOUNDARY
------------------------
The AI orchestration layer may:
  - read authorized published knowledge
  - create assistant messages through a server-only boundary
  - create handoffs
  - attach retrieval metadata

The AI layer may NOT:
  - create payments
  - modify invoices
  - modify subscriptions
  - change permissions
  - grant access
  - execute financial actions

AUDIT
-----
Use existing public.audit_logs.
Do NOT create chat_audit_logs.
Audit identifiers and state changes, not full sensitive message bodies.

SECURITY TEST MATRIX
--------------------
1. Anonymous -> every RPC: reject.
2. User A tenant 1 -> conversation tenant 2: reject.
3. User A -> conversation where not participant/authorized: reject.
4. Client attempts sender_user_id != caller: impossible/ignored.
5. Client attempts tenant_id != conversation tenant: ignored/rejected.
6. Staff with manageMessaging -> another tenant support queue: reject.
7. finance_admin -> Support Center without support capability: reject.
8. Support user -> unauthorized tenant conversation: reject.
9. User -> assign arbitrary user as support: reject.
10. Closed conversation -> send message: reject.
11. Duplicate client_message_id -> one logical message only.
12. reply_to_message_id from another conversation: reject.
13. Handoff with credential-like context: reject/sanitize according to policy.
14. Realtime topic spoofing: reject at realtime.messages RLS.
15. Private attachment path from another tenant: reject at Storage RLS.

APPROVAL GATES
--------------
G1 Identity mapping: PASS
G2 Tenant membership model: PASS
G3 Existing RBAC reuse: PASS
G4 RPC caller derivation: PASS (design)
G5 Support capability: BLOCKED pending explicit product/security decision
G6 Storage RLS: BLOCKED pending policy implementation/review
G7 Executable migration: NOT APPROVED
G8 Production deployment: NOT APPROVED
