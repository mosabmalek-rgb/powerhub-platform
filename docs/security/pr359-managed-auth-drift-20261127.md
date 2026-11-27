# PR359 — 2026-11-27 provider-managed Auth drift

Parent 87d39cd00583f97097349e7a8ad1675f914cd397; Docker Shadow run 46034271080.
Smoke job 140625589097 passed and emitted all five candidate markers, including the 17 negative payload cases, synthetic ACL, valid upsert/tombstone/rollback, retention/reset and fixture restoration.
Full restore job 140625589452 failed closed at pre-export-managed-migrations, exit 2, before application export. Missing source-managed columns: auth.custom_oauth_providers.client_auth_method and client_assertion_audience. Missing managed migration: auth:20261116120000. Realtime extra columns were all allowed by the existing comparator; no reason to loosen that policy.

The prior full job used CLI 3.2.0. Upgrade only the Docker Shadow full job to pinned stable 3.4.0 as a compatibility candidate. Supabase release notes document new JSONC init defaults on 2026-11-24 (https://supabase.com/docs/guides/local-development/cli/config-formats); support both config formats for local stop and cleanup, and log local stack image names/CLI version for reproducibility. Auth v2.199.0 release includes client auth methods (https://github.com/supabase/auth/releases/tag/v2.199.0), but the actual service version and exact catalog parity of CLI 3.4.0 are NOT yet verified. No new managed DDL, synthetic migration ledger rows, allowlist or parity bypass. If mismatch persists, inspect actual image versions and reconcile against official provider migration provenance before any further changes.

No hosted writes, migration application, production deployment or merge authorized. Candidate Append tests passing do not establish full producer closure. Full financial restore and Canonical Baseline remain unapproved until new-head evidence.
