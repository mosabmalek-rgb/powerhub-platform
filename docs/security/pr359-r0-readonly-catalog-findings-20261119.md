# PowerHub PR #359 — R0 read-only catalog audit (partial evidence)
**Captured:** 2026-11-19. **Baseline SHA at start:** `1e698ed838dbd2e80db1d0df527b4e8bb3ee7135`.  
**Scope:** read-only Supabase catalog SQL and GitHub repository inspection. **Decision:** R0 NOT ACCEPTED; no live DDL/DML, reset, deployment, or merge.

## Verified status
Both project refs remain ACTIVE_HEALTHY: Production `vvcdiqcyhaloxesvpppc` (PostgreSQL 17.6.1.155) and Staging `iyuryuhaylhisjfcrwkz` (PostgreSQL 17.6.1.166). The PR remains open/Draft/unmerged. At the baseline SHA, PowerHub CI, PostgreSQL Integration, Admin Guard, and B5 passed; PowerHub Security and Docker Shadow failed. Those failures are not waived.

## Live catalog counts
| Metric | Production | Staging |
|---|---:|---:|
| public tables | 145 | 173 |
| public functions | 389 | 579 |
| public indexes | 638 | 671 |
| public non-internal triggers | 82 | 202 |
| public RLS policies | 98 | 129 |
| public foreign keys | 462 | 548 |
| public SECURITY DEFINER functions | 182 | 296 |
| public SECURITY DEFINER executable by authenticated role | 17 | 34 |
| public SECURITY DEFINER executable by anon role | 0 | 0 |
| private tables | 7 | 10 |
| private functions | 46 | 57 |
| private SECURITY DEFINER executable by anon role | 3 | 0 |
| auth users | 4 | 7 |
| storage buckets / objects | 2 / 5 | 1 / 0 |
| cron jobs | 7 | 2 |
| migration rows | 486 | 553 |

All 145/173 public tables have RLS enabled. Respectively 54/75 have RLS enabled with no policies; this may be intentional deny-all and is not automatically a vulnerability. Private has 0/7 RLS tables in Production versus 3/10 in Staging; schema ACL and application pathways require independent review. Function EXECUTE role check alone does **not** establish direct RPC reachability: schema USAGE and API exposure also matter.

## Concrete boundary findings
1. Three application foreign keys target managed `auth.users` in both environments: `powerhub_user_device_locks_user_id_fkey`, `staff_password_reset_intents_auth_user_id_fkey`, and `users_auth_user_id_fkey`. Treat as SHARED_DEPENDENCY.
2. Production private SECURITY DEFINER functions with anon EXECUTE: `private.chat_after_support_conversation_create()`, `private.chat_notify_message_visibility()`, and `private.chat_prepare_support_conversation()`. Prior source-catalog review confirms anon lacks schema USAGE, so this alone is not a proven direct-call vulnerability. Verify ownership, trigger-only use, search_path, and effective ACL in R0.
3. `pg_net` extension is installed in `extensions` on Production (v0.20.4), **but in `public` on Staging** (v0.20.4). Never globally drop/recreate public without extension-aware dependency classification. Staging also has `pg_trgm` (v1.6) absent from Production; both have `pg_cron` 1.6.4.
4. Production has seven **active** cron jobs (`powerhub_chat_sla`, `powerhub-invoice-notifications`, `powerhub-payment-documentation-retention`, `powerhub-platform-announcements-publish`, `powerhub-subscriber-retention`, `powerhub-subscription-lifecycle`, `powerhub-subscription-lifecycle-archive`). Staging has two active (`powerhub_reconcile_expired_field_readers` and `powerhub-subscription-lifecycle`). The commands were fingerprinted with MD5 but not disclosed.
5. `supabase_realtime` publishes `public.powerhub_user_notifications` on both. Additional Staging `realtime.messages_*` publications are Supabase-managed partition objects, not PowerHub drop targets.
6. Production public has 638 indexes and Staging 671. Triggers differ significantly (82 vs 202) and require object-by-object comparison, not just counts.
7. GitHub branch `supabase/migrations` contains 700 SQL files; `drizzle/` contains 58 SQL files. Source-of-truth duplication must be resolved before a new epoch.

## Classification policy — provisional
- `SUPABASE_MANAGED`: provider-managed schemas including auth, storage, realtime, cron, vault, net, graphql, graphql_public, supabase_migrations; extension-owned objects anywhere (notably pg_net in staging public).
- `SHARED_DEPENDENCY`: PowerHub FKs targeting auth.users, PowerHub cron/publication integrations, policies/functions dependent on managed identity or storage.
- `APP_OWNED`: only explicit confirmed PowerHub objects after checking extension membership and inbound dependencies. **Do not equate all objects in public/private with app-owned.**
- `UNKNOWN`: each unreviewed object until per-object metadata and dependencies are examined. Remains blocking.

## Candidate Baseline/Epoch v2 (design, not execution)
Create a canonical app-object manifest from catalog + source contracts, select final behavior using Staging only as a candidate, and preserve legacy migrations in immutable Git archival form. Separate immutable historical ledger evidence from a **new protected Epoch-v2 deployment ledger** (version, SQL SHA-256, environment, predecessor SHA, state). Do not edit `supabase_migrations.schema_migrations` to fabricate applied versions. Test how the new executor coexists with Supabase CLI and how protected future migrations are reconciled in isolated Docker before endorsing a specific scheme. Avoid any `db push` to existing remote projects until this is proved.

## Required R0 closure
- Capture exhaustive per-object names, owner, extension membership, DDL fingerprints, columns, constraints, triggers, function signatures/search_path, ACLs/policies, and dependency edges for **both** projects in durable machine-readable manifests.
- Validate Staging public extension-owned objects and identify any other provider/extension members; review all SECURITY DEFINER RPCs and invoker security.
- Verify all source references to tables/RPCs in web, server, and Android; reconcile financial/RBAC/Delta contracts and old SQL histories.
- Resolve every UNKNOWN and obtain two-person review of destructive allowlist **before** R4; compile R1 backup/restore checklist and proof criteria.
- Capture full source SHA and evidence snapshot hashes after inventory is finalized; CI outcomes must be evaluated on that final SHA.

## R1 entry criteria
Separate logical SQL/schema and app data backup, Auth metadata and managed schema compatibility proof, Storage API object extraction where applicable, cron/extension/roles/grants snapshots, SHA-256 checksums, full isolated restore, and behavioral verification. Supabase Free does not waive restore proof.

**State: R0 IN_PROGRESS (partial catalog audit); R1 NOT STARTED; R4/R6 NO-GO; PR359 MERGE NO-GO.**
