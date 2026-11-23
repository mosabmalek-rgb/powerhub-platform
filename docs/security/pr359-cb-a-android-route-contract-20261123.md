# PR359 CB-A — Android ↔ PowerHub route-level compatibility evidence

Captured 2026-11-23 (source-only, no hosted writes).
Android repository: `mosabmalek-rgb/app-power-` at `9ab3ad5c256920338f8f277c51036e7df8a347bb`.
Android source: `app/src/main/java/com/example/data/api/FieldReadingApi.kt` (immutable Git blob `cda3e4b234b6faec160cf23d8b99745f0a5962f6`).
PowerHub server: `server/mobile-api.ts`, reviewed at parent PR HEAD `2976a2bd38e2ef451e4e24b7ef6896f910f24378`.

## Findings

- All **ten** Retrofit HTTP method/path declarations map to existing PowerHub Express routes.
- PowerHub also declares `GET /api/mobile/v1/subscribers/delta` (E51). That route is **not** declared in this Android Retrofit source.
- Android `FieldReadingRepository.refreshSubscribers()` still calls paginated `api.getSubscribers(branchId,100,cursor)` and replaces its local subscriber snapshot after fetching the pages.
- The Android app may still be functionally compatible with the legacy endpoint, but its end-to-end Delta Sync is **not verified or implemented in this pinned Android source**.
- Across 44 Kotlin/Java files in `app/src` at the pinned Android head, an exact-name scan found **zero** literal matches for the eleven PostgreSQL objects currently investigated by CB-A. This is not a full runtime dependency graph.

## Enforcement and review bounds

The Docker Shadow workflow checks exact Retrofit method/path declarations from a pinned copy of Android source against the server routes. It rejects renamed routes, incorrect methods, new unexpected server-only endpoints and altered Android snapshot bytes. No network or external Android credentials are required in CI. The pinned Android snapshot requires intentional refresh after the Android upstream code changes.

Route parity says nothing about DTO fields, authentication, authorization, credential handoff, HTTP status handling, offline recovery, WorkManager, Room migration, RLS, trigger dependencies, or app runtime acceptance. Explicit Delta implementation requires a separate Android code change, transactional Room updates, cursor/cycle/scope guards and failure-injection tests. This guard must never label the incomplete Delta integration as green.

CB_A_ANDROID_ROUTE_PARITY=CI_PENDING
ANDROID_DELTA_END_TO_END_ACCEPTED=FALSE
COMPLETE_RUNTIME_CALL_GRAPH_APPROVED=FALSE
CANONICAL_BASELINE_APPROVED=FALSE
STAGING_INPLACE_GO=FALSE
PRODUCTION_INPLACE_GO=FALSE
PR359_MERGE_GO=FALSE

## 2026-11-23 revision — re-pinned after Android PR #17 was merged

The initial 10-route finding above is **historical evidence only**, from
Android base `9ab3ad5c`. It must not be used to describe current Android main.

After verified squash merge of Android PR #17, the reviewed Android main commit
is `a4e8c2d077022146e71e8a47d2fc6377e92d8b9c`.
Its `FieldReadingApi.kt` Git blob is
`8a4da94bfabe14839f1cce9aec60cf06879479d6`.
The updated pinned fixture contains **11 Retrofit routes**, including
`GET /api/mobile/v1/subscribers/delta`, all of which have matching
method/path declarations on platform PR #359. The server-only route count is
now zero. The Android repository merged code also supports safe legacy
pagination when an older deployed server returns 404 for Delta.

This is only a code-level method/path compatibility finding. It does NOT
establish a real deployed Delta endpoint, HTTP DTO compatibility, valid
privileges, successful end-to-end sync or release readiness. Android CI
passed before squash merge; that does not constitute platform runtime acceptance.

CB_A_ANDROID_ROUTE_PARITY=CODE_GATED_ON_MERGED_PR17_SNAPSHOT
ANDROID_DELTA_ROUTE_DECLARED=TRUE
ANDROID_DELTA_END_TO_END_ACCEPTED=FALSE
COMPLETE_RUNTIME_CALL_GRAPH_APPROVED=FALSE
CANONICAL_BASELINE_APPROVED=FALSE
STAGING_INPLACE_GO=FALSE
PRODUCTION_INPLACE_GO=FALSE
PR359_MERGE_GO=FALSE
