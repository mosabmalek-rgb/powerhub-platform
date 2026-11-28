# PR359 — live read-only finance cash/invoice baseline, 2026-11-17

Captured by the Supabase PostgreSQL read-only connector from Production `vvcdiqcyhaloxesvpppc` and Staging `iyuryuhaylhisjfcrwkz` against source head `b333f9626b832ea8d26ea26bcbefbf15affb427d`.

SQL to repeat: `scripts/sql/pr359-finance-live-cash-proof.sql`.
Raw aggregated evidence: `docs/security/pr359-phase1-finance-live-cash-proof-20261117.json`.
Validator: `scripts/pr359-finance-live-cash-proof.mjs` with mutation/fail-closed regression tests. No individual subscriber, payment, account or invoice IDs are stored.

## Captured financial invariants

| Capture | Production | Staging |
|---|---:|---:|
| Paid and linked collections | 5 / 1,260.00 | 6 / 667.00 |
| Invoice rows | 20 | 4 |
| Total invoiced | 4,647.30 | 2,672.50 |
| Invoice paid | 1,260.00 | 667.00 |
| Invoice due | 3,387.30 | 2,005.50 |
| Payment-to-cash account links: exactly one per payment | 5/5 | 6/6 |
| Per-payment cash amount differs | 0 | 0 |
| Wrong/cross-tenant cash links | 0 | 0 |
| Paid totals and balance arithmetic mismatch | 0 | 0 |
| Account transaction rows (all transaction types, including synthetic load) | 8 | 361,009 |
| Missing payment-split columns | 3 | 0 |
| Missing subscriber credit ledger | yes | no |

Note: the account-transaction **gross sum is not cash balance** and must not be treated as net liquidity. Staging contains a large synthetic load cohort; do not represent it as Production-equivalent data.

## Confirmed dependency order, not authorization

1. `20261103131052_powerhub_subscriber_credit_ledger.sql` — adds credit ledger / payment purpose.
2. `20261103131104_powerhub_subscriber_liability_and_cash_allocation.sql` — adds financial split and deposit accounting.
3. `20261103131125_powerhub_statement_operating_collection_summary.sql` — updates collected operating totals.
4. `20261103145232_powerhub_legacy_unlinked_payments_to_subscriber_credit.sql` — repairs historical unlinked receipts, idempotently.

All four have SQL-bearing Staging ledger rows and no directly matching Production rows. The first two sources are large (53/94 KB), not yet tested end-to-end against a restored Production-derived schema/data snapshot. Core referenced relations inspected in the current Production catalog exist except the subscriber credit ledger, which is intentionally first created by this chain. No claim of full dependency closure follows from that scoped check.

## Blocking decisions

- `MIGRATION_RECONCILIATION_PASS`: **NOT GRANTED** — 28 historical mismatch cohorts and separate missing-retained-SQL cohorts need catalog and behavioral attestation.
- `PRODUCTION_SHADOW_UPGRADE_PASS`: **NOT TESTED** — no verified source-backed restore, repeatable complete upgrade or failure recovery.
- `PR359_MERGE`: **NO-GO**, Draft.
- These immutable captured aggregates are a baseline, not a live future snapshot, financial audit signoff, RLS penetration test, or Shadow upgrade outcome.

Production and Staging were queried in read-only mode; no migrations, writes, SQL history repair, SMS, or external cash movement occurred.
