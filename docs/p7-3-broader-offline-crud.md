# P7.3 — Broader Offline CRUD

## Current slice
P7.3 adds an explicit safety boundary for offline operational CRUD before expanding into additional entities. This prevents an offline-capable screen from accidentally making financial, administrative, messaging, audit, or authorization-sensitive data locally authoritative.

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
- Added replay-safe generator create/update database functions with site/tenant scope and optimistic concurrency protection.
- Extended `offline_sync_operations` to accept generator operation types.
- Preview deployments for the current branch reach `READY`.
- Latest Preview runtime log review found no warnings/errors and no 5xx responses in the last 24 hours.

## Staging verification
The staging project `powerhub-staging-dr` was used for controlled verification only.

Verified scenarios:
1. Generator create succeeds with a client operation identity.
2. Replaying the same operation returns the same generator rather than creating a duplicate.
3. Generator update with the current `expectedUpdatedAt` succeeds.
4. A stale update is rejected with `GENERATOR_VERSION_CONFLICT` and does not overwrite newer data.
5. Scope checks reject mismatched tenant/site/generator combinations.
6. Test records and test sync-operation rows are removed after verification; no test data remains.

## Remaining gate
The application server router in `server/powerhub.ts` still needs to expose the new Generator idempotency/concurrency contract to the tRPC surface, and the `NetworkDirectoryPage` generator form still needs to enqueue `generator_create` / `generator_update` while offline. Therefore P7.3 broader generator CRUD is **not yet end-to-end complete**.

## Release policy
P7.3 remains Draft. Do not merge or promote to production until the server contract, Generator Editor offline path, full unit/regression suite, CI, staging replay/isolation checks, and final review all pass. Production remains on the established P6 release.