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

## Next implementation slice
Wire the approved operational mutation kinds into the existing offline queue and unified executor, adding deterministic tests for payload shape, user/site scope, replay, retry, conflict, and reconnect behavior.
