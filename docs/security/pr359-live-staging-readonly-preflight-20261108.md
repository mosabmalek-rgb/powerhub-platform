# PR #359 — live Staging read-only preflight refresh (2026-11-08)

> Evidence-only checkpoint. **NOT AN APPROVAL TO APPLY**. This verification did not alter GitHub deployment protections, Staging, Production, or the migration ledger.

## Pinned GitHub snapshot

- Repository: `mosabmalek-rgb/powerhub-platform`; PR #359: open, draft, mergeable, not merged.
- Source HEAD before this evidence-only commit: `e8f425a788b273eddf8de5a1b7b247b57d0db47b`.
- `main` base SHA: `6356ed4c0d58506adc87d9a000855e9d913aefcf`; comparison status `ahead`, 2018 ahead and 0 behind.
- The four pull-request workflow runs exposed for this SHA by the GitHub integration each concluded `success`: PowerHub CI, Reading Cycle PostgreSQL Integration, PowerHub Security, and PowerHub Supabase Admin Guard. Other checks must be separately confirmed for any newly created SHA; prior-head CI does not carry forward.

## Live Staging catalog/ledger checks (read-only)

Target Supabase project: `iyuryuhaylhisjfcrwkz`.

- `supabase_migrations.schema_migrations`: 424 rows; 12 rows have NULL/empty `statements`.
- No rows match **either canonical version or migration name** for the nine release candidates documented in `pr359-nine-migration-release-gates-20261108.md`. This verifies ledger absence, not that the target schema is safe for automatic application.
- Supplier ACL preflight: all 10 candidate tables exist, all have RLS enabled, and all preserve `service_role` table SELECT. Exactly 8 of 10 retain `authenticated` table and column SELECT; the two without it are `supplier_purchase_returns` and `supplier_purchase_return_lines`. No table SELECT for `anon` was observed for any of the ten.
- Staging `chat_messages_select_conversation_access` is a SELECT policy for `authenticated`: support-capability arm requires a matching `chat_conversations` row with the same conversation and tenant and `conversation_type = 'support'`; the ordinary read arm requires `visibility = 'public'` and `private.chat_rls_can_select_conversation`.
- Staging `chat_message_receipts_select_access` checks linked message/conversation and recipient, sender, or support capability; this was **only catalog inspection**, not a credentialed isolation test.
- Checked source of `20261107150000_powerhub_supplier_browser_read_acl_revoke.sql`: its loop includes all ten tables, revokes table privileges and per-column SELECT from `PUBLIC`, `anon`, `authenticated`, checks browser and service-role privileges, and requests a PostgREST schema reload. **No revoke was executed.**
- Checked source of `20261108120000_powerhub_chat_message_support_scope_read_hardening.sql`: it replaces the named Chat SELECT policy with a support-conversation-scoped capability arm; **no policy was changed**.

## Release path and blockers

- `.github/workflows/supabase-migration-release.yml` on `main` is a `workflow_dispatch` workflow and enforces `github.ref == refs/heads/main`, a reviewer-protected `supabase-staging` environment restricted to main, immutable PR SHA, and a single selected migration from `source_pr_number=359` for Staging. It does not accept PR-sourced Production migrations.
- The GitHub connector exposed during this review has **no workflow-dispatch operation**. Do **not** use direct Supabase `apply_migration` or manual ledger edits as a substitute.
- Historical 28-name crosswalk: two Staging names have evidence-backed implementation/SQL equivalence with different versions; the remaining 26 need their own object/behavior decisions. Twelve empty-statement Staging records have catalog evidence but do not establish exact historical SQL execution.
- Before revoking supplier browser reads: verify deployed UI/API consumers with isolated credentials, direct PostgREST denial, tenant/site boundaries, and server-only service-role behavior. Before accepting Chat: verify role/tenant/support/participant/visibility tests with synthetic users. Neither behavioral test was performed in this review.
- Do not treat earlier `READY` Vercel previews (different SHAs) as acceptance of this source HEAD; validate all four Preview Supabase bindings including the service-role association before a **single** new acceptance preview.
- Before any approved Staging dispatch, recheck **current** PR HEAD/main comparison, same-SHA CI, target ledger, file version/name and SQL hashes, migration dependency ordering, and human GitHub environment approval. Release one file at a time and verify postconditions. Production requires an independently approved release from main after successful Staging/Preview and explicit merge/release authorization.

## Change-control declaration

This checkpoint is source documentation only. No merge, force push, database DDL/DML, schema_migrations repair, financial or SMS operations, or Vercel deployment was carried out by the verification.

## Follow-up: exact supplier site-scope prerequisites (source HEAD `485b4bc6fff338bff7c172cb53c0f0e8787481a5`)

- GitHub PR #359 remained `OPEN / DRAFT / mergeable`, with `behind main=0`; all four primary CI workflows for this exact SHA completed successfully.
- Ran a **read-only** `pg_class` / `pg_attribute` comparison against the seven exact supplier tables and their required columns as listed by the **first** security migration's `$preflight$` block. Every table exists, all seven have RLS enabled, and the query returned an empty list of missing columns for every table.
- Ran a **read-only** catalog dependency query: `private.powerhub_has_site_access(bigint,bigint)`, `public.users`, `private.platform_capability_policies`, `auth.uid()`, `private.powerhub_has_platform_capability(text)`, `private.powerhub_has_company_account_capability(bigint,bigint,text)`, `public.powerhub_enforce_field_user_quota()`, `public.powerhub_resolve_tenant_feature_policy(bigint,text)`, and `private.chat_rls_can_select_conversation(bigint,bigint)` all exist. All four specified `public.users` identity columns exist.
- Re-read the forward-only Phase D financial-details and supplier-payables-aging migration sources: both guard allocation-to-supplier/site integrity and reject inconsistent references. These files have not been executed as part of this follow-up.
- These checks are **prerequisite/catalog evidence**, not a test of SQL apply transactions, actual end-user credentials, object-level equivalence for the historical migration crosswalk, or a Staging release approval. The nine release candidates remain blocked pending the gates described above.
