# PR359 Phase 1 — P0 current-catalog evidence (17 November 2026)

**Source head at capture:** `0fea781e108c8d3769b7a6ca299546b74b4f064f`  
**Staging:** `iyuryuhaylhisjfcrwkz`  
**Production:** `vvcdiqcyhaloxesvpppc`  
**Method:** `scripts/sql/pr359-p0-live-catalog-audit.sql` executed read-only in each environment. No business-row query, historical ledger edit, SQL migration, or privileged RPC invocation.

## CI evidence and scope
- `scripts/pr359-p0-live-catalog-review.mjs` validates the current catalog fingerprint/ACL evidence against 12 explicitly enumerated P0 historical crosswalk groups, without granting historical equivalence.
- `scripts/pr359-p0-live-catalog-review.test.mjs` asserts the observed differences and fail-closed behavior against tampering or false historical acceptance.
- `docs/security/pr359-phase1-p0-live-catalog-20261117.json` is the environment-specific recorded metadata. Refresh only after a new authorized read-only catalog audit and source review.
- These results are **catalog evidence only**. They are not authenticated session/RLS behavioral penetration tests, restored Production business-data tests, or evidence that an archive with missing SQL was executed.

## Verified current gaps
1. Production `public.chat_messages` allows a `manageSupportChat` RLS branch without a support-conversation check; Staging narrows it. Historical `chat_rls_security_v1` must not be replayed as a patch. A forward-only migration already exists in the source and still requires a safely ordered release.
2. Chat Realtime and Storage policy fingerprints differ materially across environments; do not infer tenant isolation solely from policy names.
3. Three private chat trigger functions allow `anon` EXECUTE in Production but not Staging. The `private` schema does not grant `anon` USAGE, so this alone is **not proof of direct callability**.
4. Production financial overview's SQL differs from Staging's purpose-aware `invoice_applied_amount` implementation. The three required payments fields and subscriber balance ledger are missing in Production.
5. The four core finance migrations `20261103131052`, `20261103131104`, `20261103131125`, `20261103145232` are confirmed recorded with retained SQL in Staging and absent by those versions in Production. They are a **known ordered dependency chain**, not a certification of the complete Production upgrade.
6. The `powerhub_unified_messaging_history` overload exists in Staging and is absent in Production; verify server-side optional fallback before selecting a forward release.
7. Stored SQL for the three more recent hardening versions `20261107130443`, `20261108111500`, `20261108120000` is unavailable in the Staging ledger. Current catalog effects are not equivalent to historical execution proof.

## Release gate
**`MIGRATION_RECONCILIATION_PASS = NOT GRANTED`**. **`PRODUCTION_SHADOW_UPGRADE_PASS = NOT TESTED`**.
No verified Production-derived restored Shadow is available. Supabase Production's development branch inventory was empty at this check, and a newly created schema-only branch would not substitute for a production-data restore. The audited P0 list also does not resolve the separate 85 missing-SQL ledger records or full 700-file source crosswalk.

**PR #359 remains Draft / NO-GO.** No Production deployment, ledger edit, direct replay of historic SQL, or financial-data mutation is authorized by this artifact.
