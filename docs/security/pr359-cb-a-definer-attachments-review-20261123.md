# PR359 CB-A — read-only SECURITY DEFINER trigger audit

2026-11-23; Staging source project `iyuryuhaylhisjfcrwkz`.
The SELECT-only catalog query is in
`scripts/pr359-canonical/staging-definer-trigger-attachments.sql`.
The pinned evidence file is
`docs/security/pr359-cb-a-definer-trigger-live-evidence-20261123.json`
(Git blob `96faae9291f938d3f4ac739603e4d962a533c168`).

Three live SECURITY DEFINER functions have direct anon/authenticated
EXECUTE denied and service_role EXECUTE allowed. Two enabled triggers were
observed:
- `tenant_subscriptions` AFTER INSERT invokes
  `powerhub_ensure_owner_main_site()` through
  `trg_powerhub_owner_subscription_main_site`.
- `generators` AFTER UPDATE OF name invokes
  `powerhub_refresh_fuel_maintenance_delta_after_generator_name_up()`
  through `powerhub_delta_fuel_maintenance_generator_name`.
- `powerhub_mobile_touch_session(...)` has **no direct pg_trigger
  attachment in the captured catalog**. This does NOT prove it is unused.

The pinned `server/mobile-api.ts` blob
`b1dc71a6be81565298236c6239c56911f5c95e71` executes a scoped
conditional UPDATE on `mobile_api_sessions` in
`authenticateMobile()` (user, tenant, session, revocation, expiry).
That source file has no literal direct RPC invocation of
`powerhub_mobile_touch_session`; this is NOT a complete caller audit.

Risks still requiring independent security review: both trigger
attachments, privileged function ACLs, trigger ordering, effective tenant
and site isolation, side effects of sites/staff creation, generator-name
propagation limits (500 fuel events, 200 work orders), advisory locking,
service-role call routing, PL/pgSQL indirect calls and
managed dependencies. No trigger firing or hosted behavior was tested.

Run locally:
```bash
node --test scripts/pr359-canonical/cb-a-definer-attachments.test.mjs
node scripts/pr359-canonical/cb-a-definer-attachments.mjs --out /tmp/pr359-cb-a-definer-triggers.json
```
Docker Shadow exports `pr359-cb-a-definer-triggers.json` in
`pr359-cb-a-candidates`. This is immutable forensic evidence only.

```text
CB_A_DEFINER_TRIGGER_CATALOG_ATTESTATION=CI_PENDING
CB_A_RUNTIME_CALL_GRAPH_APPROVED=FALSE
CB_A_FUNCTION_SECURITY_SIGNOFF=FALSE
APP_OWNED_APPROVED=FALSE
CANONICAL_BASELINE_APPROVED=FALSE
CLEAN_BOOTSTRAP_PASS=FALSE
STAGING_INPLACE_GO=FALSE
PRODUCTION_INPLACE_GO=FALSE
PR359_MERGE_GO=FALSE
```
