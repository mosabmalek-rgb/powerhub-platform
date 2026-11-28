# PR359 R0 — Auth trigger, server/Android Delta and canonical contract P0 review

Date: 2026-11-19  
Source: PowerHub branch `feat/auth-local-first-single-pr`; Android `mosabmalek-rgb/app-power-` default `main`.  
Scope: GitHub code inspection + **read-only** PostgreSQL catalog probes on `vvcdiqcyhaloxesvpppc` and `iyuryuhaylhisjfcrwkz`. No RPC invocation or data mutation. This is R0 evidence; **not** a code integration test.

## 1. Managed schema security / Auth identity

- Production has non-internal trigger `auth.users.on_auth_user_created_powerhub` invoking `private.powerhub_create_profile_for_auth_user()`. Staging did not have this trigger at capture. **P0 contract divergence**: inspect identity creation code paths and migration-defined replacement/bootstrap mechanism before selecting an Auth strategy. The presence/absence alone does **not** demonstrate a failing user creation.
- Storage has eleven provider-managed triggers in both environments; treat as managed and never include in app-drop allowlist.
- For role-accessible SECURITY DEFINER functions, read-only SQL checked both schema USAGE and effective EXECUTE: Production 32 authenticated-reachable signatures, Staging 52; **none** anon-reachable with both USAGE and EXECUTE. All these selected signatures have `search_path` configuration; this is not a full body-level RLS/security audit.
- Production RLS-enabled relation(s) without policies: 54; Staging 78 (75 public and 3 private). Private 7 tables in each project have RLS disabled, but checks showed no `anon` table SELECT grant for the selected sensitive cohort. Intentional deny-all may explain zero-policy tables; verify by functional role tests, not count alone.
- `pg_net` extension installation schema differs (Production `extensions`, Staging `public`). A follow-up catalog query found **zero directly extension-dependent objects in public/private/powerhub_private** under the examined `pg_depend` class and no `public` relation with name like `%net%`. This does NOT establish comprehensive dependency freedom (function/type/operator/dependency graph still must be reviewed); do not claim pg_net has publicly owned tables or functions without evidence.
- R0 snapshots are sequential, not a single repeatable-read transaction.

## 2. Server RPC/table contract existence check

Checked selected source references in `server/mobile-api.ts`, `server/mobile-delta-service.ts`, `server/powerhub-mobile-approval-supabase.ts`, and `server/powerhub-supabase.ts`. Full evidence:
`docs/security/pr359-r0-mobile-live-contract-matrix-20261119.json`.

| Required object | Production | Staging |
|---|---|---|
| `powerhub_mobile_create_field_reading` RPC | MISSING | present |
| `powerhub_mobile_delta_fence` RPC | MISSING | present |
| `powerhub_mobile_subscriber_projection` RPC | MISSING | present |
| `powerhub_site_access_snapshot` RPC | MISSING | present |
| `field_reading_distribution_settings` table | MISSING | present |
| `mobile_subscriber_change_log` table | MISSING | present |
| `powerhub_mobile_create_single_device_session` RPC | present | present |
| `powerhub_mobile_rotate_refresh_session` RPC | present | present |
| `powerhub_get_reading_cycle` RPC | present | present |
| `powerhub_cycle_for_reading` RPC | present | present |
| `powerhub_approve_and_issue_mobile_reading` RPC | present | present |

This indicates Production is not directly compatible with the examined **current source** mobile/Delta paths, consistent with the pre-release split. **Do not attempt legacy blind migration replay**: define the target schema and test from clean Bootstrap then Staging/Production with protected approvals.

## 3. Android ↔ Server HTTP contract: Delta adapter gap

Source `server/mobile-api.ts` includes `GET /api/mobile/v1/subscribers/delta` with bootstrap/cursor scope, as well as legacy `GET /api/mobile/v1/subscribers` maintained for older Android installs (comment near lines 725–728). The current default Android branch `app/src/main/java/com/example/data/api/FieldReadingApi.kt` exposes `getSubscribers` against the legacy endpoint only (around lines 108–109), not the new Delta endpoint. `FieldReadingRepository.kt` calls `api.getSubscribers(branchId,100,cursor)` in a full-page pagination loop (around line 284) then `dao.replaceSubscribersSnapshot(...)` (around lines 285–295).

This is a **current default-branch source compatibility gap**, **not proof** a different Android development branch is missing Delta. Before R0 acceptance inspect active Android PRs/branches and release artifact. A safe Delta client must consume typed scoped cursors, deletion/tombstone/revocation semantics, preserve local Outbox, and implement repeatable bootstrap and restore; do not replace existing snapshot behavior without integration tests. Verify `replaceSubscribersSnapshot` is transactional, preserves unsent pending operations, and handles denied/revoked access without leaking stale tenant data.

Source hashes checked:
- Android `FieldReadingApi.kt` blob `cda3e4b234b6faec160cf23d8b99745f0a5962f6`
- Android `FieldReadingRepository.kt` blob `6ab787048329b6ad88986705788f5ee5ac77fb39`
- Web `server/mobile-api.ts` blob `b1dc71a6be81565298236c6239c56911f5c95e71`
- Web `server/mobile-delta-service.ts` blob `94b0d6d162a81bd8ccb7c33cb74ca63464366ccc`

## 4. Preconditions for declaring R0 complete

- Resolve Auth creation trigger divergence (check both explicit profile creation and trigger timing + RLS) with isolated behavioral tests.
- Build exhaustive metadata and code contract crosswalk for all functions, financial and security critical paths, not only mobile subset. Validate RPC **argument names and types**, response type, SQL SHA, ACL/schema USAGE, security search_path, API exposure.
- Determine Android release/PR branch that will ship and audit Delta/Outbox logic on that exact commit.
- Resolve object ownership for app/provider/customized managed schemas and **all inbound/outbound dependencies**, including extension members/pg_depend, cron and publications, and validate per-object allowlist with a real graph.
- Finalize canonical schema and migration-epoch design *without modifying historical ledger*. Require tested backups and restore (R1), clean Docker (R3), and explicit approvals before Staging/Production app reset.
- CI final-SHA green gates are required for merge; do not mistake catalog enumeration for acceptance.

**Gate stays:** `R0_ACCEPTED=false`, `R1_STARTED=false`, `STAGING_INPLACE_GO=false`, `PRODUCTION_INPLACE_GO=false`, `PR359_MERGE_GO=false`.

## Follow-up: Android release branch inspection
Verified Android `FieldReadingApi.kt` on `release/signed-1.5.4`, `release/official-1.5.4-cycle-guard`, and `build/official-release-1.5.3`: **none** declares `/subscribers/delta`; all use the legacy `/subscribers` endpoint. Corresponding content blob SHAs: `4c01e35d9e8765e96b9ce99bc2b709ef436a4577`, `cda3e4b234b6faec160cf23d8b99745f0a5962f6`, and `4c01e35d9e8765e96b9ce99bc2b709ef436a4577`. This verifies a gap on the **three examined release/build branches**, not all uninspected branches.

Security advisors were checked read-only on both projects and reported `rls_enabled_no_policy` informational findings matching the observed 54 Production and 78 Staging catalog counts. Reference: https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy . This count is not proof of a vulnerability; deliberate service-role-only tables can have no RLS policies. Evaluate privilege grants and behaviors individually.
