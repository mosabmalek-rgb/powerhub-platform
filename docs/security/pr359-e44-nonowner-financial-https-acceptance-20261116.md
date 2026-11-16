# PR #359 — E44 non-owner financial HTTPS acceptance

**Status: CODE HARNESS ADDED / LIVE HTTPS NOT EXECUTED.** This is an operational acceptance gate, not an accounting certification. Do not silently mark it accepted because Node mock transport tests pass.

## Required Staging identities and topology

The **current** test-only Staging topology is tenant 1/site 1, a second active branch site 9000000000099 in tenant 1, and independent tenant 13/site 13. Existing active test memberships/staff profiles observed during this work have **only owner roles**; they cannot substitute for the following new legitimate identities:

1. A device-bound **non-platform-admin accountant** with site-scoped \`viewFinancialReports\` on tenant 1/site 1, **not** site 9000000000099 or tenant 13/site 13.
2. A separate, device-bound active **non-owner identity** on tenant 1/site 1 without \`viewFinancialReports\`, whose protected financial requests must return 403 \`FORBIDDEN\`.
3. Another separate, device-bound active **non-owner identity** with report permission on tenant 1/site 1 to be **revoked by an authorized Staging admin between runs**. The same genuine session and bound device must be retained, and the denial must apply without a new sign-in, role-cache delay or lease bypass.

Provision identities only using supported Staging Auth and normal membership/profile flows. Do not fabricate JWTs or reuse account/device identities. Never weaken the single-device lock, alter source GL ledgers, modify Production, or disable Vercel Deployment Protection.

## Runner

The read-only runner is \`scripts/e44-financial-role-matrix-http.mjs\` with CI-covered transport mocks in \`scripts/e44-financial-role-matrix-http.test.mjs\`. The CI step calls:

\`\`\`bash
node --test scripts/e44-financial-role-matrix-http.test.mjs
\`\`\`

To run actual **HTTPS**, supply all these variables securely as environment variables **only on the private test host**, not in GitHub comments, chat transcripts or an uploaded artifact:

\`\`\`text
POWERHUB_E44_PREVIEW_URL=https://powerhub-platform-<sha-preview>-mosabmalek-rgb.vercel.app
POWERHUB_E44_TENANT_ID=1
POWERHUB_E44_SITE_ID=1
POWERHUB_E44_SIBLING_SITE_ID=9000000000099
POWERHUB_E44_FOREIGN_SITE_ID=13
POWERHUB_E44_PERIOD=2026-11
POWERHUB_E44_PHASE=before
POWERHUB_E44_ACCOUNTANT_TOKEN=(private current token)
POWERHUB_E44_ACCOUNTANT_DEVICE_ID=(private bound UUID)
POWERHUB_E44_NO_REPORT_TOKEN=(different private token)
POWERHUB_E44_NO_REPORT_DEVICE_ID=(different private bound UUID)
POWERHUB_E44_REVOCABLE_TOKEN=(third private token)
POWERHUB_E44_REVOCABLE_DEVICE_ID=(third private bound UUID)
\`\`\`

Verify that all three live accounts are **distinct** and authorized; record their role/branch assignments through an internal protected test ledger, not a public PR comment. Also verify that the exact Preview is READY and matches the final Git SHA before each phase. Use an existing authenticated browser session or properly bound test runner transport that passes Vercel's existing protection controls. Do not disable that protection.

- **Before revocation:** \`POWERHUB_E44_PHASE=before node scripts/e44-financial-role-matrix-http.mjs\`. The runner checks readiness + 14 HTTP assertions: 3 authorized accountant reads, 3 forbidden sibling-branch reads, 3 forbidden foreign-tenant reads, 3 explicit no-report-role 403 denials, 1 authorized revocable-user read and 1 anonymous 401 denial.
- An authorized Staging admin then revokes only the third identity's \`viewFinancialReports\`, using the supported permission interface while the third user remains logged in on its existing device.
- **After revocation:** run with the **same token, session and device** and \`POWERHUB_E44_PHASE=after\`; this run makes the same requests, with an additional mandatory 403 \`FORBIDDEN\` for the third identity. If token expiry, new sign-in or Device Lock interferes, the result is \`NOT_EXECUTED\`, not an implied revocation success.
- Both phases contain no SQL mutations, browser login, session-claim workaround, or financial writes; each returns a non-sensitive summary that intentionally omits device IDs, tokens, response bodies, emails and user IDs.

The runner's phase result has \`activeSessionPermissionChangeProven:false\` **even when both phases pass**. This is deliberate: a process cannot independently prove that an admin changed exactly the intended permission between two separate executions. Only an auditable, time-correlated record showing one stable authenticated session/device and the authorized change permits the reviewer to set \`E44_LIVE_SESSION_REVOCATION=PASS\`.

**Strict result labels:**
\`\`\`text
E44_CODE_MOCK_TRANSPORT=CI_DEPENDENT
E44_NONOWNER_LIVE_HTTPS=NOT_EXECUTED
E44_LIVE_SESSION_REVOCATION=NOT_EXECUTED
ACCOUNTING_CERTIFICATION=NOT_CERTIFIED
\`\`\`

Existing D36 16/16 authenticated **owner** tenant-isolation evidence is preserved but cannot replace E44. Likewise B5 synthetic load CI is not authenticated B5 tail-latency evidence. Failed or protected fetches must never be counted as business 401/403 responses.

## Current preview verification before the E44 code change

A Vercel Preview \`dpl_GxFpD3GHM2F1UvYZoJWy9BSNEY6W\` on exact former head \`066aaa1fbf5b48bca11327a14845248f7b236245\` reached **READY** and its protected \`/api/ready\` and \`/api/health\` returned HTTP 200; \`/api/ready\` confirmed Supabase connectivity true. Financial routes without genuine session proof could not be accepted because Vercel deployment authentication blocked the available fetch mechanism. This preview is **not** evidence for a later E44 commit SHA. Provision/recheck a new exact-head Preview before live E44 acceptance.
