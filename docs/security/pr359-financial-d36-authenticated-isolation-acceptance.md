# D36 — Authenticated financial tenant/site HTTPS acceptance

**Status:** harness and simulated response regressions, not live authenticated acceptance. Head after this change must pass all five CI gates independently.

This opt-in, read-only acceptance harness makes **seven checked API calls** plus /api/ready on a SHA-matched Staging Preview:
- Legitimate financial close readiness, GL trial balance, and site statements for an authorized test tenant/site, requiring exact tenant/site/period, nonfinal results and NOT_CERTIFIED.
- The *same non-platform-admin* authenticated account must receive FORBIDDEN or NOT_FOUND without any financial data from a **different tenant's site** for all three reports.
- An anonymous request must return 401 UNAUTHORIZED.
- HTTP GET only, no financial writes, login or credential issuance, no fallback to a mock for live acceptance, no token/body logging. Strict hostname allowlist.
- Node mock-transport unit tests run in PowerHub CI; passing them is **not live HTTPS evidence**.

The test account must already have an active owner/manager/accountant/viewer role with `viewFinancialReports` on the allowed site, **no access to the foreign tenant/site**, and a legitimate single-device lease. Do not use a platform-admin user who may legitimately access multiple tenants, or release another account's device lease.

Environment variables are supplied privately on the testing host, never in GitHub comments, documents or chat:
`POWERHUB_D36_PREVIEW_URL`, `POWERHUB_D36_ACCESS_TOKEN`, `POWERHUB_D36_DEVICE_ID`, `POWERHUB_D36_TENANT_ID`, `POWERHUB_D36_SITE_ID`, `POWERHUB_D36_FOREIGN_SITE_ID`, `POWERHUB_D36_PERIOD`.

Run: `node scripts/d36-financial-tenant-isolation-http.mjs`.

**Acceptance conditions:** exact valid session, 7/7 real HTTPS results and readiness, no financial mutation, live deployment SHA captured, CI five green on the matching head. Any missing credentials, expired device lease, upstream transport error, foreign-site 200, or stale financial response results in `NOT_ACCEPTED`, not a pass.

Current Staging tenant 1 has test site 1, while test performance tenant 9000000000001 has sites 9000000000011 and 9000000000012. The current connected tools do not provide a valid device-bound session for a *non-platform-admin* tenant test user on both sides. Consequently **D36_LIVE_AUTHENTICATED_ISOLATION=NOT_EXECUTED**, not waived or passed. The current prelaunch synthetic opening 19 remains without independent source evidence; D35 demonstrated January–October distortion despite the November correction. Accounting certification still NOT_CERTIFIED, PR Draft/unmerged, Production unchanged.
