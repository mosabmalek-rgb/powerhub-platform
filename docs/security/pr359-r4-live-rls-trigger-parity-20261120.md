# PowerHub — PR359 R4 Staging RLS and trigger definition parity

Source SHA: `fe1c3ca15f6c6f88ace85dff5397874c6bb39f62`; captured read-only 2026-11-20, project `iyuryuhaylhisjfcrwkz`.

## Observed result

- 129 of 129 `public` application RLS policies matched R0. Checks include target table and name, permitted roles, permissive flag, command, and SHA-256 of both `USING` and `WITH CHECK` expressions.
- 202 of 202 non-internal `public` application triggers matched R0. Checks include target/name, enabled state, invoked function identity and SHA-256 of `pg_get_triggerdef(oid,true)`.
- Five read-only queries, four batches of 75 and one of 31; all returned zero missing/changed records and each saw exactly 331 current app policies/triggers.
- The source also includes 19 separately managed/shared `realtime` and `storage` policies/triggers. They were deliberately not classified as app-owned or release-removable; they are outside this app-scope evidence.

## Reproducibility and fail-closed checks

`scripts/pr359-r4/rls-trigger-parity.mjs` reads the R0 JSON inventory, emits five SQL queries, and validates saved JSON reports. It has no database connection capability. Example for local preparation only:

```sh
node scripts/pr359-r4/rls-trigger-parity.mjs --emit-sql /tmp/pr359-r4-security
```

Run emitted SELECT-only statements against Staging via a reviewed read-only connection; save each single JSON result in its named `.result.json` file, then run:

```sh
node scripts/pr359-r4/rls-trigger-parity.mjs --check-results /tmp/pr359-r4-security
```

CI tests the source shape, query composition and fail-closed report validation; actual live Staging read-only query results were reviewed separately. These are repeated SELECTs, not a single consistent snapshot. The provider managed schemas, live RLS behavior under actual user sessions, current object grants/ACLs, external functions, canonical empty-stack baseline, independent backup and signed per-object APP_OWNED release allowlist remain separate acceptance requirements.

`R4_RLS_POLICY_DEFINITION_PARITY=129_OF_129`
`R4_TRIGGER_DEFINITION_PARITY=202_OF_202`
`R4_PROVIDER_MANAGED_DROP_AUTHORIZATION=false`
`R4_STAGING_INPLACE_GO=false`
`PR359_MERGE_GO=false`
