# Visible Feature Contract Audit — 2026-09-18

## Rule
Every user-visible operation must have a working end-to-end path from UI to server/runtime to Production. Disabled legacy procedures must not be exposed as actionable UI.

## Confirmed mismatches on the audited source
- Messaging settings exposes `configureInvoiceAutoSend`, while the server procedure explicitly throws `PRECONDITION_FAILED`; no active Production scheduler exists for this flow.
- Messaging settings exposes `notifications.testConnection`; the current server route is retired even though `probeMessagingConnection` exists as a real helper.
- Messaging settings exposes `notifications.retry`; the route is a retired legacy procedure. The working path is `notifications.sendPendingSms` used by Billing.
- Messaging settings exposes `notifications.retryPaymentReceipt`; this route is retired. The current worker path is the explicit notification processor.

## Working path retained
Billing's pending/deferred SMS actions call `notifications.sendPendingSms`, which invokes `processNotificationQueueForTenant`. Those controls are not classified as dead merely because older procedure names contain `retry`/`sendDeferred`.

## Required UI contract
The four retired operations above must not be actionable in the user interface. Auto-scheduling stays hidden until a protected Production scheduler exists. Connection testing can be exposed only through an explicitly scoped server procedure backed by `probeMessagingConnection`.
