# PR #359 — Field-user quota correction and Chat RLS drift review

**8 November 2026 — source-only changes / read-only live catalog inspection.**

This is an engineering evidence report, **not** authorization to apply SQL to Staging or Production. No live database ACL, RLS, migration history, or user data was changed.

## 1. Field-user quota: reproduced bug and corrected source

The existing `20260922123000_powerhub_unified_field_user_policy.sql` trigger counts an already-active technician in the quota but excludes that technician's **own current profile** from its `v_existing` query. Re-saving the same active technician at full quota thus raises `FIELD_USER_LIMIT_REACHED`. This was **reproduced** by the isolated GitHub PostgreSQL integration job, initially failing at `UPDATE public.staff_profiles SET is_active=true ...`; the error trace cited the actual guard function.

Additive source-only correction:

- `supabase/migrations/20261108111500_powerhub_field_user_policy_guard_update_and_concurrency.sql`
- `supabase/tests/field_user_unified_feature_policy_guard.sql`
- `.github/workflows/reading-cycle-sql-integration.yml`

The correction recognizes a same-tenant, same-user update of an existing active technician as consuming **no additional distinct-user quota**; it continues to check role changes, new identities, disabled/ineligible features and tenant-specific limits. It uses a **tenant-scoped transaction advisory lock** before checking the quota to serialize concurrent admissions, and pins `SECURITY DEFINER` to an empty search path. The preflight checks required dependencies and function owner/security; the postflight checks the trigger and role EXECUTE grants. The test reapplies the new migration in a **disposable** PostgreSQL database.

**Test evidence:** the initial test failed on commit `7251cdca51148648cc3232b9fba722bf6168164b`; the corrected isolated PostgreSQL workflow succeeded on `23fabdf21a251def03110b26b4e5362a6266aace`. This proves the current fixture path and assertions, **not** a live Staging migration, nor a two-session concurrency stress test.

### Existing live Staging discrepancy

Read-only `pg_get_functiondef` had shown that Staging currently uses the older `plan/legacyPlan` implementation of `powerhub_enforce_field_user_quota()`; Production uses `powerhub_effective_tenant_quota(..., 'fieldUser')`. Neither should be overwritten blindly. Live source of the `field_users` feature policy was checked in both environments: feature catalog row active, five package policy rows, zero tenant control rows. This source-only correction deliberately **does not** run in either live environment until historical/function-contract reconciliation and explicit user approval.

## 2. Chat SELECT RLS: read-only Production-vs-Staging difference

Live `pg_policies` and table-ACL reads found:

- **Staging** `public.chat_messages` SELECT policy: support-capability bypass restricted to a matching **support** conversation, or `visibility='public'` with `private.chat_rls_can_select_conversation(conversation_id, tenant_id)`.
- **Production** `public.chat_messages` SELECT policy: `private.powerhub_has_platform_capability('manageSupportChat') OR (... public visibility and current participant ...)`. The capability arm **does not itself restrict** the row to a support conversation or tenant. This mirrors the older `20260922180000_powerhub_chat_helpdesk_v2.sql` policy source.
- Both environments have RLS enabled and **authenticated SELECT** granted on `chat_messages`, `chat_message_receipts`, `chat_conversations`, and `chat_participants`. Neither environment grants anon SELECT to these four tables.
- Chat receipt and attachment SELECT policies also differ; the Staging receipts policy checks the linked message/conversation and recipient or sender/support role, whereas Production has broader role-specific alternatives. Live role/session-based behavioral verification is still required before determining exploitability.

**Security assessment:** Production's support-capability SELECT predicate is a **potential cross-tenant and non-support-message disclosure path**, because the capability branch is not constrained by the conversation identity. This is a policy-level risk, **not a demonstrated exploit**. Do not test with real users, extract messages, or change Production privileges during this review.

Recommended next **source-only / isolated-fixture** gate: verify tenant membership, support conversation type, active account, message visibility, receipt ownership, and platform-support exclusions for normal conversation types, then prepare a separate reviewed forward-only policy correction and safe rollout plan. Do not use a historical migration replay to modify the live RLS policies.

## 3. Release gates and decisions

1. Keep PR #359 OPEN / DRAFT; do not merge or force-push.
2. Retain the seven November 7 security migrations as **not authorized for application** to Staging/Production.
3. Require **same-SHA CI** after every change. PostgreSQL, Security and Supabase Admin Guard succeeded on the correction SHA; PowerHub CI was still in progress at the time of writing.
4. Separately verify multi-session quota concurrency, existing staff edits at the cap, policy resolver compatibility, Chat role/tenant isolation and rollback before requesting Staging approval.
5. Reconcile historical SQL ledger differences without rewriting `supabase_migrations.schema_migrations`.

**Source change is a candidate correction, not a production hotfix.**
