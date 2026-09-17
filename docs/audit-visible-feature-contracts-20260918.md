# Visible Feature Contract Audit — 2026-09-18

## Rule
Every user-visible operation must have a working end-to-end path from UI to server/runtime to Production. Disabled legacy procedures must not be exposed as actionable UI.

## Findings on main `f50dcc27d8f1717dd209d98794a50db31b85ae87`

### Confirmed UI/runtime mismatches
- Messaging settings exposes `configureInvoiceAutoSend`, while the server procedure explicitly throws `PRECONDITION_FAILED`; no active Vercel/Supabase scheduler exists for this flow.
- Messaging settings exposes `notifications.testConnection`; the current server route is retired even though `probeMessagingConnection` exists as a real helper.
- Messaging settings exposes `notifications.retry`; the route is a retired legacy procedure. The working path is `notifications.sendPendingSms` used by Billing.
- Messaging settings exposes `notifications.retryPaymentReceipt`; this route is retired. The current working send path is the explicit notification worker route.

### Working path retained
Billing's pending/deferred SMS actions call `notifications.sendPendingSms`, which invokes the current `processNotificationQueueForTenant` worker path. Those controls are not classified as dead merely because older procedure names contain `retry`/`sendDeferred`.

## Action
The UI must not expose the four retired operations above. The auto-scheduler remains hidden until a real protected Production scheduler is deployed. Connection testing may later be re-enabled only through the existing `probeMessagingConnection` helper and an explicitly scoped server procedure.
