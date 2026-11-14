# PR #359 — A22 execution evidence, 2026-11-10

## Scope and baseline

Actual branch HEAD before this repair: `5f2fb75a977171830e6cf5264a5f54e641f4b3e3`. PR remained OPEN/DRAFT. Baseline CI was verified directly on GitHub, including [PostgreSQL Integration](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/42784214811) and [PowerHub CI](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/42784214933).

Read the new execution request and the A handoff, acceptance roadmap, three read-only SQL acceptance/provenance files, operational GL SQL fixture and acceptance contracts. Existing work was retained.

## Reproduced defect and repair

On disposable PostgreSQL 17, an active tenant membership whose `expires_at` was in the past successfully created a fixture manifest using the original routine. This is an eligibility defect even though the browser cannot directly execute the routine.

The forward migration checks expiration at statement time in seven existing routines: fixture guard/prepare/review, opening evidence guard/submit/review, and payroll approval. Guard triggers validate preparers on INSERT as well as reviewers on UPDATE. NULL fixture scope is rejected. Existing maker/checker separation and financial calculations remain intact. All routines remain SECURITY INVOKER with browser/PUBLIC execution revoked and service-role execution checked. Both existing triggers must remain attached and enabled.

Preflight hashes the actual `pg_get_functiondef` of all seven routines and accepts only their reviewed original or repaired definitions. Unknown live hotfixes stop the migration instead of being overwritten. This can intentionally block deployment if Staging definitions differ; investigate rather than bypass. No historical migration files or ledger rows were edited.

## Reproducible validation

- `pnpm check`: PASS.
- `pnpm build`: PASS.
- `pnpm test`: PASS, 323 files / 2002 tests across 61 runner batches, no failure markers; process exit 0.
- New real tRPC caller suite: PASS, 19 tests; anonymous/capability/tenant/site/production denial, spoofed actor ignored, explicit review acknowledgement, post-review proof failure, self-review error propagation.
- `supabase/tests/financial_fixture_membership_expiry.sql` on disposable PostgreSQL 17 with ON_ERROR_STOP: PASS. Imports the real operational GL integration fixture and migration bodies; applies repair twice; verifies expired/disabled actor refusal, privileged direct-write boundaries, valid separate reviewers for synthetic opening evidence and payroll, retry, expiry after approval, rollback and browser ACL.
- Real 250000-row independent synthetic cohort: SHA-256 rejection PASS, 2307.849 ms in one local sample. Original immutable cohort hash and constraints were preserved. This is a negative integrity test, **not** acceptance of the original Staging cohort or a production performance benchmark. All test rows rolled back.
- Finance migration adverse preflights: PASS for missing expiry column, changed fixture routine search_path, and payroll SECURITY DEFINER drift. Exact expected SQLSTATE/message asserted; mutations rolled back.
- Migration inventory: PASS, 621 files and six pinned historical collision groups. New duplicate versions rejected.

Local raw logs are in `/workspace/.setup/finance-abc-20261110/` (ephemeral environment evidence); CI executes the committed SQL and tests independently. No external original-document custody is asserted by synthetic opening tests.

## Deployment and stage gates

No hosted migration or data mutation has been performed in this execution at the time of this record. Supabase MCP reaches the endpoint but returns HTTP 401; no authenticated connector or secure DB variables are exposed. User instructed continuing independent work until connection becomes available. The protected staging release workflow remains the only permitted migration path; its real human reviewer gate is retained. Production is prohibited.

A: engineering repair validated locally; final live reconciliation, original fixture permanent independent review, source completeness, supported opening balances and live accounting acceptance remain BLOCKED. B and C: NOT_TESTED in this execution, pending the required A gate. Historical Staging counts in earlier handoff sections must not be presented as new live observations. No income/position engine, artificial balancing entries, human impersonation, or IndexedDB/outbox change was introduced.

Final commit, exact-SHA CI results and any protected release run are recorded in the accompanying delivery report; do not infer deployment from a green code check.
