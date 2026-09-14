# PowerHub Smart Support Chat v1
## Storage RLS Security Contract v1

**Status:** DESIGN-APPROVED / NOT DEPLOYED  
**Scope:** `powerhub-private` Storage bucket and chat attachment access  
**Project:** PowerHub Production (`vvcdiqcyhaloxesvpppc`)  

---

## 1. Security decision

Chat attachments MUST use the existing private bucket:

- `powerhub-private`
- `public = false`
- maximum object size: 10 MB
- allowed MIME types: JPEG, PNG, WEBP, PDF

No new chat-specific Storage bucket is introduced in v1.

Chat attachment access is an authorization problem, not merely a path-format problem. A correctly shaped path MUST NOT by itself grant access.

Supabase Storage access control is enforced through RLS on `storage.objects`. Private buckets require authorization for Storage operations and private downloads can be served through authorized download requests or time-limited signed URLs.

---

## 2. Approved object path contract

Canonical path:

`chat/{tenant_id}/{conversation_id}/{message_id}/{file}`

The database attachment row MUST contain the same:

- bucket = `powerhub-private`
- tenant_id
- conversation_id
- message_id
- storage_path

The following consistency rule is mandatory:

`storage_path = chat/{chat_message_attachments.tenant_id}/{chat_message_attachments.conversation_id}/{chat_message_attachments.message_id}/{file}`

The Storage policy MUST NOT rely on an arbitrary first folder such as `private` or the authenticated user's UUID for chat objects because chat authorization is tenant/conversation based.

---

## 3. Trusted authorization chain

Storage access MUST reuse the existing PowerHub identity/security model.

Trusted identity chain:

`auth.uid()` → `public.users.auth_user_id` → `public.users.id`

Tenant authorization:

`private.powerhub_has_tenant_access(tenant_id)`

Platform Support authorization:

`private.powerhub_has_platform_capability('manageSupportChat')`

The latter is the approved Platform Authorization Contract v1 resolver and is still design-only at this stage.

Do NOT use:

- `users.role = 'admin'` as a Support shortcut
- `private.powerhub_is_platform_admin()` as a blanket Support shortcut
- `chat_participants` alone as authorization
- object owner metadata alone as authorization

`finance_admin` MUST NOT gain Support Center attachment access implicitly.

---

## 4. Read / download policy

### Tenant user

A tenant user may access a chat attachment only when all of the following are true:

1. authenticated;
2. object is in `powerhub-private`;
3. object path is under the canonical `chat/` namespace;
4. the referenced conversation exists;
5. conversation tenant matches the path tenant;
6. the attachment row exists and matches bucket/path/conversation/message;
7. caller has current authorized access to that conversation through the existing tenant authorization model;
8. conversation is not outside the caller's active tenant scope.

### Platform Support

A platform Support user may access chat attachments only when:

1. authenticated;
2. `manageSupportChat` is explicitly granted by the approved platform resolver;
3. the object belongs to a chat conversation;
4. the access is part of the Support workflow.

Support access is intentionally broader than a tenant owner's scope but remains limited to chat workflow entities. It does not imply unrestricted access to the tenant's operational data.

### Signed URLs

The preferred application pattern is:

1. application authenticates the caller;
2. server verifies chat authorization;
3. server verifies the attachment DB row and canonical path;
4. server calls Supabase Storage `createSignedUrl` using the trusted server credential;
5. client receives only the short-lived signed URL.

The signed URL is an output of an authorization decision. It MUST NOT be treated as an authorization mechanism by itself.

Recommended TTL: short-lived, with the existing server helper currently using 10 minutes as the default. A future implementation may reduce this TTL for especially sensitive attachments.

---

## 5. Upload policy

### v1 preferred model

Browser/client code MUST NOT be trusted to select an arbitrary Storage path and then create a chat attachment row independently.

The preferred flow is server/RPC mediated:

1. authenticate caller;
2. authorize conversation access;
3. create or reserve the chat message/attachment identity;
4. construct the canonical Storage path from trusted database identifiers;
5. validate MIME type and size;
6. upload to `powerhub-private`;
7. create the attachment metadata row transactionally where possible;
8. audit the attachment creation.

If direct authenticated client upload is later enabled for performance, the Storage `INSERT` policy MUST independently enforce the canonical namespace and authorization. Client-supplied `tenant_id`, `conversation_id`, or message identity MUST never be accepted as trusted authorization input.

---

## 6. Delete / update policy

Chat attachments are immutable from the application security perspective.

There is no v1 user-facing overwrite operation.

- `UPDATE` should be denied for chat attachment objects.
- `DELETE` should be denied to normal tenant users.
- deletion/cleanup should be performed only by an authorized server-side workflow after validating the attachment row and conversation authorization.

This avoids object replacement attacks and prevents a user from swapping the content behind an existing attachment metadata record.

---

## 7. MIME type and size enforcement

The bucket currently enforces:

- JPEG
- PNG
- WEBP
- PDF
- 10 MB maximum

The chat database contract additionally stores `mime_type` and `size_bytes`.

Application/RPC validation MUST ensure the DB metadata does not contradict the uploaded object.

The client-provided filename and MIME type are untrusted input. The implementation should validate the actual upload metadata/content as appropriate for the chosen upload path and must never use filename extension alone as a security control.

---

## 8. Path traversal / namespace controls

Storage paths MUST be normalized before use.

Reject or never construct paths containing:

- `..`
- empty tenant/conversation/message identifiers
- absolute filesystem paths
- an unexpected bucket
- a path outside `chat/`
- a conversation ID that does not belong to the supplied tenant ID
- a message ID that does not belong to the conversation

The server should construct the path from validated numeric IDs rather than accepting a full path from the browser.

---

## 9. Listing policy

Chat clients do not need unrestricted bucket listing.

`storage.objects` listing of `powerhub-private` MUST NOT be granted merely because a user is authenticated.

Chat attachment lists should be obtained from `public.chat_message_attachments` through its own RLS/RPC authorization, then individual files are resolved to signed URLs.

This prevents Storage enumeration from becoming a cross-tenant information-disclosure channel.

---

## 10. Storage and database consistency

The following invariant is required:

`chat_message_attachments.storage_bucket = 'powerhub-private'`

and the object must correspond exactly to the attachment metadata.

The DB layer should enforce:

- attachment message belongs to the conversation;
- attachment conversation belongs to the tenant;
- attachment creator is a valid user;
- storage path uses the same tenant/conversation/message IDs;
- bucket is the approved private bucket.

An object without a corresponding authorized DB attachment record MUST NOT be exposed through the application.

An attachment record pointing to an object outside the canonical namespace MUST be considered invalid and inaccessible.

---

## 11. Service-role boundary

The existing server storage helper uses the trusted Supabase server client and signs private objects server-side.

This is acceptable only behind an application authorization boundary.

The helper MUST NOT become a generic public endpoint such as:

`GET /storage/signed-url?path=<arbitrary-path>`

without authorization.

Any future signed-URL endpoint must accept an attachment/message identifier, derive the trusted path from the database, re-check authorization, and only then sign the object.

The Supabase service credential remains server-only and MUST never be exposed to the browser.

---

## 12. Required RLS policy shape

The eventual executable Storage policies must satisfy these properties:

### SELECT

- authenticated only;
- bucket must equal `powerhub-private`;
- object must belong to canonical `chat/` namespace;
- access must resolve to an authorized chat attachment;
- tenant users require current tenant/conversation authorization;
- Support users require explicit `manageSupportChat` authorization.

### INSERT

Preferred v1: no direct browser insert policy for chat objects; use the server/RPC upload boundary.

If a future direct-upload path is approved, `WITH CHECK` must validate the complete authorization/path contract.

### UPDATE

Denied for chat objects in v1.

### DELETE

Denied for normal users; server-controlled cleanup only.

---

## 13. Realtime interaction

Storage object URLs MUST NOT be broadcast through Realtime channels unless there is an explicit reason to do so.

Chat Realtime events should carry minimal identifiers, for example:

- `message_id`
- `conversation_id`
- `event_type`
- `created_at`

The client can then request an authorized signed URL when it needs an attachment.

This prevents long-lived or unnecessarily exposed URLs from becoming part of Realtime payload history.

---

## 14. Security abuse cases

The executable implementation must explicitly test:

| Abuse case | Expected result |
|---|---|
| Anonymous download | DENY |
| Anonymous upload | DENY |
| Authenticated user guesses another tenant path | DENY |
| Tenant user changes tenant ID in path | DENY |
| Tenant user changes conversation ID | DENY |
| Tenant user accesses attachment without DB row | DENY |
| Tenant user accesses another tenant attachment | DENY |
| Tenant user lists private bucket | DENY unless separately authorized |
| Tenant user overwrites chat attachment | DENY |
| Tenant user deletes chat attachment | DENY |
| `manageMessaging` only → Support attachment | DENY |
| `finance_admin` only → Support attachment | DENY |
| Platform admin shortcut without explicit Support capability | DENY |
| Support user without active capability | DENY |
| Authorized Support user → assigned/pending support chat attachment | ALLOW |
| Authorized tenant participant → own authorized chat attachment | ALLOW |
| Forged `created_by_user_id` | DENY |
| Forged storage path | DENY |
| Signed URL request for unauthorized attachment | DENY |
| Expired signed URL | DENY / expired |

---

## 15. Current Production findings

Read-only inspection of Production confirms:

- `powerhub-private` exists and is private;
- its configured limit is 10 MB;
- its configured MIME types match the approved v1 attachment set;
- there are currently zero objects under `powerhub-private` matching the `chat/` namespace;
- no chat attachment data has therefore been exposed by this feature yet;
- the current repository contains a server storage helper using `powerhub-private` and short-lived signed URLs;
- comprehensive `storage.objects` policy output did not expose any existing chat-specific policies.

Therefore Storage RLS for chat attachments remains a **security gate**, not a completed implementation.

---

## 16. Gate status

| Gate | Status |
|---|---|
| Existing private bucket reuse | PASS |
| Bucket size/type constraints | PASS |
| Canonical chat path defined | PASS |
| Tenant/conversation DB consistency | PASS by design |
| Server signed-URL boundary | PASS by design |
| Support capability contract | PASS by design / resolver not deployed |
| Storage RLS executable policies | BLOCKED — not deployed |
| Direct browser upload | BLOCKED — not approved |
| Production DDL | NOT APPROVED |
| Production Storage policy changes | NOT APPROVED |

**Conclusion:** Storage RLS Security Contract v1 is complete as a design gate. No Production Storage policy or chat database DDL has been applied by this step.

---

## 17. Next implementation gate

Before any Production migration:

1. finalize the executable `manageSupportChat` resolver;
2. finalize chat table migration;
3. finalize Storage `storage.objects` policies;
4. build isolated authorization tests for tenant/support/cross-tenant access;
5. verify signed URL endpoint cannot sign arbitrary paths;
6. apply only through reviewed Supabase migration;
7. run post-migration security verification in Production.
