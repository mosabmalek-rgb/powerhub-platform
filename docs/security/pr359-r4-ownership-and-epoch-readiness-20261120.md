# PR359 — R4 ownership/cron boundary follow-up

Date: 2026-11-20. Source review: Staging read-only single SQL statement.
Starting SHA: 53db334d8774f1851b8eadf9adedf96d0b1ed2e6.

## Factual snapshot

- App namespace relation/view/sequence entries: 337 (public 325, private 12).
- App namespace function signatures: 641 (public 579, private 57, powerhub_private 5).
- Every inspected object is owned by postgres; none has a direct extension dependency of type e.
- No app-to-managed relation dependency was found within the limited pg_depend traversal.
- Two active Staging cron jobs: powerhub-subscription-lifecycle (*/15 * * * *) and powerhub_reconcile_expired_field_readers (*/5 * * * *).
- Non-internal triggers on app relations: 202. RLS-enabled public/private relations with no policy: 78.

## Security interpretation

The 978 objects are **provisional review candidates only**, NOT a DROP allowlist.
postgres ownership does not prove the object is application-owned. pg_depend can
miss dependencies referenced by PL/pgSQL function bodies, dynamic SQL, job
commands and application code. RLS without policy can be intentional deny-all.
The two active cron jobs must be frozen through an approved runbook and verified
in an audited maintenance window before any future mutation; neither was changed.

An explicit per-object signed allowlist must enumerate object identity, DDL
fingerprints, provider/extension dependency graph, function-body references,
trigger targets, inbound FKs and app callers. No broad CASCADE is allowed.

## Implemented controls

New scripts/pr359-r4/ownership-boundary.sql generates metadata only.
New scripts/pr359-r4/ownership-boundary.mjs rejects changes in ownership,
unexpected groups/extension membership, managed dependencies, cron state,
trigger or RLS baseline. Tests include negative cases for every change type.
CI invokes the checker against a stored read-only sample; this only proves
the reviewed snapshot is internally consistent. It is not a live, signed
same-SHA recapture during maintenance.

## Migration Epoch v2 decision

Current Staging historical migration ledger retains 553 versions. No release
transition is authorized yet. Preserve the original ledger as immutable evidence.
Prepare a reviewed, independently recoverable epoch marker and a protected
post-baseline runner on a disposable copy, with exact SQL SHA binding and repeat
tests. Do not use broad db push, migration repair, or manual history rewrite
to make old and new histories appear equivalent. The production project remains
untouched. Staging rebaseline remains blocked until the epoch transition and
retained off-runner backup are independently proven.

R4_OWNERSHIP_MANIFEST_MATCH=METADATA_ONLY
R4_APP_OWNED_ALLOWLIST_APPROVED=false
R4_EPOCH_V2_EXECUTION_APPROVED=false
R4_STAGING_INPLACE_GO=false
R6_PRODUCTION_INPLACE_GO=false
PR359_MERGE_GO=false
