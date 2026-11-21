# PowerHub — Financial accrual adjustments and month-end review
**Staging review date:** 2026-11-09  
**Branch:** `feat/auth-local-first-single-pr` / PR #359  
**Status:** implemented and tested in Staging, not approved for final certified profit, not deployed to Production.

## Accounting boundaries

This is a **read-only provisional accrual report plus an isolated adjusting-entry subledger**, not a fully posted general ledger and not a certified income statement. The existing cash-settlement workflow remains separate.

- Invoices from completed Gaza-local service cycles enter the *provisional billed-service* view excluding tax. Unbilled service, cut-off, cancellations and manual adjustments require separate reconciliation. Do not relabel this figure as audited recognized revenue.
- Approved/paid payroll contributes **gross wages**, not net cash payout. Payroll cash and associated expense transactions must reconcile exactly; duplicate wage costs are not added.
- Supplier purchases, purchase payments and physical receipt of inventory are **not automatically period expenses**. Stock cost is applied based on effective issue/consumption and reversal events; unsupported classification is flagged.
- Cash settlement `financial_settlements` reconciles ledger/cash balances and is **not** the same as `financial_accrual_period_reviews`, which captures month-end accrual review evidence and adjusting journals.
- All financial report values are scoped to the authorized `tenant_id/site_id`; the user-interface routes still call `requireSupabaseSiteRole`. SQL RPC privileges are restricted to `service_role` and do not grant direct application end-user access.

## Current adjustment-journal contract

- One financial adjustment row is one positive, balanced debit/credit pair. Supported accounts/pairs are explicitly allowlisted.
- New entries are **draft**; only another authorized user can post. Posted rows cannot be edited, voided or deleted.
- Drafts can be **voided with recorded reason**, not deleted. Voided operation keys must not silently recreate drafts.
- An approved entry is corrected by a corresponding reversal **draft** for the original or a later period. A reverse-of-reverse is prohibited; a source has at most one reversing row.
- Repeat requests using the same operation key must be idempotent **only if payload, period, actor, and reason agree**; divergent retries fail. The UI shows the actual persisted draft/posted status.
- Cross-month reversal status is retrieved for original entries, including when reversal was posted or is awaiting approval in a later month. The UI does not offer a second reversal.
- A shared period advisory lock serializes month close against journal mutations; journal post/void/reverse acquire the period lock before taking row locks to avoid lock-order inversion.
- No fake success or partial report: failures in scope, arithmetic, completion, and source reconciliation are surfaced as errors.

## Month-end review and sign-off requirements

The review evidence covers these eight subjects, each with an auditable description/reference:
1. Unbilled electricity service and accrued adjustments.
2. Service-cycle/issue-date cut-off and invoice matching.
3. Supplier payables, returns and purchases.
4. Inventory valuation and usage treatment.
5. Gross payroll, advance deductions, payments and linked cash movements.
6. Fixed assets and depreciation estimates.
7. Provisions, doubtful debts and other obligations.
8. Taxes and settlement reconciliation.

The review is prepared and locked by **different authorized users**. A month cannot lock until the Gaza-local calendar month has ended, and **any** of the following prevents close:
- Missing or uncompleted invoice service-cycle information.
- Unclassified inventory issues, including fuel manually issued without an appropriate consumption event.
- Draft payroll runs or unreconciled paid-payroll expense/cash links.
- Draft adjusting journals.
- Missing evidence or a source calculation error.

A successful lock stores a snapshot and source fingerprint. Subsequent changes to the *computed statement* are flagged by `driftDetected`. A locked adjusting-entry period denies later journal creation/posting/voiding for that period; a correction must be made in an allowed later period.

**Important limitations:** this is not a complete immutable general ledger across all source tables. Some source updates are detected through snapshot drift rather than blocked. Completion of these gates alone does **not** certify revenue recognition or a financially balanced full balance sheet. Complete opening journals, external evidence verification, depreciation schedules, provisions and independent general-ledger reconciliation remain separate accounting release gates.

## Verification evidence (Staging only)

Staging was used for rollback-only fixture tests; no synthetic journal or review rows were intentionally retained.

- A debit/credit journal was created, approved by a second user, then reversed with the expected balancing effects.
- A closed test month blocked insertion into the same period, while allowing a reversal in a subsequent month.
- Retrying a reversal with the same operation key and payload returned the same identity; reusing that key with another reason was rejected.
- Direct editing/deletion of posted records was rejected; voiding a posted journal was rejected.
- Voiding a draft and retrying the exact void returned the idempotent result, whereas recreating a voided operation key was rejected.
- Incorrect scope (different tenant) was rejected.
- A real test period demonstrated that draft payroll prevents close. A Staging expense mismatch was detected by payroll payout reconciliation.
- Month-end checks currently show an October draft payroll and a November unclassified stock issue and incomplete service cycle. Thus those months are **not ready for closure**.
- The migrated RPCs remain service-role-only, with `anon`/`authenticated` excluded.

## Release gates

1. All four GitHub Actions gates on the **same head SHA**: PowerHub CI, PostgreSQL Integration, Security and Supabase Admin Guard.
2. Confirm Staging versions through `20261110001000` and match migration files; rerun authoritative report, source-error and isolation checks.
3. Test authenticated Preview UI using distinct authorized preparer/reviewer roles; verify create/post/void/reversal and real error messaging.
4. Concurrency tests from independent sessions (simultaneous reversal/post/close) on a staging fixture, and performance checks at scale.
5. Audit ledger source scope, required journal adjustments and full financial-statement accounting before any claim of final net income.
6. **No PR merge, Production migration, real payment or SMS** without separate explicit authorization.
