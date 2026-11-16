# E45 — Staff Auth-to-profile provisioning correction (2026-11-16)

**Staging only. No migration, merge, or Production changes.**

## Root cause and canonical architecture

The subaccount create route in server/powerhub.ts first created a Supabase Auth user, then assumed public.users was created by an Auth trigger. There is no non-internal INSERT trigger on auth.users in Staging. The existing login bootstrap (server/supabase-profile.ts) and owner provisioning already insert the profile explicitly on the trusted server. The E45 defect was this one route's assumption, not a missing global trigger. No Auth trigger was introduced.

## Implemented code

- server/staff-auth-provisioning.ts: creates the new public.users row through server-only service admin, with Supabase Auth ID, database-generated bigint ID, normalized identity fields, role=user, null platform role, active status and forced temporary-password reset. The response is validated before staff assignment.
- The route preserves owner/manageTeam site authorization, package and multi-branch entitlement, then uses the existing service-role-only powerhub_assign_existing_staff RPC to assign member, staff profile, quota and audit atomically **within PostgreSQL**.
- Compensation runs only before assignment or after a definitive PostgreSQL rejection. An ambiguous RPC transport result may still commit later, so Auth is preserved immediately for reconciliation without attempting deletion. In eligible compensation paths, checks for all tenant membership and staff associations must pass; if already assigned or verification fails, Auth is preserved rather than cascade-deleted. Auth deletion errors are checked in both returned-error and exception forms.
- Auth Admin creation and PostgREST calls cannot share one transaction. This is verified compensation, not a claim of distributed atomicity.
- server/staff-auth-provisioning.test.ts: regression tests for creation, malformed responses, state uncertainty, assignment already committed, ambiguous post-commit outcomes, and Auth deletion failure.

## Required before accepting E45 live

1. Validate five CI gates on exactly the final SHA, plus an exact-SHA READY Vercel Preview.
2. Use an owner-authenticated Staging session and the standard subaccounts UI to create a uniquely identified test accountant. Verify the Auth ID, matching public.users, tenant member, branch staff profile, temporary-password flag and assignment audit. Do not expose passwords or tokens.
3. Verify that same-account retries neither duplicate profiles nor destroy an already committed assignment.
4. Provision independent no-report and revocable nonowner accounts using the same normal path; run the E44 legitimate device-bound before/after role matrix.
5. Keep the E44 live and F release gates blocked until real HTTPS acceptance. No disabling Device Lock or Vercel protection.

## State at commit

E45_SOURCE_FIX=COMMITTED
E45_CI=AWAITING_FINAL_SHA
E45_STAGING_BROWSER_CREATE=NOT_EXECUTED
E44_NONOWNER_LIVE_HTTPS=NOT_EXECUTED
ACCOUNTING_CERTIFICATION=NOT_CERTIFIED
PR_359=OPEN_DRAFT_UNMERGED
PRODUCTION=UNCHANGED
