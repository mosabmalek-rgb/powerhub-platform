# PR359 — Delta reset recovery hardening (code-only)

24 November 2026. Scope: PowerHub **web** offline Delta sync via
`client/src/lib/offline-delta-sync.ts`. Android field-reader subscriber
Delta is a different protocol; do not attribute these results to Android
fuel/maintenance synchronization.

## Change

On receiving `reset_required`, the web client validates the current,
retained and requested snapshot cursors before touching the local cache.
It rejects a retained floor above the current cursor, a requested
snapshot above the current cursor, non-empty changes, a continuation
cursor, or `has_more=true`.

The client permits at most three snapshot rebuild attempts in one
`pullDeltaPages` run; an additional `reset_required` aborts with a
recoverable error rather than repeatedly rebuilding the cache.
A snapshot result whose cursor is **older** than the requested reset
watermark is rejected before `replaceSnapshot`.

Existing guarantees remain in place:
- The replacement snapshot and cursor are committed in one IndexedDB
  transaction, never independently.
- Failed snapshot fetch, malformed reset, stale snapshot or superseded
  session must not publish a replacement.
- Delta stores do not include the offline operation Outbox in their
  replacement transaction. These tests are not an end-to-end proof of
  outbox behavior across all web and Android repositories.
- Newer coherent snapshot cursors are permitted to allow changes
  occurring during snapshot reconstruction; the next Delta pull resumes
  from the returned cursor.

The adjacent Vitest tests cover malformed responses, excessive
rebuilds, failed snapshot fetch and watermark regression. All tests
are code-only; no hosted HTTP, mobile device, or production data touched.

## Remaining gates

Validate the server's actual reset/snapshot JSON contract across
inventory, fuel, maintenance and HR routes. Separately audit Android's
merged `app-power-` implementation and preservation of pending
reading/payment Outbox during its own subscriber bootstrap recovery.

```text
WEB_RESET_GUARD_CI=CI_PENDING
ANDROID_FUEL_MAINTENANCE_DELTA_ACCEPTANCE=FALSE
WEB_OUTBOX_END_TO_END_ACCEPTANCE=FALSE
CANONICAL_BASELINE_APPROVED=FALSE
STAGING_INPLACE_GO=FALSE
PRODUCTION_INPLACE_GO=FALSE
PR359_MERGE_GO=FALSE
```
