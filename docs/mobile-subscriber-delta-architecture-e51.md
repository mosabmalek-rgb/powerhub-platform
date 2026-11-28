# E51 — PowerHub Mobile Subscriber Delta Architecture (PR #359)

## Status

**Source only**. No deployment to Staging/Production authorized yet. This document is aligned with Android PR #16 and `docs/mobile-api-contract-v1.md`; existing `GET /api/mobile/v1/subscribers` is preserved for older field clients.

## Scope and protocol

Authenticated access token is JWT with verified server session ID; tenant/user/branch are resolved from database membership, active staff profile, active sites and single-device lock. Only the authorized branch is accepted in `GET /api/mobile/v1/subscribers/delta`. Tenant ID is not in the request schema.

Cursor is HMAC-authenticated using a domain-separated key. It carries `tenantId,userId,branchId,sessionId,scopeVersion,mode,after,highwater,ceiling,issuedAt`; 30-day maximum age and invalid/foreign cursor are rejected without using an offset fallback. SHA-256 `scopeVersion` covers staff scope, distribution, membership, site policy and server-defined current cycle; changes force Bootstrap. No phone clock is used to order changes.

One initial Bootstrap freezes `ceiling = max(subscriber.id)` and `highwater = max(journal.sequence_id)` using `powerhub_mobile_delta_fence`. Multiple pages use seek pagination `id > after`, capped at 100. The final bootstrap cursor transitions to Delta with `after=highwater`. Changes after the fence are observed in subsequent Delta; timestamp ordering isn't used. Delta pages are bounded by the highwater, with `sequence_id > after AND sequence_id <= highwater`. The final delta cursor advances exactly to the upper bound.

`mobile_subscriber_change_log` uses `pg_advisory_xact_lock` per tenant **before** allocating the sequence ID to guarantee commit-ordered visible change numbers. Database triggers append old-branch leave/new-branch touch on subscriber moves and old/new reader IDs on assignment changes; reading insert/update/delete adds subscriber touch. For a technician with per-reader distribution enabled, only events concerning their old/new reader are returned; a projection reevaluates current scope and sends either a safe upsert or a tombstone to hide a subscriber.

The projection is **batch** SQL `powerhub_mobile_subscriber_projection` that checks the authorized tenant/branch and (if needed) current reader assignment, and computes latest approved reading and current-cycle reading. The API rechecks scopeVersion after projection before responding.

## Schema and permissions

Migration: `supabase/migrations/20261116231000_powerhub_mobile_subscriber_delta_journal.sql`; new journal + retention floor, indexes, subscriber/reading AFTER triggers, fence and batched projection. RLS enabled on new tables; no `anon`/`authenticated` direct table or function privileges, operations use privileged backend only. The existing service-role key is **never distributed to Android**. Prune procedure does not allow less than 90 days; scheduling and testing actual purge remains a separate operational acceptance step.

## Tests

- TypeScript: `server/mobile-delta-protocol.test.ts` signature, expiry, account/device/branch, bounds.
- HTTP simulated transport: `server/mobile-api.routes.test.ts` bootstrap paging, delta continuation, unauthorized branch and changed distribution, signed cursor tamper.
- Actual PostgreSQL 17 (disposable): `supabase/tests/mobile_subscriber_delta_journal.sql` verifies triggers, reading touches, old/new reader transfer, branch move tombstone, ACL, batched tenant/reader data isolation; mandatory in `.github/workflows/reading-cycle-sql-integration.yml`.
- Android PR #16 uses Room atomic checkpoints and Robolectric migration/recovery tests.

## Release gates

1. Mandatory CI on exact final commit of both PRs.
2. Protected Staging migration with explicit approval, matching migration version `20261116231000`.
3. Independent Staging check of RLS/ACL, projected data, assignment moves, tombstone retention, access revocation and older-client compatibility.
4. Real Android↔Staging authenticated integration across disconnected and resumed sessions, measured transferred rows, latency and no cross-tenant data.
5. Validate baseline on first login and reopen after >24h offline: render Room immediately, then Delta only. Confirm readings/payments queued during network outages stay preserved.
6. No merge or Production changes until engineering/security acceptance.

**Current release status:** NOT READY; test coverage in isolation is not evidence of authenticated Staging E2E.
