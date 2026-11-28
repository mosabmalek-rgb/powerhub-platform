# PR359 R0 — Managed-schema exact parity and service migration provenance

Date: 2026-11-19. **R0 IN PROGRESS, NOT ACCEPTED.** All hosted database probes were read-only. No app-data SQL or hosted migration-ledger modifications.

## Proven status at SHA ef05e495c2822590fd57374b0dd386e4159a459b

PowerHub CI, PowerHub Security, Reading Cycle PostgreSQL Integration, Supabase Admin Guard, and B5 passed; Docker Smoke passed. Docker Full Restore **FAILED** as designed at the new pre-app-schema fail-closed checkpoint `verify-managed-catalog-pre-application`. Run: `44597692288`, real-restored-finance job `135820485818`. The comparator reported `sourceCols=386 dockerCols=39 missing=348 incompatibleTypes=0`, with missing Auth 235, Storage 91, Realtime 22. No app schema or business data was restored in this run.

## Further R0-only verification

Read-only pg_catalog enumeration on Production: **40 managed tables and 386 columns** (Auth 27 tables/273 columns, Realtime 3/22, Storage 10/91). Staging: **47 managed tables and 463 columns** (Auth 27/273, Realtime 10/99, Storage 10/91). Difference in Realtime is seven tables/77 columns; this needs a real structural review instead of assuming both hosted environments are managed-schema-identical.

Source migration ledger high-level metadata (not app migrations):
- Both: `auth.schema_migrations` 84 rows; earliest lexicographic `00`, latest `20261030120000`.
- Both: `realtime.schema_migrations` 97 rows; earliest `20211116024918`, latest `20261111120000`.
- Both: `storage.migrations` 81 rows; earliest lexicographic name `add_owner_id_column_deprecate_owner`, latest `vector-buckets`.
- **Equal row counts and extrema do not establish identical migration sets, ordering or binary/service compatibility**. This is an R0 read-only observation only.

The managed audit field `auth.audit_log_entries.ip_address` was confirmed `character varying(64)`, NOT NULL with the same default in both environments. The prior local-only type correction yielded zero type mismatches, but never fixed the missing full service schema.

## Hardened comparator

- `scripts/pr359-shadow/check-managed-catalog.mjs`: now requires bidirectional exact column-name/type parity, detects extra as well as missing tables/columns, categorizes missing/unexpected metadata by schema. It fails closed; no allowlist bypass.
- `scripts/pr359-shadow/check-managed-catalog.test.mjs`: includes tests for unexpected Docker tables/columns, extra field in an existing table, missing managed tables, exact identity and existing type-drift tests.
- `scripts/pr359-shadow/run.sh`: pre-app-schema and post-app-schema comparisons remain mandatory.

**Scope of proof:** Catalog parity on columns alone is necessary, not sufficient: table definitions, constraints, indexes, extension versions, triggers, RLS, privileges, Auth/Storage/Realtime migration history and service runtime compatibility must also match for a certifiable restore. Source catalog parity might itself differ between hosted Production and Staging despite equal Auth/Storage migration row counts. Never use an arbitrary local image or guessed generated Auth tables to fabricate parity.

## R0 acceptance plan

1. Inspect exact managed migration version/name sets and source table diffs using **read-only** catalog SQL, including Realtime partition metadata; record structural evidence without exposing personal records.
2. Select a provider-managed service schema initialization method with pinned Auth/Storage/Realtime binaries or migration bundles, in a truly isolated, disposable environment. A plain `supabase/postgres` DB image alone is insufficient; full `supabase start` is a candidate only after pinning, isolation and catalog compatibility checks.
3. Verify full managed SQL parity (including constraints/triggers/ownership) and Data API/role compatibility; never omit the 348 missing columns or relax the comparator.
4. Only after parity: apply app schema, rerun parity, restore data into isolated container, prove counts/accounting/Auth/RLS/invariants on two independent restores plus deliberate failed upgrade/recovery.
5. Keep unrelated R0 blockers open: missing Staging RPC contracts, SECURITY DEFINER review, ownership classification and migration Epoch v2.

**Gates:** `R0_ACCEPTED=false`, `BACKUP_RESTORE_PASS=false`, `STAGING_INPLACE_GO=false`, `PRODUCTION_INPLACE_GO=false`, `PR359_MERGE_GO=false`. Do not infer final-SHA CI results from earlier source SHA.

## Read-only follow-up: Realtime discrepancy explained (partition lifecycle)

Inspected `pg_class`, `pg_namespace`, and `pg_inherits` for `realtime` in both hosted projects. **Both** have the same three base relations: `realtime.messages` (partitioned parent, 11 columns), `realtime.schema_migrations` (2 columns), and `realtime.subscription` (9 columns). Staging additionally has seven managed child partitions, all owned by `supabase_realtime_admin`, all **11 columns** and attached to parent `realtime.messages`:

`messages_2026_11_14`, `messages_2026_11_15`, `messages_2026_11_16`, `messages_2026_11_17`, `messages_2026_11_18`, `messages_2026_11_19`, `messages_2026_11_20`.

These account exactly for Staging's **7 extra managed tables and 77 extra columns**. This is **lifecycle-managed Realtime partition drift**, not proven incompatible base schema. Future comparator design should explicitly distinguish deterministic **base schema parity** from separately validated **partition topology and data coverage**. Any normalization must verify partition parent, ownership, attached ranges, uniqueness/overlaps, data coverage, and restore behavior, and must not blanket-ignore unmatched provider tables. Current strict comparator intentionally remains unchanged pending tested partition-aware policy. Production's absence of these partitions does not authorize creation or deletion of partitions in R0.
