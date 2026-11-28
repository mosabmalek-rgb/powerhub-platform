# PR359 — parallel CB-A evidence matrix (2026-11-28)

Pinned review parent: `a9a3b153bda3d4a2740e8f11827a166178a1da8b`. This is a non-authorizing review register. Evidence is scoped to its original commit and execution environment; no inherited PASS is a new-head result.

| Requirement | Pinned source / evidence | Result at parent | Remaining acceptance |
| --- | --- | --- | --- |
| Independent writer roots | writer inventory blob `2a3e79fbb281f9b09c9ed0648aeae4204c6a1330`; [run 46059207573](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/46059207573) | FAIL (wrong supplier relation) | Correct root, retain guard, verify report artifact and all CI gates on corrected head |
| Native IndexedDB repair / outbox | [job 140709075501](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/46059207573/job/140709075501) | PASS for disposable fixture, per recorded evidence | Full hosted HTTPS / multi-tab / session and live query race acceptance remains open |
| Real maintenance RPC deadlock | [job 140702257919](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/46057095786/job/140702257919) | Prior fixture PASS; not global lock order | HTTP transaction boundary and direct/indirect writer order |
| Real fuel RPC deadlock | [job 140706333302](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/46058373991/job/140706333302) | Prior fixture PASS; not global lock order | Optional readings, accounting/FK locks and HTTP boundary |
| Operational repair | `client/src/components/OfflineDeltaSyncRuntime.tsx` blob `1790777a3f518269ccd450f783f531dbebf2fa14` | PARTIAL; no repair arguments passed to pullDeltaPages | Certified version and post-commit cache reconciliation |
| Ownership / dependency | `docs/security/pr359-r4-root-dependency-attestation-20261123.md` blob `65050f66ab727cabbc2136e855e00fc2762d166d` | 978 provisional roots; zero signed approvals | Full executable relation DDL, managed edges and dynamic/runtime dependencies; per-object signed decision |
| Eleven historical gaps | `scripts/pr359-canonical/cb-b-gap-review-bundle.mjs` | Review-only | Reconcile approved SQL and ordering; no executable baseline authorization |
| Android PR 17 | [PR 17](https://github.com/mosabmalek-rgb/app-power-/pull/17), head `a93e6f572dd485eb9c8a64e1e8cdaedd249c67d6` | MERGED observed 2026-11-28 | Revalidate current Android main and runtime contracts separately |

## Runtime integration blocker

At the pinned runtime source, syncOne obtains a scope Web Lock and guards the current user, then rebuildSnapshot updates TanStack Query and persists offline queries before returning rows/cursor to pullDeltaPages. A repair-version checkpoint cannot certify the separate query-cache persistence boundary. Require tests for interrupted persistence, live query writes racing the snapshot, session replacement, and cross-tab cache reconciliation. Do not wire repairSnapshot or accept a caller-controlled repairVersion before a certified producer fix and these gates. No operational repair activation in this change.

## Negative gates

FULL_CALLER_CLOSURE_APPROVED=FALSE; GLOBAL_LOCK_ORDER_APPROVED=FALSE; SERVER_REPAIR_VERSION_ACTIVATED=FALSE; FULL_RUNTIME_BROWSER_ACCEPTANCE=FALSE; APP_OWNED_APPROVED=FALSE; SIGNED_OWNERSHIP_APPROVALS=0; CB_A_FINAL_APPROVED=FALSE; CB_B_CANONICAL_SQL_APPROVED=FALSE; MIGRATION_EPOCH_V2_APPROVED=FALSE; STAGING_INPLACE_GO=FALSE; PRODUCTION_INPLACE_GO=FALSE; PR359_MERGE_GO=FALSE.
