# P7.2 — Unified Sync Engine Contract

This document defines the server/client contract to be implemented after P7.1. It is intentionally implementation-neutral and does not authorize production database changes by itself.

## Operation envelope

Every queued mutation uses a stable envelope:

```ts
export type SyncOperation = {
  clientOperationId: string;
  tenantId: number;
  siteId: number;
  userId: number;
  kind: string;
  payload: unknown;
  dependsOn: string[];
  createdAt: string;
};
```

`clientOperationId` is generated once and never replaced during retry.

## Server response classes

- `applied`: operation accepted and committed.
- `already_applied`: idempotency replay; return the original result.
- `conflict`: current server state prevents safe automatic application.
- `retryable`: transient dependency/network/database condition.
- `rejected`: validation, permission, subscription, tenant/site scope, or business-rule failure.

## Ordering

The client sends only operations whose `dependsOn` values are `applied` or `already_applied`. Independent operations may run sequentially in P7.2; concurrency can be introduced later after measurements.

## Security invariants

- Server derives authoritative tenant access from authenticated user context; client-supplied tenant/site ids are validated against membership.
- Offline cache never grants additional permissions.
- A stale local auth snapshot is presentation state only.
- Financial mutations continue to use existing server-side RLS, transaction, closed-period, subscription and idempotency protections.

## Retry

Retry only `retryable` results. Use bounded exponential backoff with jitter and a finite attempt ceiling. `conflict`, `rejected`, and permanent validation failures must not be retried automatically.

## Conflict handling

A conflict stores enough server and local metadata for a human-readable review. Automatic last-write-wins is not used for financial records or authorization-sensitive data.

## Observability

Each sync cycle should expose:

- operation count
- applied count
- retryable count
- conflict count
- rejected count
- duration
- last sync timestamp

The implementation should reuse the existing audit/sync observability primitives where possible rather than creating duplicate telemetry paths.
