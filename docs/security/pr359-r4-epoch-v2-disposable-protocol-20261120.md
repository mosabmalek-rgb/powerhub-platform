# PowerHub PR359 — Epoch v2 disposable transition protocol (not R4 release approval)

**Purpose:** Prove in an isolated, networkless PostgreSQL 17.6 container that an
**illustrative** new epoch can coexist with an untouched historic Supabase
migration ledger. This is not the PowerHub canonical Baseline and is not a
Staging/Production migration or a Supabase migration history rewrite.

## Boundaries

- Workflow executes only Docker `postgres:17.6` with `--network none`; zero host ports;
  rejects inherited source URLs/tokens. No hosted credentials or Supabase remote tools.
- `supabase_migrations.schema_migrations` in this fixture includes the **six**
  column names/type categories verified read-only on the hosted databases, with
  only two invented test rows. It is not a backup of the 553/486 live records.
- `pr359_epoch_v2_demo.epoch_contract` and `epoch_migrations` are
  separate, test-only tables; a fixed SQL change alters `invoice_shadow`, never
  `supabase_migrations`. Fixed expected SQL SHA and toy baseline fingerprint
  reject unauthorized values.
- A PostgreSQL transaction-scoped advisory lock serializes concurrent retries,
  and DDL + v2 entry are atomic. Historical ledger SHA is checked before
  each execution. Replays verify both SQL checksum and applied column.
- Negative cases: wrong version/hash/baseline, missing epoch, tampered historical
  ledger, injected failure after DDL, explicit ROLLBACK, concurrent double
  submit. Successful tests assert original finance-fixture values are unchanged.

## What passing proves and what it DOES NOT

`PR359_EPOCH_V2_DISPOSABLE_PROTOCOL_PASS` proves only the
**disposable, artificial, protocol-level** invariants on the tested Git SHA.
It does NOT prove that the complete 978-object PowerHub application baseline
can be created from an empty compatible Supabase Local Stack; that 553 Staging
legacy records have been exported durably; that real Auth/Storage/Cron/Outbox
are compatible; or that permissions/SQL hashes of future migrations are
reviewed. No actual In-place Staging rebaseline path has been authorized.

Before Staging R4: review and sign a canonical APP_OWNED manifest, pin its
SQL SHA and independently build it from empty local Supabase, attest a fresh
encrypted persistent off-runner backup and actual recovery, review exact
preservation/migration of all Staging ledger history, verify Auth/Storage,
tenant RLS and offline Outbox/Delta epochs, then obtain explicit approval to
run a dedicated protected Staging workflow. Avoid `db reset --linked`,
direct migration ledger edits/repair, or broad `DROP SCHEMA CASCADE`.

**Gates:** `R4_EPOCH_V2_DISPOSABLE_PROTOCOL_ONLY`,
`R4_CANONICAL_BASELINE_ACCEPTED=false`,
`R4_STAGING_INPLACE_GO=false`, `PR359_MERGE_GO=false`.
