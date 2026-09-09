# P7.3 — Broader Offline CRUD

## Current slice
P7.3 starts with an explicit policy boundary before wiring additional UI mutations. This prevents an offline-capable screen from accidentally making financial, administrative, messaging, audit, or authorization-sensitive data locally authoritative.

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
- Added deterministic contract tests covering client operation identity and user/site scope.
- Existing subscriber, invoice, and payment queue behavior remains unchanged.

## Not yet claimed
The generator queue contract is not yet wired into `NetworkDirectoryPage` or `OfflineWorkSyncPanel`. Therefore P7.3 broader generator CRUD is **not yet implemented end-to-end**.

## Next implementation slice
Wire generator create/update through the existing queue and P7.2 unified executor. Then add reconnect, retry, conflict, and staging replay verification before expanding to additional operational entities.
