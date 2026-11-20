# PowerHub PR359 — Staging isolated restoration experiment, no remote mutation

Date: 2026-11-20. Initial source: `eadb8ed206868a500eb0cdf0ed49dbd016d5418c`.

## Why a separate workflow

The existing protected Docker Shadow job uses **Production** and contains
Finance migration rehearsal. Re-pointing that job to Staging is unsafe.
A new standalone `workflow_dispatch` job runs only when the selected ref is
`feat/auth-local-first-single-pr` and the opt-in repository variable
`PR359_ENABLE_STAGING_DOCKER_SHADOW=true`; it uses its own environment
`pr359-staging-shadow` and *only* the environment secret
`PR359_STAGING_SHADOW_SOURCE_DB_URL`.

The source guard rejects Production credentials when `SHADOW_SOURCE_KIND=staging`,
requires a Staging project-specific Postgres URI (TLS required; 5432;
Session Pooler for GitHub-hosted IPv4), and never emits source passwords.
The job uses the same temporary Supabase Local Stack and provider-managed
compatibility crosswalk as the prior successful R0-R3 Production shadow.
Only the **local** stack's superuser performs COPY for provider-managed
metadata. No SQL mutation is executed on hosted Staging/Production.

## Read-only Source History Gate

Pinned observed Staging migration history (2026-11-20):
- Count: 553
- Minimum version: `20260905170000`
- Maximum version: `20261116231000`
- Whole-row SHA-256 (six columns including statements/rollback):
  `52b3006440effe431299a2a58b2150c18acd02ab78ffc79ffcb13075538bb613`

The flow:
1. verifies host, TLS, read-only count and the pinned SHA;
2. compares provider-managed source against fresh isolated Supabase Local Stack;
3. exports logical schema/data/roles/history to ephemeral runner files;
4. reads the source SHA/count again under explicit read-only TLS and fails on drift;
5. restores inside Local Stack, compares restored history SHA, and checks
   application/managed counts;
6. destroys/recreates the Local Stack, restores a second time, and requires
   the two restored history fingerprints to match;
7. exits **before** any Production-only finance migration replay.

No dump artifact is uploaded, and the existing cleanup trap deletes local
copies. These source SELECTs and independent logical exports are not one
transactionally consistent database snapshot. A source write freeze remains
a separate prerequisite to an in-place rebaseline.

## Activation and acceptance

This is code-ready, **not automatically run**. A repository owner must
configure the protected environment with explicit review, store the
Staging-only URI in its GitHub environment secret (do not paste credentials
in chat), set the separate opt-in repository variable, and manually dispatch
the workflow from the PR head. Do not reuse the Production secret.

A successful run will prove Staging logical export/restoration and history
fidelity at the captured point. It will NOT demonstrate a canonical
application baseline built from zero, an actual Epoch v2 switchover,
a durable encrypted off-runner backup, a safe app-owned removal plan, or
permission for destructive Staging commands.

`STAGING_REAL_RESTORE=NOT_YET_EXECUTED`
`CANONICAL_EMPTY_STACK_BASELINE=NOT_ACCEPTED`
`STAGING_INPLACE_GO=false`
`PRODUCTION_INPLACE_GO=false`
`PR359_MERGE_GO=false`
