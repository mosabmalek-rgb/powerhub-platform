# PowerHub — Staging Migration History Reconciliation

**Snapshot:** 7 November 2026  
**Repository snapshot:** \`850144da0b8b7234f440a92da0739cc9f3142628\`  
**Supabase project:** \`iyuryuhaylhisjfcrwkz\` (Staging only)  
**Method:** GitHub recursive tree + Supabase migration ledger read-only query. No migration was applied and no history row was changed.

## 1. Inventory

| Measure | Observed |
|---|---:|
| Migration files in repository tree | 502 |
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
