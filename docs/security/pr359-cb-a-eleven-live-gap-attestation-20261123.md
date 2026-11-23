# PR359 CB-A: 11 unmatched historical CREATE names — live definition attestation

Capture date: 2026-11-23. Source: read-only pg_catalog on Staging
`iyuryuhaylhisjfcrwkz`, parent Git HEAD `aac7b62dcae9010d67b171902509fee48f2136f6`.

The six functions were retrieved as complete `pg_get_functiondef` SQL and
matched against the archived R0 SHA256 definitions. Three have SECURITY
DEFINER; all six reject direct anon and authenticated EXECUTE, while
service_role can execute them. Their definitions are **forensic evidence**
only. Do not automatically execute them as canonical SQL or elevate permissions.

The five tables were retrieved through pg_catalog with columns, defaults,
constraints, indexes, triggers, RLS and policies. Column names, types,
defaults, nullability and identity properties are reconciled against R0.
The five tables all have RLS enabled with no direct RLS policies, with
no anonymous/authenticated SELECT privileges and a service-role SELECT
grant. The payment documentation table has two user triggers.

The original lack of a lexical CREATE in the historical 700 SQL files is
still a **source lineage blocker**, not evidence that the objects can be
dropped. Existing live state cannot replace a signed, reviewed design.

CB-B next: reconcile runtime callers/trigger users, reconstruct reviewed
SQL with exact dependency prerequisites, and test on fresh compatible
Supabase local stacks. Preserve historical migration lineage unchanged.

CB_A_ELEVEN_CATALOG_ATTESTATION=CI_PENDING
APP_OWNED_APPROVED=FALSE
CANONICAL_BASELINE_APPROVED=FALSE
CLEAN_BOOTSTRAP_PASS=FALSE
STAGING_INPLACE_GO=FALSE
PRODUCTION_INPLACE_GO=FALSE
PR359_MERGE_GO=FALSE
