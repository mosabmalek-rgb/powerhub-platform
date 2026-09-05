# P5.3 — Commercial Model

## Subscription lifecycle

Supported states: `trial`, `active`, `overdue`, `suspended`, `cancelled`.

Trial duration is tenant-specific and configurable by a Platform Admin. The default is 8 days.

## Plan limits

PowerHub already has platform-level configuration for subscriber and branch limits and per-tenant manual overrides. P5.3 treats those settings as the source of truth rather than duplicating a second limit system.

## Enforcement rule

All create/import paths for branches, subscribers, and other quota-controlled resources must enforce the effective limit on the server. UI counters are informational only.

## Commercial principle

A plan can define limits, while a Platform Admin can grant a specific customer an explicit override. Overrides must be auditable and must never silently reduce an existing customer's data.
