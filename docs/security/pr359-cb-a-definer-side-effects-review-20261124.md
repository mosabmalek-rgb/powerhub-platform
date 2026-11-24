# PR359 CB-A — SECURITY DEFINER side-effect review queue

2026-11-24 · Source: Staging `iyuryuhaylhisjfcrwkz` read-only
PostgreSQL catalog inspection, plus pinned SQL definitions already archived
in `pr359-cb-a-six-function-live-evidence-20261123.json`.

**Evidence only**; these tests do not simulate concurrent database
transactions or exercise the functions and may not be used to approve
baseline DDL, hosted changes, or PR #359 merge.

## Owner main-site trigger

`powerhub_ensure_owner_main_site()` is a privileged AFTER INSERT
trigger of `tenant_subscriptions`. The observed function chooses a
site within `NEW.tenant_id` and, when absent, inserts a new named
`sites` row and attempts to attach an active owner to
`staff_profiles`. The observed `sites` indexes are unique on
`id`, `code`, and `tenant_id,id`, but not `tenant_id,name`.
The subscription index is unique on `tenant_id`; this does not
automatically prove that *all* concurrent site-insertion paths cannot
race. **Required review:** concurrency/lock strategy for any existing
site creation flows, owner-assignment idempotency, tenant and role
isolation, and trigger ordering. This is a risk candidate, not an
observed duplicate.

## Generator rename -> fuel/maintenance Delta

`powerhub_refresh_fuel_maintenance_delta_after_generator_name_up()`
is a privileged AFTER UPDATE OF name trigger on `generators`.
The recorded SQL selects the latest 500 fuel events and 200
maintenance work orders **within tenant/site**, then filters
`generator_id=NEW.id` outside the limited subquery. This can omit
older rows of the renamed generator when enough newer rows belong to
other generators; no live data loss has been shown.

The trigger calls the separately privileged
`powerhub_emit_fuel_maintenance_delta_sync_change(bigint,bigint,text,bigint)`.
The read-only catalog inspection observed EXECUTE for `service_role`,
not for direct `anon` or `authenticated`, and the configured search
path `pg_catalog, public, pg_temp`. Its body references projector
functions for fuel events, maintenance work orders and parts, and an
append function for `upsert`/`delete` Delta entries.
**Required review:** trigger affected-row semantics, the producer
chain, generator-specific refresh completeness, scoped tenant/site
projection, replay/idempotency and bounded performance.

## Mobile session touch

The pinned `powerhub_mobile_touch_session` definition checks
session/user/tenant and revocation/expiry predicates, and takes an
advisory transaction lock. The current inspected TypeScript backend
instead updates `mobile_api_sessions` directly with scope predicates.
No complete application call graph was demonstrated, and no change
to session behavior is authorized by this review.

## Non-authorizing tests and gates

`docs/security/pr359-cb-a-definer-side-effects-catalog-20261124.json`
is a *scoped summary* of catalog evidence (six site/subscription
indexes and one dependent SECURITY DEFINER function), not a full
binary catalog export or a complete function-body pin. The
`cb-a-definer-side-effects.mjs` guard checks it against pinned
six-function definitions and R4 roots. It fails closed on altered
index evidence, privilege flags, missing dependencies, and
changes to observed trigger limit/scope expressions.

```bash
node --test scripts/pr359-canonical/cb-a-definer-side-effects.test.mjs
node scripts/pr359-canonical/cb-a-definer-side-effects.mjs --out /tmp/pr359-cb-a-definer-side-effects.json
```

Docker Shadow exports the JSON result alongside the other CB-A
candidates. No SQL is applied, no DDL is generated, no on-device or
hosted runtime tests are implied.

```text
CB_A_DEFINER_SIDE_EFFECT_STATIC_GATE=CI_PENDING
CB_A_OWNER_SITE_CONCURRENCY_CONFIRMED=FALSE
CB_A_GENERATOR_DELTA_COMPLETENESS_CONFIRMED=FALSE
CB_A_FULL_PRIVILEGED_CALL_GRAPH=FALSE
CB_A_SECURITY_SIGNOFF_COMPLETE=FALSE
CANONICAL_BASELINE_APPROVED=FALSE
CB_B_EXECUTABLE_SQL_APPROVED=FALSE
STAGING_INPLACE_GO=FALSE
PRODUCTION_INPLACE_GO=FALSE
PR359_MERGE_GO=FALSE
```
