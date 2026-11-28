# PR359 — R4 live Staging relation / column / ACL metadata parity

Date: 2026-11-20. Starting SHA: `d64e54537e46a91733ffce913e7aae88f42ea23b`. Environment inspected: **Staging** `iyuryuhaylhisjfcrwkz` (SELECT-only).

## Result observed

- The 337 historical R0 relation/sequence identities match the live catalog: 173 public tables, 152 public sequences, 10 private tables and 2 private sequences.
- All **2,723** ordered column entries match in name/type, nullability, identity/generated flags and SHA-256 of SQL default expressions.
- Every relation matches owner, relkind, extension membership, table/sequence ACL hash (hash over `relacl::text`), RLS/FORCE RLS, and role SELECT privilege for `anon` and `authenticated` (NULL for sequences).
- Fourteen independent batches of up to 25 objects returned 0 missing and 0 changed; each counted 337 live objects.
- All SQL was read-only and no table values, Auth identities, ACL source text or default source expressions were returned.

## Re-run and regression guard

`scripts/pr359-r4/relation-parity.mjs` reads the repository's R0 relation inventory and creates 14 SQL files for an explicitly authenticated Staging read-only query operator:

```sh
node scripts/pr359-r4/relation-parity.mjs --emit-sql /tmp/pr359-r4-relations
```

Store each one-line JSON result (as emitted by `psql -qAt -X`) to the matching `relations-XX.result.json` filename and validate:

```sh
node scripts/pr359-r4/relation-parity.mjs --check-results /tmp/pr359-r4-relations
```

The local checker rejects wrong count, missing result, unexpected column or role metadata, duplicated evidence, and observed SHA/ACL changes. Its tests are included in the Docker Shadow smoke job. CI tests file generation and fail-closed validation, not remote live Staging SQL. The separately stored result summary is observational evidence from this date.

## Acceptance boundary

These are **14 independent reads**, not a transactionally consistent catalog signature. No application-owned object has yet received a signed removal classification. Table definition parity alone does not prove full grants, SECURITY DEFINER runtime policies, stored financial data, empty-stack canonical build or safe offline Outbox migration. No mutating SQL or linked remote reset is authorized.

`R4_RELATION_METADATA_PARITY_OBSERVED=337_OF_337`
`R4_COLUMN_METADATA_PARITY_OBSERVED=2723_OF_2723`
`R4_STAGING_LIVE_SNAPSHOT_ATOMIC=false`
`R4_APP_OWNED_SIGNED=false`
`R4_STAGING_INPLACE_GO=false`
`R6_PRODUCTION_INPLACE_GO=false`
`PR359_MERGE_GO=false`
