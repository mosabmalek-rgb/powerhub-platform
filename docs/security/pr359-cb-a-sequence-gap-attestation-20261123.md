# PR359 CB-A: source gap decomposition and sequence identity evidence

Captured on 2026-11-23 from Staging iyuryuhaylhisjfcrwkz.
Catalog-only SELECT; no application rows, credentials or DB mutations.
Verified against the pinned R4 relation inventory and exact archived SQL
blob manifest. Parent PR head: 9d2d1a135dadfea24bb1c8827b903f9b6814a1f0.

Facts: 154 application-schema sequences in pg_class, of which:
- 147 lack standalone CREATE SEQUENCE matches in the historical index;
  **all 147** have internal pg_depend type i to an identity column,
  match pg_get_serial_sequence, and cross-check against R0 column identity.
- 7 have historical CREATE SEQUENCE source candidates and have no
  column-ownership edge in the read-only Staging catalog.
- No sequence is currently unexplained by this limited source/provenance check.

Remaining 11 unmatched static CREATE identities:
Functions:
- public.p6_assert_subscription_guard()
- public.p6_subscription_access_status(bigint,timestamp with time zone)
- public.powerhub_ensure_owner_main_site() [SECURITY DEFINER]
- public.powerhub_financial_period_cash_flow_raw(bigint,bigint,timestamp with time zone,timestamp with time zone)
- public.powerhub_mobile_touch_session(bigint,bigint,bigint,timestamp with time zone) [SECURITY DEFINER]
- public.powerhub_refresh_fuel_maintenance_delta_after_generator_name_up() [SECURITY DEFINER]

Tables:
- public.emergency_requests
- public.payment_documentation_requests
- public.sms_dispatch_queue
- public.tenant_feature_entitlements
- public.tweet_sms_report_snapshots

These 11 live objects were verified by read-only catalog lookup.
The absence of a recognized CREATE in the pinned 700 files does not mean
the objects are unneeded, nor that SQL is lost or that a DROP is appropriate.
Investigate dynamic creation, old migrations, renamed objects and runtime
callers separately. The 147 sequence *origins* are explained, but
COMPLETE EXECUTABLE TABLE DDL, source-of-truth and current-stack rebuild
are still NOT approved. All 978 candidates remain unreviewed.

Run: node --test scripts/pr359-canonical/verify-sequence-evidence.test.mjs
Run: node scripts/pr359-canonical/verify-sequence-evidence.mjs

CB_A_SEQUENCE_PROVENANCE=CI_PENDING
CANONICAL_BASELINE_APPROVED=FALSE
STAGING_INPLACE_GO=FALSE
PRODUCTION_INPLACE_GO=FALSE
PR359_MERGE_GO=FALSE
