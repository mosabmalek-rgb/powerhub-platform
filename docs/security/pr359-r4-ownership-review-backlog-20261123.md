# PR359 — ownership candidate review backlog (non-authorizing)

Date: 2026-11-23. Base review: \`d54e5442efc521247c9664a6ad7aea3759ff183c\`.
Environment: read-only Staging catalog \`iyuryuhaylhisjfcrwkz\`. **No database mutation.**

## Position after R4 twin-restore PASS

Two independent isolated logical restorations succeeded in protected GitHub
run [45121222333](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/45121222333).
That proves tested **restorability**, not application ownership,
approval of an empty-stack baseline, Migration Epoch v2, or in-place changes.

## Reviewable source ledger, not a signed ownership list

The historical R0 per-object register has 978 unreviewed candidates:
641 functions and 337 relations/sequences. The fresh read-only Staging
catalog count agrees; among functions, 355 are SECURITY DEFINER and 296
are SECURITY DEFINER in public. None is authorized for dropping.

The new \`scripts/pr359-r4/audit-ownership-candidates.mjs\` checks every
identity in the provisional register against both original R0 inventory files,
including individual ACL SHA-256, function definition SHA-256, schema, owner,
SECURITY DEFINER flags, and effective EXECUTE flags from the historical
capture. Missing/renamed/duplicated items, drifted privileged functions,
changed ownership, extensions, fabricated review or nonempty destructive
allowlist stop with an error.

It deterministically produces a **non-authorizing** review queue:

| Priority | Kind | Historical candidates | Required next evidence |
| --- | --- | ---: | --- |
| P0 | Public SECURITY DEFINER functions | 296 | Live DDL SHA, SECURITY DEFINER / search_path / RLS / callers and tenant isolation |
| P1 | Other SECURITY DEFINER or authenticated-callable functions | 62 | Complete EXECUTE, caller and dependency review |
| P2 | Relations and sequences | 337 | Full current relation DDL SHA, indexes, constraints, policy and dependency graph |
| P3 | Remaining functions | 283 | Live definition/ACL SHA, dependency graph and caller review |
| **All** | **Provisional only** | **978** | **Human signed object-by-object decision, exact SHA and negative gates** |

These tiers are review **order**, not a classification of ownership,
importance, operational safety, or permission to mutate.

## What cannot yet be inferred

The R0 files were captured on 2026-11-19; matching them does not itself
prove live per-object DDL fingerprints against the present PR head.
Relation full-definition SHA is absent for all 337 entries. Further,
the *provider-managed to app* 48 catalog edges, three Auth foreign keys,
Cron activity, dynamic SQL, webhook/Realtime/Storage and Android/Offline
contracts must be reconciled per object; a positive SELECT on pg_depend
cannot prove absence of runtime dependencies.

Before sign-off, capture current read-only per-object DDL/ACL under a
pinned snapshot, map dependency direction and exact provider policy
references, and identify the canonical implementation source of each
object. Reviewer signatures must bind the exact Git commit, DDL digest
and a versioned allowlist. No automated promotion from candidate to
APP_OWNED is permitted.

Run:

\`\`\`bash
node --test scripts/pr359-r4/audit-ownership-candidates.test.mjs
node scripts/pr359-r4/audit-ownership-candidates.mjs
\`\`\`

**Current decisions:**

\`\`\`text
R4_TWO_DISPOSABLE_STAGING_RESTORES=PASS
R4_OWNERSHIP_CANDIDATE_PROVENANCE=VALIDATION_IN_CI
R4_APP_OWNED_ALLOWLIST_SIGNED=FALSE
CANONICAL_EMPTY_STACK_BASELINE_APPROVED=FALSE
STAGING_INPLACE_GO=FALSE
PRODUCTION_INPLACE_GO=FALSE
PR359_MERGE_GO=FALSE
\`\`\`
