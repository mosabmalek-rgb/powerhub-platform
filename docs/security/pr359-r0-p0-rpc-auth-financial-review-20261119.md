# PowerHub PR #359 — R0 P0 Auth, financial RPC and SQL security gate follow-up

**Date:** 2026-11-19  
**Working branch:** `feat/auth-local-first-single-pr`  
**R0 status:** IN_PROGRESS / NOT ACCEPTED. **No DDL/DML or RPC write calls executed.**

## 1. Immutable evidence created this round

- `docs/security/pr359-r0-core-rpc-live-crosswalk-20261119.json` — 251 literal call sites across 9 source files, 213 unique RPC names, public function signatures/ACLs in both live environments. Name existence only, no real RPC execution.
- `docs/security/pr359-r0-critical-rpc-argument-audit-20261119.json` — 27 high-risk financial, RBAC, inventory and mobile RPC names compared against PostgreSQL formal parameter names/types. 30 source call sites were statically sampled from 8 files. Postgres `proargmodes` text-array encoding was handled and three initially reported mismatches were manually rejected as **source-extraction false positives**, with their corrected call arguments documented. No remaining named-parameter discrepancy in this *limited audited sample* where a target function exists; this is not a full API acceptance test.
- Existing Auth review and Mobile/Delta docs remain valid and linked from PR.

## 2. Actual SQL/RPC crosswalk outcome

| Metric | Staging | Production |
|---|---:|---:|
| Distinct RPC names referenced in 9 scanned server files | 213 | 213 |
| Source RPC names missing from `public` | **19** | **64** |
| Names present but without effective service_role EXECUTE | 0 | 0 |
| Critical selected RPC names | 27 | 27 |
| Critical names missing in this database | **0** | **16** |

**CRITICAL:** The 19 Staging-missing names are real missing *names* in the checked public catalog; a second query searched other non-system schemas, also 0 hits for these names in Staging. Production has 18 of these; one `powerhub_payment_receipt_context` is not present in either environment. The affected Staging names include `powerhub_create_site`, `powerhub_update_site`, `powerhub_change_subscriber_lifecycle`, `powerhub_dashboard_reading_kpis`, `powerhub_dashboard_collector_performance`, `powerhub_open_collector_session`, `powerhub_close_collector_session`, `powerhub_payment_receipt_context`, and `powerhub_update_site_portal_logo`. **Do not certify Staging as the canonical runtime schema.** Check whether these source paths are reachable and whether branch-based feature gating/fallbacks are expected; do not silently omit them from Baseline.

Production lacks 64 of the scanned 213 names, including GL settlement/accounting, financial accrual, inventory auto-receipt and mobile Delta; differences reflect version skew, not permission to replay old migrations.

The 27 critical RPC signatures present in Staging include the named keys expected in the sampled caller objects after manual correction. Runtime behavior and response shape still require dedicated tests.

## 3. Authentication critical divergence: read-only body validation

Production has trigger `auth.users.on_auth_user_created_powerhub`:
`AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION private.powerhub_create_profile_for_auth_user()`.

The Production trigger function is PostgreSQL-owned, SECURITY DEFINER, configured `search_path=public, auth`, and performs `INSERT INTO public.users (auth_user_id,name,email,login_method) ... ON CONFLICT (auth_user_id) DO UPDATE` with `last_signed_in=now()` on conflict. The trigger is absent in Staging.

**Source-side target behavior conflicts:** `server/staff-auth-provisioning.ts` explicitly documents **no auth.users trigger**, and performs controlled staff `public.users` upsert with `must_change_password=true`, account-status checks, and compensation only after verifying assignments. `server/supabase-profile.ts` performs explicit bootstrap upsert and rejects missing profiles during ordinary GETs; `server/mobile-api.ts` also upserts profiles during mobile login.

**Impact/risk:** Production's old implicit auth trigger and the new explicit profile bootstrap can race or produce different created/updated timestamps/names. The trigger's blind `ON CONFLICT UPDATE` does not directly change role or password-reset fields but does modify email/name/last_signed_in. This is a **behavioral divergence requiring proof**, not a demonstrated account takeover or a reason to mutate Auth now.

**Canonical design candidate:** Use the explicit, idempotent bootstrap path adopted by the current server and Staging; keep managed `auth` schema provider-owned. Before accepting, prove `create staff -> explicit profile -> assignment`, `existing Auth -> new login/bootstrap`, `mobile login`, `invite`, `concurrent profile creation`, `failed assignment recovery`, and `revoked session/user` in isolated Supabase. Treat the production trigger as a SHARED_DEPENDENCY; never drop it during R0. Future removal, if proven necessary, requires an explicit protected sequence and separate approval under the R4/R6 stage gates.

## 4. Financial definition divergence

`public.powerhub_dashboard_financial_overview(bigint,bigint,timestamptz,boolean)` exists in both databases with pinned empty `search_path` and service-role EXECUTE. Live function SHA-256:
- Production: `37950a1a4c679c074b86e1adf102c5d9d2ea756de356c0247310c74cdc912f3a`.
- Staging: `da763042afc1818ea80bdd90e7698913b6a57017eede20e24c7726c8216d9cc8`.

Production body does not reference `invoice_applied_amount` or `payment_purpose`; Staging uses both. Preserve Staging's purpose-aware logic as **baseline candidate**, conditional on finance integration regression proving invoice/due/credit/receipt behavior across branches and tenant isolation. Not certified by metadata hash alone.

## 5. Supabase read-only security advisors

Production:
- 54 `rls_enabled_no_policy` INFO — https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy
- 17 `authenticated_security_definer_function_executable` WARN — https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable
- 1 `auth_leaked_password_protection` WARN — https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection

Staging:
- 78 `rls_enabled_no_policy` INFO — same remediation reference above
- 34 `authenticated_security_definer_function_executable` WARN — same remediation reference above
- 1 `extension_in_public` WARN — https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public
- 1 `auth_leaked_password_protection` WARN — same reference above

Security-advisor counts are not proven exploits; the 17/34 WARNs warrant function-by-function security review of schema exposure, effective grants, authorization checks and search_path, then tenant/branch HTTP tests. Never paper over the warning by simply revoking ACLs without consumer reachability analysis.

## 6. Remaining R0 blockers and protected sequencing

1. Review **all** required source paths and missing RPCs with primary caller reachability, default signatures, output schema, graceful fallback, and permission tests; the 9-file scan is not exhaustive.
2. Classify all objects based on ownership and complete forward/inbound dependency graph; no unresolved `UNKNOWN` allowed in a destructive allowlist. Pin extension membership even when installed in app schema; distinguish provider-managed Auth/Storage/Realtime vs customized integration objects.
3. Validate Auth trigger-free bootstrap in a compatible, disposable Supabase stack; no live reset, profile edits, user deletes or trigger changes.
4. Resolve financial dashboard and GL source ambiguity under isolated, idempotent, multi-tenant accounting acceptance scenarios.
5. Select protected Epoch v2 runner/coexistence strategy without writing historical migration ledger. Snapshot logical SQL, Auth/Storage metadata, extension versions, cron jobs; prove isolated restoration **before** any R4 action.
6. Generate stable atomic inventory hash and run all CI on the final SHA before final phase decision.

**State remains:** `R0_ACCEPTED=false`, `R1_STARTED=false`, `STAGING_INPLACE_GO=false`, `PRODUCTION_INPLACE_GO=false`, `PR359_MERGE_GO=false`.

