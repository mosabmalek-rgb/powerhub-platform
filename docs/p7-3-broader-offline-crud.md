# P7.3 — Broader Offline CRUD

## Current slice
P7.3 adds a controlled safety boundary for offline operational CRUD before expanding into additional entities. Offline-capable screens do not make financial, administrative, messaging, audit, or authorization-sensitive data locally authoritative.

## Approved operational scope
- Create: subscribers, generators, readings.
- Update: subscribers, generators, readings, tariffs, schedules.
- Delete: none offline by default.

All replayable mutations continue through the P7.2 unified executor and retain `clientOperationId`.

## Safety rules
- Local persistence remains scoped by authenticated user and site.
- Server authorization, tenant/site validation, RLS, business rules, and idempotency remain authoritative.
- No automatic last-write-wins for sensitive records.
- Financial mutations remain server-authoritative.
- No production test data is permitted.
- Staging replay verification is required before release.

## Implemented in this slice
- Added `generator_create` and `generator_update` to the existing offline work contract.
- Added generator create/update payload types without changing existing online caller semantics.
- Added deterministic queue contract tests covering client operation identity and user/site scope.
- Routed generator create/update queue items through the existing `OfflineWorkSyncPanel` and P7.2 unified executor.
- Added browser-authenticated Supabase generator create/update RPCs with tenant/site authorization, idempotent replay, and optimistic concurrency protection.
- Extended `offline_sync_operations` to accept generator operation types.
- Generator Editor now enqueues `generator_create` / `generator_update` while offline and preserves `expectedUpdatedAt` for stale-write detection.
- Auth session reads are centralized through a single-flight in-memory session accessor while Supabase automatic token renewal remains enabled.
- Latest branch Preview deployment reaches `READY`.

## Staging verification
The staging project `powerhub-staging-dr` is used for controlled verification only.

Verified database/RPC scenarios:
1. Generator create succeeds with a client operation identity.
2. Replaying the same operation returns the existing generator instead of creating a duplicate.
3. Generator update with the current `expectedUpdatedAt` succeeds.
4. A stale update is rejected with `GENERATOR_VERSION_CONFLICT` and does not overwrite newer data.
5. Scope checks reject mismatched tenant/site/generator combinations.
6. Test records and test sync-operation rows are removed after verification; no test data remains.

## Current release gate
The remaining gate is authenticated browser-level E2E on the staging Preview. It must prove the real browser path:

`Login → Session Stability → Offline Generator Form → IndexedDB Queue → Reconnect → Unified Sync Executor → Supabase → Idempotent Replay → Stale Conflict`

and then run subscriber/invoice/payment smoke coverage to protect the existing commercial flows.

Browser E2E is not considered passed until execution evidence exists from an authenticated browser session. Unit tests, database verification, CI, and Preview readiness do not substitute for this gate.

## Release policy
P7.3 remains Draft. Do not merge or promote to production until the browser E2E gate, tenant/site isolation checks, regression smoke coverage, CI, Security, Preview verification, and final review all pass. Production remains on the established P6 release.