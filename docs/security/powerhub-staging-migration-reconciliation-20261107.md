# PowerHub — Staging Migration History Reconciliation

**Snapshot:** 7 November 2026  
**Repository snapshot:** \`850144da0b8b7234f440a92da0739cc9f3142628\`  
**Supabase project:** \`iyuryuhaylhisjfcrwkz\` (Staging only)  
**Method:** GitHub recursive tree + Supabase migration ledger read-only query. No migration was applied and no history row was changed.

## 1. Inventory

| Measure | Observed |
|---|---:|
| Canonical 14-digit migration files in repository tree | 502 |
| Legacy numeric migration files with non-14-digit versions | 77 |
| Total SQL files under `supabase/migrations` | 579 |
| Rows in Staging migration ledger | 424 |
| Exact Version + Name matches | 179 |
| Same Name, different Version | 91 local files |
| Local files with neither exact Name nor matching Version | 232 |
| Of those local unmatched files at/before latest Staging Version | 225 |
| Local files after latest Staging Version | 7 |
| Staging rows whose Name has no exact local filename match | 150 rows / 149 unique names |
| Staging duplicate-name groups | 5 |

Staging latest recorded version at snapshot: \`20261106224902\` (\`powerhub_payment_delta_purpose_projection\`).

The 91 name matches are not proof that the local SQL bytes equal the SQL previously executed in Staging. They are identity candidates only. No migration-content checksum is stored in the Supabase migration ledger, so equivalence requires source/history evidence and schema assertions.

## 2. Version drift

The 91 name matches have different local and recorded versions. Current classification:
- 39 local filenames sort before their Staging record.
- 52 local filenames sort after their Staging record.

This supersedes the earlier working estimate of 95 drift cases. The snapshot calculation is based on the 502-file recursive Git tree and the current 424-row Staging ledger.

## 3. Duplicate names in Staging

| Name | Recorded versions |
|---|---|
| \`powerhub_chat_helpdesk_v2\` | \`20260922090008\`, \`20260922090208\` |
| \`powerhub_reading_opening_baseline_save_fix\` | \`20261010161951\`, \`20261010170812\` |
| \`staging_restore_powerhub_submit_payment_documentation_source_destination_support_v2\` | \`20261012174547\`, \`20261012174856\` |
| \`powerhub_image_retention_metadata\` | \`20261101200609\`, \`20261102171227\` |
| \`powerhub_chat_feature_entitlements\` | \`20261101210557\`, \`20261102171243\` |

These are ambiguous history entries. Do not release any same-name migration until each group is reconciled against the migration source and resulting schema.

## 4. Staging-only names and normalization candidates

Of the 150 unmatched Staging rows:
- 12 names embed a timestamp prefix in the Name field.
- 53 names use a \`staging_\` prefix.
- 27 rows can be associated with an existing local migration by conservative name normalization (removing a recognized staging/replay prefix and/or embedded timestamp).
- 123 rows remain unmatched after that normalization.

Normalization is a discovery aid only. It is not authorization to rewrite migration history or to classify a migration as byte-identical.

## 5. Seven local files after the latest Staging record

| Version | File |
|---|---|
| \`20261107120000\` | \`powerhub_inventory_supplier_site_rls_scope\` |
| \`20261107130000\` | \`powerhub_inventory_phase_d_supplier_allocation_scope\` |
| \`20261107130443\` | \`powerhub_platform_support_identity_role_guard\` |
| \`20261107140000\` | \`powerhub_inventory_supplier_payables_allocation_scope\` |
| \`20261107143819\` | \`powerhub_company_account_capability_search_path\` |
| \`20261107150000\` | \`powerhub_supplier_browser_read_acl_revoke\` |
| \`20261107150951\` | \`powerhub_public_default_privilege_hardening\` |

All seven are later than the latest Staging ledger version. Their existence in Git does not establish whether equivalent SQL was applied under another historical name/version.

## 6. Content and dependency review completed

The seven files were read from the exact repository snapshot. Key contracts identified:
- Supplier branch/site restrictive read policies and allocation/document cross-scope checks.
- Phase D financial details and supplier-payables RPCs fail closed on malformed cross-branch allocations and are service-role-only.
- Platform capability helper requires active \`users.role='admin'\`, allowlisted platform role, and explicit capability policy; it pins empty \`search_path\`.
- Company-account capability helper preserves owner, SECURITY DEFINER, and authenticated/service_role EXECUTE while pinning empty \`search_path\`.
- Supplier direct browser table/column SELECT is revoked while service_role SELECT remains.
- Default privilege hardening is limited to objects created by \`postgres\`; it deliberately does not modify \`supabase_admin\` defaults or existing object ACLs.

Live Staging inspection found:
- Supplier tables have RLS enabled and service_role SELECT. Eight supplier-domain tables still grant authenticated SELECT; supplier return tables are already server-only. Existing permissive tenant/site policies are present. The pending migration \`20261107150000\` is designed to remove table and column-level browser grants after server-only route review.
- The live company-account capability helper still has its prior non-empty search_path. The new migration is not applied.
- The live platform capability helper still lacks the \`users.role='admin'\` predicate. This is the identity-hardening gap addressed by the new migration and regression test.
- Current postgres defaults in public/storage still include browser role grants; \`supabase_admin\` defaults are provider-managed and are not modified by the proposed migration.
- The default-privilege preflight currently finds no postgres-owned routines or function defaults in unreviewed schemas.

## 7. Release blockers and safe next actions

1. Run the new isolated PostgreSQL identity regression test for \`20261107130443\` on CI.
2. Review the 91 drift candidates against historical migration sources and resulting schema; do not mass-rename.
3. Resolve all five duplicate-name groups with source evidence before release tooling is allowed to classify them.
4. Identify the 123 remaining Staging-only names and 225 older local files without a direct Staging name match. Inspect repository history, prior branches, and staging-specific replay/reconciliation migrations.
5. For each of the seven newer migrations, validate dependencies, preconditions, postconditions, and test coverage. In particular, ensure the server-only supplier routes are the only runtime data path before revoking browser SELECT.
6. Re-run the migration-release guard against the actual ledger after the identity test and before any future migration approval.

## 8. Safety boundary

This report is a read-only reconciliation snapshot. It did not apply migrations, update \`schema_migrations\`, change ACL/RLS, alter data, touch Production, create a Preview, or merge PR #359.


## 9. Local timestamp collisions and release-source inventory — 7 November 2026

### Verified repository snapshot

Follow-up verification used source HEAD \`ee957aad1503cfc2490fe14f0c866a9441c532a8\` and tree \`fa968e35ed11150689dc453ead3e9aa5f88c8834\`. GitHub's compare endpoint confirms that the only changes between the report's original source snapshot \`850144da0b8b7234f440a92da0739cc9f3142628\` and \`ee957...\` were the PostgreSQL integration workflow, security ledger, this report, and the platform-support SQL regression. No migration file changed in that interval. The 502-file reconciliation baseline therefore remains valid for canonical 14-digit migrations.

The complete tree contains 579 SQL files:
- 502 canonical migration filenames with a 14-digit version.
- 77 older numeric-version SQL filenames that do not use the 14-digit convention.
- The original 502/424 comparison is specifically the canonical 14-digit migration inventory versus the 424 live Staging ledger rows; it was not a count of every SQL file in the directory.

### Four additional 14-digit duplicate-version groups

The full tree contains four canonical 14-digit versions used by two distinct SQL files each. Their contents and GitHub path histories were inspected; the paired files implement different changes and are not duplicate byte copies.

| Version | First file and source evidence | Second file and source evidence |
|---|---|---|
| \`20260916190000\` | \`enforce_subscriber_phone_required.sql\` — required phone / optional WhatsApp constraint; blob \`8d062127e09d0101dd6e1bfca669a32830293407\`; path commit \`65cdb5dd040f\` at \`2026-09-16 16:48:05Z\` | \`powerhub_owner_subscription_main_site.sql\` — atomic owner-subscription and main-site creation; blob \`9fd5ace64f8a633ef43dc724f14e953b1615df2f\`; path history includes \`781bc0af66d9\` at \`2026-09-16 15:53:12Z\` |
| \`20260922123000\` | \`powerhub_unified_field_user_guard.sql\` — field-user feature-policy guard; blob \`a9386eae4ea80ac8a44be7a8dbaea3a007ee6912\`; path commit \`62d128cc5f39\` at \`2026-09-22 07:02:04Z\` | \`powerhub_unified_field_user_policy.sql\` — revised quota guard plus explicit trigger recreation; blob \`f887b4a5580211cb624701d0601975952b660006\`; path commit \`219ac8a2fd34\` at \`2026-09-22 07:02:17Z\` |
| \`20260926123000\` | \`powerhub_advanced_dashboard_synchronization.sql\` — platform dashboard read model; blob \`6b4b14956e7d753f0a9f2ecfccd5ddd836c6aaa5\`; path commit \`2e586374a622\` at \`2026-09-26 09:56:29Z\` | \`powerhub_upgrade_review_hardening.sql\` — subscription-upgrade approval transaction hardening; blob \`ae9100ff76d479576e3d7bab98a416b5b22d6e48\`; path commit \`38acd99531d6\` at \`2026-09-26 09:23:44Z\` |
| \`20261013170000\` | \`powerhub_fix_sms_claim_tenant_id_ambiguity.sql\` — SMS claim tenant scoping / output-parameter ambiguity; blob \`d985ecf9ea6d7f20f3faf1a8d7345cfcf6de5634\`; path commit \`cbe97a809052\` at \`2026-10-13 13:07:26Z\` | \`powerhub_unified_message_history_filters.sql\` — unified, tenant/site-scoped message history and filters; blob \`8d633a7c5186c9e636b271bcc600aa5de916feed\`; path commit \`0b21e7c37681\` at \`2026-10-13 17:00:07Z\` |

The repository also retains two older, non-14-digit collision groups:
- \`0010\`: \`0010_fix_subscriber_create_rpc_ambiguity.sql\` and \`0010_powerhub_update_subscriber_rpc.sql\`.
- \`0060\`: \`0060_admin_subscription_upgrade_enrichment_rpc.sql\` and \`0060_powerhub_request_owner_access_recovery.sql\`.

### Existing guard assessment

At \`ee957...\`, \`scripts/check-supabase-migration-files.mjs\` already pinned all six exact collision groups (the four 14-digit groups above plus legacy \`0010\` and \`0060\`). Thus these four 14-digit groups were not completely unguarded; the gap was that they were absent from this reconciliation report and the release workflow did not validate the entire immutable PR-source inventory.

The release workflow checks out trusted release scripts from \`main\`, checks out the source PR at its immutable SHA into \`migration-source\`, but copies only the selected SQL file into the trusted workspace. Its previous inventory check therefore saw the \`main\` migration directory plus the selected file, not all migrations in the source PR. That is insufficient to detect a second, unselected new file in the same PR sharing a version.

### Hardening implemented in this follow-up

- Shared \`assertSupabaseMigrationFileInventory\` validates the complete filename inventory. It allows only the exact six pinned historical groups and fails closed on any new, altered, or additional duplicate version.
- \`assertSupabaseMigrationReleaseVersionIsUnique\` additionally prevents releasing any selected file whose version is shared by another local migration, including a member of a pinned historical group.
- \`check-supabase-migration-files.mjs\` accepts \`POWERHUB_MIGRATION_DIR\`, so the protected release workflow can inspect the entire source-PR migration directory rather than only the selected copied file.
- \`release-supabase-migration.mjs\` validates that same full source inventory and requires the selected candidate to be present in it.
- The protected workflow passes the immutable checkout at \`migration-source/supabase/migrations\` to both the inventory checker and the release runner.
- Regression tests cover all six pinned groups, a new 14-digit collision, changes to pinned members, malformed filenames, selection of a colliding candidate, and a unique candidate.

### Decision and remaining proof

No historical filename or timestamp was changed. Git path-commit dates and distinct SQL contents establish that the paired files are separate source changes, but do not by themselves prove which timestamp should replace the shared version or whether equivalent SQL was executed under another historical Staging/Production identity. Assigning new timestamps without the complete historical release ledger and schema evidence would risk replaying already-applied SQL. The four groups remain pinned and unreleasable by candidate-version guard until an evidence-backed reconciliation decides their final disposition.

Staging remains at 424 ledger rows, latest \`20261106224902\`; no migration was applied, no migration-history row was inserted or rewritten, and Production was not modified during this follow-up.
