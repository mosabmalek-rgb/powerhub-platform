# B5.22 — Preview-only authenticated HTTP stage tracing

**Purpose:** identify the highest-cost stage of B5.20 financial report reads after the real
HTTPS acceptance failed (site GL statements 36/40, company audit p95 >3000ms).
This is **observability only**, not a performance fix or accounting acceptance.

## Scope and privacy

Only exact, individual GET paths are traced when `VERCEL_ENV=preview`:

- `/api/trpc/powerhub.reports.financialGLSubledgerReconciliation`
- `/api/trpc/powerhub.reports.financialGLCompanyMovementAudit`
- `/api/trpc/powerhub.reports.financialGLSiteStatements`

No mutation, batched path, other route, non-Preview deployment or unlisted GET
is traced. Each eligible request receives `X-PowerHub-B5-Trace`, a cryptographically
random UUID, and `Cache-Control: no-store`. The UUID is **not an authentication
credential** and cannot authorize any access. Retain it only for controlled log
correlation, not in public support logs or analytics.

Vercel emits **one** `[PowerHub B5 HTTPS trace]` record on response finish or
close. Values are limited to: random trace UUID; allowlisted route; finish/close;
HTTP response status; request duration; fixed stage durations; residual duration;
fixed failed-stage name; `VERCEL_REGION`, `AWS_REGION`, declared `sin1` configuration.
No user ID, branch ID, tenant ID, token, cookie, device ID, request body, query
string, IP address, raw exception or financial report values are logged.

## Measured stages

| Field | What it includes | What it does NOT establish |
|---|---|---|
| `jwtVerify` | Supabase verification operation/10s verified-claims reuse | Not a database role decision |
| `profileRead` | Fresh `users` profile query and transport | Not bootstrap profile writes on ordinary GET |
| `deviceClaim` | Current device lease RPC and transport | Not bypass of competing-device protection |
| `maintenanceRead` | Current maintenance policy query/transport | May not execute for exempt platform admins |
| `siteAccessRpc` | Current tenant/site authorization snapshot + transport | Not only PostgreSQL executor time |
| `financialRpc` | Corresponding financial PostgREST RPC and transport | Not only PostgreSQL executor time |
| `totalMs` | Server-side request path beginning at Express trace middleware | Not the client-observed full HTTPS duration |
| `unmeasuredMs` | Residual: total minus measured stages | Mixed routing, local checks, scheduling, response etc.; not a separately timed RPC |

These timings are *inclusive* of network/queue time for the respective SDK calls;
compare with read-only `pg_stat_statements` aggregates for evidence, but do not
present SQL plan timings as a sample-matched network trace. The user-facing browser
runner measures a different, full HTTPS interval and remains the acceptance authority.

## Gate and diagnostic procedure

1. Verify exact new Git SHA, same-SHA five CI results, READY Preview, and Staging
   migration ledger; do **not** run on an old Preview.
2. From the **existing authorized single-device Staging session**, make one
   authenticated HTTPS GET of each report; then, if preflight passes, run a
   bounded diagnostic (for example, 10 reads at concurrency 1, then 10 at 4).
   No device unlock/transfer or financial write is part of this diagnostic.
3. Match the response `X-PowerHub-B5-Trace` to the single matching Vercel trace,
   and compare the client-observed duration against server `totalMs`. If
   the request times out before headers arrive, correlate with an approximate
   time window and route only; **do not fabricate a UUID**.
4. Separate auth, profile, lease, maintenance, live RBAC snapshot, financial
   RPC and residual time. Confirm **effective** `functionRegion` from actual
   runtime trace; do not infer it from the deployment metadata region alone.
5. Keep timeout **8000ms**, per-report acceptance **p95 <=3000ms**, 100 valid
   responses per report, concurrency 4, zero HTTP failures/timeouts and exact
   tenant/site/period/`NOT_CERTIFIED` assertions for the subsequent full run.
   A diagnostic or CI PASS is not an acceptance PASS.
6. Keep `B5_REAL_AUTHENTICATED_HTTP=FAIL`,
   `ENGINEERING_CONDITIONAL_NOT_FINALLY_ACCEPTED` and
   `ACCOUNTING_CERTIFICATION=NOT_CERTIFIED` until repeat acceptance passes.
   PR #359 stays Draft; Production is unchanged.

**Do not raise timeouts**, bypass RBAC or device checks, remove independent
source-integrity verification, delete frozen performance-fixture rows, or label
partial results as accepted to make this benchmark pass.

## Current engineering status

Tracing has been added on the PR branch with unit tests but **not** yet
verified through the authorized HTTPS acceptance session on a newly built
SHA-matched Preview. The former B5.20 run remains FAIL.
