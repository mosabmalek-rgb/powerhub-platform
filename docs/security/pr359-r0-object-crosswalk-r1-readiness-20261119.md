# PR359 — R0 object-level catalog reconciliation, evidence & R1 handoff
Date: 2026-11-19  
Start-of-round SHA: `11c676b85cbd5009b93820aab0c72ac2743596da`  
**Status: R0 IN_PROGRESS, NOT ACCEPTED. R1 NOT STARTED. No destructive SQL.**

## Durable machine-readable evidence

For each environment (`production` and `staging`), four catalog files have been generated from read-only PostgreSQL system-catalog queries:

- `docs/security/pr359-r0-<environment>-relations-20261119.json` — tables/sequences, columns/types/default SHA, ownership, RLS flags, table ACL SHA, extension membership.
- `docs/security/pr359-r0-<environment>-functions-20261119.json` —  function signatures/returns/volatility/search_path config, owner, SECURITY DEFINER, effective role EXECUTE checks, definition/ACL SHA-256.
- `docs/security/pr359-r0-<environment>-indexes-constraints-20261119.json` — indexes with validity/uniqueness and constraints with referents/validation/definition SHA-256.
- `docs/security/pr359-r0-<environment>-policies-triggers-20261119.json` — policy command/role/expression SHA-256, triggers/target functions/definition SHA-256, including managed Storage/Realtime catalog policy metadata.

Cross-environment object key and fingerprint differences are recorded in
`docs/security/pr359-r0-cross-environment-crosswalk-20261119.json`.

**Important:** JSON classification `APP_OWNED_CANDIDATE` is *provisional*, not an approved drop allowlist. Manifest files are snapshots over sequential SELECT calls, **not transactionally atomic** and are not attested to be unchanged during capture. Hashes prove consistent representations of values, not SQL semantics, migration provenance or permission isolation.

## Object-by-object crosswalk (Production vs Staging)
| Object class | Production entries | Staging entries | Production-only keys | Staging-only keys | Shared keys with different metadata |
|---|---:|---:|---:|---:|---:|
| Relations/sequences | 290 | 337 | 0 | 47 | 78 |
| Functions (signature keys) | 440 | 641 | 68 | 269 | 172 |
| Indexes/constraints | 1,818 | 2,125 | 76 | 383 | 12 |
| Policies/non-internal triggers | 199 | 350 | 23 | 174 | 15 |

**Total catalog records:** 6,200 across eight files (not unique objects).
All comparison outputs are per object identity, with independent SQL-side SHA-256 for indexes/constraints to avoid GitHub tool truncation.

### P0 observations for the Canonical Baseline
1. Staging has 47 more relation/sequence keys, with no Production-only keys in this group, but Production retains 68 function signatures absent in Staging. **Do not simply clone Staging**; investigate compatibility/retired overloads.
2. 172 common functions differ in metadata; split differences by SQL body, ACL, owner, security settings. All financial RPCs and permissions need an explicit application-contract decision.
3. Catalog paths indicate 174 policy/trigger keys in Staging absent in Production, compared with 23 the other way. Changes may represent intentional expanded RLS and Delta trigger coverage; test actual tenant and site isolation.
4. Staging `pg_net` resides in `public`, Production in `extensions`; recognize extension-owned objects in shared schemas before any hypothetical app reset.
5. Three public app FKs to `auth.users` are SHARED_DEPENDENCY. Auth/Storage/cron/Realtime and extension schemas are not authorized drop targets.
6. Previous read-only catalog findings showed 3 Production `private` SECURITY DEFINER functions with role-level `anon` EXECUTE but `anon` lacks private-schema USAGE. No vulnerability claim follows without API-exposure and direct-call tests.
7. Source contains 700 SQL migrations under `supabase/migrations` and 58 additional historical SQL files under `drizzle`. Epoch v2 cannot be accepted before a single source-of-truth decision and ledger-safe migration executor proof.

### Remaining acceptance blockers within R0
- **UNKNOWN ownership**: resolve and sign off every item across app, provider-managed and mixed/customized managed schemas; take extension dependency registry and inbound cross-schema graph, including function dependencies.
- **Canonical Baseline**: link latest web/server/Android references to the required tables, RPC signatures, triggers, policies, grants, and data contracts. Historical 85 no-SQL and 28 mismatch cohorts remain evidence gaps, not automatic applied proof.
- **SQL safety**: audit SECURITY DEFINER functions with executable rights, pinned search_path, exposure and cross-tenant authorization; examine tables with RLS and no policies for intended deny-all semantics.
- **Snapshot integrity**: regenerate stable SHA-256 hashed manifest from a consistent snapshot or maintenance window. Record git SHA at source and final commit, plus repeatable SQL commands and evidence hash. Current files are useful partial R0 evidence but not fully atomic attestation.
- **Boundary services**: finalize dependency inventory of Auth, Storage, Realtime, pg_cron, pg_net, Vault, API grants and Android Outbox; classify active jobs and downstream service configs.
- **Pre-R1 decision**: decide handling of test Auth identities, Storage objects (Production 5), device locks and local offline cache. No deletion or data migration before explicit phase approval.

## R1 backup/restore preparation — checklist only, not executed
1. Pin source SHA, catalog manifests, configuration/extension versions, roles/ACLs and list SQL commands/hashes. Validate read-only database access and export destination outside Git.
2. Create logical schema/data backups for the application and historical migration-ledger **evidence**. Capture Auth configuration and compatible managed-schema backup metadata without unsafe provider-managed restore.
3. Export all Storage object bytes via authorized Storage API, plus object keys/metadata/checksums; metadata-only `storage.objects` dump is insufficient.
4. Record pg_cron job schedules and command hashes, policy and publication metadata, provider integration configuration (no keys/secrets in repository). Capture all required extension versions and Auth managed-schema version compatibility.
5. Restore into an isolated *compatible Supabase stack*; account for the prior auth catalog schema mismatch with Docker. Run exact checksum/count checks and functional finance/Auth/RLS tests before certifying restore.
6. Design protected fail-closed restore/recovery runbook. Emit `BACKUP_RESTORE_PASS` only with verified complete logs, SQL SHA, no real SMS, correct tenant isolation, replayable repeatability and preserved offline Outbox semantics.
7. Keep Production untouched and no Staging teardown until R1 + R2 + R3 have independent acceptance evidence.

**Gate:** `R0_ACCEPTED=false`, `R1_STARTED=false`, `STAGING_INPLACE_GO=false`, `PRODUCTION_INPLACE_GO=false`, `PR359_MERGE_GO=false`. All CI must be verified on the final SHA. Failed Security/Docker workflows are not waived.
