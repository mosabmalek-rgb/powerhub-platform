# PowerHub PR #359 — R0 P0 closure backlog, extension ownership and Docker Shadow blocker

**Date:** 2026-11-19  
**Source SHA before this report:** `a2a2f4d35187b25cedf133ce291a411a9ea9055e`  
**Phase decision:** `R0_ACCEPTED=false`; `R1_STARTED=false`; `STAGING_REBASELINE_GO=false`; `PRODUCTION_REBASELINE_GO=false`.

## 1. Actual CI evidence at source SHA

| Workflow | Result |
|---|---|
| PowerHub CI | PASS |
| PowerHub Security | PASS |
| Supabase Admin Guard | PASS |
| B5 Synthetic Financial Load | PASS |
| Reading Cycle PostgreSQL Integration | PASS |
| PR359 Docker Shadow (disposable) | **FAIL** |

Docker Shadow run `44592232717`: `smoke` job passed, but `real-restored-finance` job `135801066349` failed in `Source hostname guard and 3 isolated Docker financial upgrades`. Log reports:
`PR359_SHADOW_MANAGED_SCHEMA_DRIFT: sourceCols=386 dockerCols=39 missing=348 incompatibleTypes=1`; 
`PR359_MANAGED_COLUMN_TYPE_DRIFT: auth.audit_log_entries.ip_address source character varying(64), docker character varying`;
`PR359_SHADOW_FAILURE_STAGE=verify-managed-catalog; EXIT_CODE=2`.

**Interpretation:** The protected Docker restore cannot yet establish managed Supabase Auth catalog compatibility. Stop and select a compatible local Supabase Auth schema image/baseline or an explicitly validated provider-managed compatibility adapter in an isolated copy. **Never bypass the gate by dropping all Auth columns, manually editing managed Auth, or accepting a partial restore.** This failure occurred after the application schema restore started; it does **not** certify financial restoration or full rollback. The Docker host had sufficient resources at time of error; this is a schema compatibility blocker, not demonstrated OOM.

## 2. Read-only schema classification updates

Exact SQL metadata evidence is committed at `docs/security/pr359-r0-extension-catalog-dependency-summary-20261119.json`.

- Production `pg_net 0.20.4` **extension namespace** is `extensions`, but its **member objects** reside in `net`: 3 `pg_class` members, 12 `pg_proc`, 12 `pg_type`; Staging extension namespace is **public** with the **same members in net**. The extension's catalog namespace and member object schemas are distinct. Do not relocate/reinstall/drop `pg_net` based only on `extension_in_public` warning. All `net` objects are protected as managed dependencies.
- `pg_cron` member objects reside in `cron` on both; `supabase_vault` member objects reside in `vault` on both. Staging-only `pg_trgm` 1.6 has operator/procedure/type membership in `extensions` and is absent from Production; baseline must explicitly decide if Staging text search relies on it.
- Direct `pg_depend` class-to-class edges from `public/private/powerhub_private` into Auth/Storage/Realtime/cron/net/vault were zero for the narrow inspected direct relation-dependency query. **This is NOT proof of no dependencies.** Three `public` foreign keys to `auth.users` are independently proven, and SQL-body function calls, triggers, extension membership and ACL integrations are outside that restricted edge query. A full transitive and expression/SQL-reference dependency map remains required.

## 3. Authenticated-executable SECURITY DEFINER review

Evidence `docs/security/pr359-r0-authenticated-definer-surface-20261119.json`: 32 signatures in Production; 52 in Staging with both authenticated schema USAGE and EXECUTE. All have `proconfig` search_path; most Staging functions use empty search_path; Production private helpers have various nonempty paths.

**Classification approach:** 
- `public.chat_*` and `public.powerhub_notification_*` are callable service endpoints and require behavioral tenant and member isolation tests.
- `private.*` and `powerhub_private.*` helpers may be intended as RLS helpers/trigger functions but must be checked for direct EXECUTE from the authenticated role, caller schema exposure and privilege boundaries.
- Lexical markers for `auth.uid()`, tenant/site names or dynamic SQL are triage hints only. Their absence is **not** a proven vulnerability; their presence is **not** sufficient to establish safety.
- Supabase Security Advisor currently flags 17 Production and 34 Staging public authenticated-executable definers. Review all listed signatures, grants and effective API exposure instead of blanket revocation. Preserve legitimate chat/notification invocations.

Useful docs: https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable ; https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public .

## 4. Staging missing RPCs — 19 live-name source-contract defects to resolve

Read-only crosswalk `docs/security/pr359-r0-core-rpc-live-crosswalk-20261119.json` shows 19 literal `.rpc` names required in scanned source files but missing from Staging `public`. A separate query confirmed none is defined in other non-system schemas in Staging. Production has 18 of them; `powerhub_payment_receipt_context` is missing from both.

| Domain | Missing from Staging |
|---|---|
| Branch management | `powerhub_create_site`, `powerhub_update_site`, `powerhub_update_site_anomaly` |
| Reading / subscribers | `powerhub_change_subscriber_lifecycle`, `powerhub_normalize_subscriber_phones`, `powerhub_update_pending_reading`, `powerhub_delete_pending_reading` |
| Dashboard / collectors | `powerhub_dashboard_reading_kpis`, `powerhub_dashboard_collector_performance`, `powerhub_open_collector_session`, `powerhub_close_collector_session` |
| Billing / receipting / SMS | `powerhub_payment_receipt_context`, `powerhub_reschedule_pending_invoice_sms` |
| Site portal | `powerhub_save_site_portal_settings`, `powerhub_update_site_portal_logo` |
| Accounting / settings / subscriptions | `powerhub_exceptional_locked_edit`, `powerhub_update_company_account_payment_visibility`, `powerhub_update_report_branding`, `powerhub_request_tenant_addon` |

These names appear in runtime source `server/powerhub.ts` and `server/powerhub-dashboard.ts`, not merely test fixtures. Individual routes may still be gated, unused, or have feature fallbacks; **reachable behavior has not been proven by an HTTP test**. Do not assume the old Production implementations are canonical or apply their original migrations verbatim.

Historical SQL source examples inspected:
- `supabase/migrations/0017_powerhub_collector_sessions.sql` defines `powerhub_open_collector_session` and `powerhub_close_collector_session` (source proof, not deployment proof).
- `supabase/migrations/0020_powerhub_exceptional_locked_edit.sql` defines `powerhub_exceptional_locked_edit` (source proof).
- `supabase/migrations/20261105091623_powerhub_security_performance_advisor_hardening.sql` explicitly documents pg_net's installed namespace versus actual `net` API objects and warns against moving it.
- `server/pg-net-migration-safety.test.ts` protects source migration expectations; it does not certify live extension state.

### Per-RPC closure rule
For each of these 19 RPC names, record owner, source migration(s), current source callers and feature visibility, required input names/types/defaults and output shape, tenant/site authorization, correct effective grants, planned outcome `KEEP_AND_RECONSTRUCT` | `REPLACE_WITH_TESTED_API` | `REMOVE_DEAD_CALLER`, and isolated tests. Missing does not mean safe to delete a route or to resurrect an obsolete SQL definition.

`powerhub_payment_receipt_context` is invoked during post-approval best-effort work in `server/powerhub.ts`. Missing function may degrade receipts/notification behavior even though approval is already committed. Verify UX and no false failure, and choose explicit supported behavior before R2.

## 5. Canonical Baseline decision — still pending

Keep as mandatory candidates:
- Contract-verified financial A/B/C/D (double-entry ledgers, refunds, close, reversal, source provenance, role/site scope).
- E staff RBAC, Auth trigger-free bootstrap **if isolated tests pass**, session revocation and feature gating.
- Android stable legacy mobile contract plus new Delta endpoints + durable Outbox/tombstones; do not silently break the active Android releases.
- Provider-managed schemas and extension-owned objects kept outside app destructive allowlist.

An acceptable Epoch v2 solution must preserve historical ledger evidence, isolate new migration history, and demonstrate a complete fresh install, repeatability and forward deploy in disposable environments *before* touching Staging. This document is a triage and acceptance specification, not a migration or approval.

## 6. Next unblockers
1. Run repeatable Auth-managed schema compatibility proof in disposable Docker with pinned Supabase versions. Do not ignore the 348 missing columns.
2. Resolve the 19 missing Staging RPC contracts by source tracing and isolated behavior acceptance, then confirm code-only compile gates.
3. Complete all `SECURITY DEFINER` body-level review and anonymous/authenticated/tenant/site negative tests.
4. Reconcile 85 unknown historical SQL payloads and 28 source/history groups **as provenance gaps** while building v2 from current runtime contracts, not by guessed historical replay.
5. Capture consistent atomic catalog snapshots, create object ownership/dependency allowlist under review, and prepare the separate R1 restore plan.

**No data was changed in Supabase Production or Staging by this R0 work. PR359 remains Draft; NO-GO for merge/deploy/reset.**
