# Visible Feature Contract Audit — 2026-09-18

This audit defines the acceptance rule that every user-visible operation must have a working end-to-end path from UI to server/runtime to Production. Disabled legacy procedures must not be exposed as actionable UI.

Confirmed mismatches in the audited source: the messaging settings page exposes invoice auto-scheduling although the procedure is explicitly disabled; it exposes connection testing although the current server route is retired; it exposes notification retry actions through retired procedures. Billing has a separate working `notifications.sendPendingSms` path and those controls are not classified as dead merely because older procedure names contain `retry`/`sendDeferred`.
