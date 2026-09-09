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
- Added generator create/update payload types without changing the Supabase schema.
- Added deterministic queue contract tests covering client operation identity and user/site scope.
- Routed generator create/update queue items through the existing `OfflineWorkSyncPanel` and P7.2 unified executor.
- Preview deployment for the current branch is `READY`, and `/api/health` plus `/api/ready` both return HTTP 200 on the preview deployment.

## Remaining gate
The `NetworkDirectoryPage` generator form is still submitting directly to the server and does not yet enqueue `generator_create` / `generator_update` while offline. Therefore P7.3 broader generator CRUD is **not yet implemented end-to-end**.

## Next implementation slice
Wire the existing generator form submit path to `enqueueOfflineWork` for offline create/update, preserve `expectedUpdatedAt` for optimistic concurrency, then verify reconnect → sync → idempotent replay and staging isolation before production promotion.
