# PowerHub PR #359 — R0 provider-managed Supabase stack compatibility matrix

**Date:** 2026-11-19  
**Decision:** `CLI 3.2.0` is the preferred **disposable-stack research candidate**, **NOT an accepted Production restoration target**. R0 remains IN_PROGRESS; R1 NOT STARTED. No remote DDL/DML, Auth user changes, SQL ledger repair, SMS, merge or deploy.

## 1. Exact evidence (GitHub Actions)

Disposable workflow `PR359 Isolated Supabase Managed Stack Probe`, [run 44606591505](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/44606591505), both matrix jobs passed **initialization and metadata-only tests**. Both were run with temporary local configuration, no hosted credentials, localhost-only published ports and cleanup.

| Catalog/ledger measure | Hosted Production | Local CLI 2.122.1 | Local CLI 3.2.0 |
|---|---:|---:|---:|
| Auth relations | 27 | 27 | 27 |
| Auth columns | 273 | 271 | **273** |
| Auth migration rows | 84 | 82 | **84** |
| Storage relations | 10 | 10 | 12 |
| Storage columns | 91 | 91 | 109 |
| Storage migration rows | 81 | 75 | **81** |
| Realtime relations (incl. partitions) | 3 | 8 | 8 |
| Realtime columns | 22 | 71 | 77 |
| Realtime migration rows | 97 | 91 | **97** |
| Source columns missing locally | — | 21 | **0** |
| Unexpected local columns | — | 68 | 73 |
| Shared-column type mismatches | — | 0 | **0** |
| Service ledger missing versions | — | 14 | **0** |
| Service ledger unexpected versions | — | 0 | **0** |
| Recorded Storage migration checksum drift | — | 0 | **0** |

**Strict parity remains false** for both local CLI versions because of differences, including extra provider-managed tables. No application schema or source business data was restored by this experiment.

### CLI 3.2.0 exact ledger source SHA-256 matches

| Service | Hosted Production and Staging | Local CLI 3.2.0 |
|---|---|---|
| Auth | `7d1e01029991ce9b74e9c9d06cfccc84d4e7680ecde561f487f416d4996f87b5` | same |
| Storage | `be5018da6fa9bc7c7e906420fd91e96b86026d32cf557ee036632074597c61d4` | same |
| Realtime | `c446b0b124531009c0d17e544fc3a9acef3a522a70d9a0c6138ace6af47f1633` | same |

This confirms exact service migration record equivalence, not an exact service binary/configuration/DDL or behavior match. Data source is read-only recorded metadata, not Auth identities, secrets or business rows.

## 2. Remaining managed relation topology differences, proven by isolated tests

At CLI 3.2.0, the **seven** locally present tables missing from Production's managed relation set were classified using actual `pg_class`/`pg_inherits` metadata:

**Five daily Realtime partitions** with owner `supabase_realtime_admin`, parent `realtime.messages`, and verified one-day contiguous bound per partition:
`realtime.messages_2026_11_18`, `messages_2026_11_19`, `messages_2026_11_20`, `messages_2026_11_21`, `messages_2026_11_22`. These contribute 55 extra columns. Production has no such attached partitions in the recorded snapshot; Staging has seven *different* date partitions (2026-11-14 through 2026-11-20). Supabase Realtime documentation describes `realtime.messages` daily partition lifecycle: https://supabase.com/docs/guides/realtime/broadcast .

**Two other Storage provider-managed relations** not present in hosted Production:
`storage.iceberg_namespaces` and `storage.iceberg_tables`. These contribute 18 extra columns. They are **not daily partitions** and are a material unresolved provider feature/configuration difference, even with identical `storage.migrations` records. Supabase Storage supports Iceberg catalog functionality: https://supabase.com/docs/guides/storage/analytics/connecting-to-analytics-bucket .

The independent topology check reports CLI 3.2.0 `sourceRelations=40 localRelations=47 missing=0 sharedDrift=0 dailyRealtimePartitions=5 otherExtraRelations=2`. It does NOT blanket-ignore any extra; strict equality still FAILS.

## 3. Code and evidence additions

- `docs/security/pr359-r0-prod-managed-source-reference-20261119.json`: metadata-only 386 Production columns plus 262 recorded managed service migrations; Staging migration contents independently verified identical.
- `docs/security/pr359-r0-prod-managed-topology-reference-20261119.json`: metadata-only Production Auth/Storage/Realtime relation ownership and partition topology.
- `scripts/pr359-shadow/local-managed-reference-comparison.mjs`: read-only metadata comparison; source reference remains pinned to Production.
- `scripts/pr359-shadow/managed-relations.sql` and `compare-managed-topology.mjs`: explicitly classify daily Realtime partitions and nonpartition extra tables without changing full-restore behavior.
- Negative regression tests and isolated probe workflow for CLI `2.122.1` and `3.2.0`.

## 4. Strict follow-up requirements

1. **Storage Iceberg delta:** determine and verify migration/feature-init provenance and absence of production-required objects, and whether extra tables can safely coexist on isolated restore target without changing data paths. Do not delete extra managed tables to manufacture equality.
2. **Realtime:** prove daily partition ranges, owner, parent, no overlap, retention and data coverage; keep lifecycle partition compatibility separate from core schema parity. Do not copy partitions blindly.
3. **Full managed schema:** compare constraints, indexes, triggers, grants, default privileges, RLS, policies, function bodies, extension versions, runtime service binaries and versions; metadata column parity alone is not sufficient.
4. **Restored copies:** only after an independently approved provider compatibility design, run two isolated source restores and rollback/recovery, including financial and Auth behavior. Preserve no real SMS, secrets and local Outbox.
5. **Other R0 blockers:** resolve 19 missing Staging RPC contracts, Auth trigger divergence, SECURITY DEFINER review, object ownership and Epoch v2 design. Retain original `supabase_migrations` history.

**Gates stay:** `R0_ACCEPTED=false`, `R1_STARTED=false`, `BACKUP_RESTORE_PASS=false`, `PRODUCTION_SHADOW_UPGRADE_PASS=false`, `PR359_MERGE_GO=false`.
