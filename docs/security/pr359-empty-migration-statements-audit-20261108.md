# PR #359 — migration ledger rows with empty SQL payloads (8 November 2026)

**READ-ONLY EVIDENCE / NOT AN APPLICATION APPROVAL.** This report records a live catalog and migration-ledger audit. No migration was applied, no `schema_migrations` row was edited, and no Production or Staging data was changed.

## Scope and result

- Staging `iyuryuhaylhisjfcrwkz`: 424 ledger rows; **12** have `statements` null, empty, or only whitespace. Each of the 12 has an existing exact `<version>_<name>.sql` file on PR #359.
- Production `vvcdiqcyhaloxesvpppc`: 486 ledger rows; **3 additional** records have empty SQL payloads (listed separately below). These are NOT part of the Staging twelve.
- **A blank stored SQL payload is neither proof of non-execution nor proof of execution.** Corresponding source files exist but historical execution contents cannot be recovered from this ledger field. Do not replay, remove, repair, or backfill entries on this basis alone.

## The 12 Staging records

| Version | Ledger name / source filename (without version) | Targeted evidence to reconcile |
|---|---|---|
| `20260905170000` | `powerhub_subscriber_portal_hardening` | `subscriber_portal_attempts`, two rate-limit indices and portal rate-limit / attempt functions |
| `20260905180000` | `powerhub_subscriber_portal_enumeration_protection` | Server-only portal lookup and invoice RPC definitions |
| `20260905181000` | `powerhub_subscriber_portal_global_rate_limit` | `powerhub_subscriber_portal_check_rate_limit` function body and portal-wide ceiling |
| `20260905182000` | `powerhub_subscriber_portal_phone_normalization_fix` | Latest portal lookup / invoice function body and phone normalization |
| `20260907180500` | `subscriber_portal_attempts_rls_policy` | RLS on attempts table and service-role policy |
| `20260922192000` | `powerhub_staff_password_reset_intents` | Reset-intents table, indices and begin/complete functions |
| `20261007140000` | `powerhub_quota_attempt_notifications` | Quota alerts table, indices and notification/add-on functions |
| `20261011130000` | `powerhub_tariff_price_history` | Tariff history table, four indices, trigger functions and price-update logic |
| `20261024210000` | `powerhub_offline_write_acl_hardening` | Direct DML revocations and server-only update/approval RPC execution |
| `20261024210500` | `powerhub_device_lock_schema_reconciliation` | Device-lock table/index, claim/release functions, concurrent ownership behavior |
| `20261024211000` | `powerhub_notification_trigger_rpc_hardening` | Three trigger-function EXECUTE revocations and trigger attachments |
| `20261025010000` | `powerhub_quota_alert_acl_hardening` | Quota-alert RLS and browser-role table-grant revocation |

All 12 exact source paths are under `supabase/migrations/`. All 12 Staging ledger rows have `statement_count=0` and `created_by IS NULL` in the 8-November read-only query.

## Current catalog spot checks (NOT historical attribution)

Read-only catalog checks in **both Staging and Production** confirmed all **35/35 selected expected objects** present: five selected tables, eleven selected indexes and nineteen selected named functions. All five selected tables have RLS enabled. For these tables, `anon` and `authenticated` lack direct SELECT and `service_role` retains SELECT. For the nineteen functions, `anon` and `authenticated` lack EXECUTE while `service_role` retains EXECUTE in both environments. The Staging check counted **19** matching public function signatures. Some of the current object states may result from later migrations and therefore cannot independently attribute execution to a specific empty-ledger row.

A deeper contract check is **still open** for source-vs-current function definitions, policy USING/WITH CHECK expressions, index uniqueness/filters, trigger attachments, version-specific changes, and application behavior. Specifically, presence of the portal rate-limit function does not prove its global limit or phone normalization; presence of tariff trigger functions does not prove accurate historical tariff intervals; and existence of the device-lock functions does not demonstrate concurrency safety.

Current selected table policies: `subscriber_portal_attempts` has one policy; the other four selected server-only tables have zero policies, so access is via service-role bypass of RLS rather than direct authenticated table access. This is a descriptive catalog result, **not** blanket authorization for client access.

## Three separate Production empty-payload rows

- `20261026101438_powerhub_trial_subscription_lifecycle_20261026`
- `20261026101445_powerhub_dashboard_database_aggregates_20261026`
- `20261026102654_powerhub_pin_subscription_lifecycle_search_path`

These three have `statement_count=0`; they require their **own** source and catalog comparison. Do not include them in the Staging twelve or infer staging equivalence.

## Relationship to the 28-case crosswalk

The separate `pr359-migration-history-crosswalk-20261108.json` now carries archived-SQL text comparisons for **all 26 previously outstanding cases**. Those 26 comprise 27 Staging ledger rows because `powerhub_reading_opening_baseline_save_fix` has two versions: 5 exact source-body matches after stripping comment-only lines, 3 formatting-normalized matches, 3 comment-line-and-format normalized matches, and **16 textual differences** that require deeper semantic/object-level inspection. A second token-stream comparison of the 16 conservatively flagged cases found **7 token-identical archived records** and **10 genuinely different token sequences**, including the first of two reading-baseline versions. The older formatting-only labels are retained as preliminary evidence; the lexical follow-up is recorded per record in the crosswalk. Token identity is not catalog/behavior identity. The first two cases retain independent Staging catalog proof; production historical attribution remains unproven.

## Release decisions / remaining gates

1. Do **not** backfill `statements` in Staging or Production, rewrite migration versions, or replay migrations to cure empty history. Create separate, reviewed reconciliation decisions from source-versus-current catalog evidence.
2. For the 16 materially or syntactically different historical SQL records, review deltas, function definitions, RLS policies and grants individually; multiple versions may reflect genuine different source contents.
3. For these twelve empty rows, finish behavior/trigger/index/policy checks and decide whether source is already represented by later migration effects.
4. Keep the seven 7-November security migrations blocked from Staging application until preflight, deployed-consumer testing, remaining history reconciliation and **explicit user authorization**. CI green on a SHA is not migration-application approval.

## Expanded live postcondition checks (8 November 2026)

Both environments returned the **exact eleven expected named indices**, including UNIQUE partial indices for pending password reset intent, reached-once quota alerts, and one open tariff-price version. Catalog definitions of those eleven indices matched between Staging and Production. The `public.tariffs` table has the `powerhub_tariff_history_before_update` and `powerhub_tariff_history_after_write` triggers attached in both environments, in addition to the existing delta-sync trigger. The `subscriber_portal_attempts_service_role_only` policy is present with `USING (true)` / `WITH CHECK (true)` in both environments; table access is separately limited by ACL and RLS.

The selected catalog probes are now: **5/5 tables**, **11/11 indices**, **19/19 functions**, **2/2 specifically expected tariff-history triggers**, and the targeted attempts policy in both environments. This remains an **object-presence/ACL/attachment review**, not proof of function-body equivalence, retry/concurrency behavior, or which historical migration produced the final state.

### Material SQL differences discovered in the 28-case crosswalk

In addition to benign grantee ordering and purely formatted SQL, the deeper token comparison found differences requiring specific release attention: historical Chat participant/receipt SELECT predicates, `chat_mark_read_up_to` logic, platform role/policy and field-user-guard definitions, original reading idempotency scope, and the messaging-history cycle-end interval. The archived messaging-history function uses `interval '1 millisecond'` where the source uses `interval '1 microsecond'`; the **current Staging function body** contains the microsecond value. The later, second archived `powerhub_reading_opening_baseline_save_fix` body matches the source at SQL-token level, whereas its earlier archived version does not.

**Do not** treat an unchanged migration name as evidence that the earlier, different body has been reconciled. No schema migration history was altered in this review.

## Additional identified live drift — field-user quota and Chat mark-read

Read-only `pg_get_functiondef` checks revealed an important counterexample to "name present means source/current equivalent":

- **Staging** `public.powerhub_enforce_field_user_quota()` still uses the historical `v_plan` and `platform_settings.subscription_package_catalog[].legacyPlan` route. The archived `powerhub_field_user_guards` SQL has this older implementation. The corresponding source file uses `v_package_code` and package-code lookup. **Production** currently uses `public.powerhub_effective_tenant_quota(new.tenant_id,'fieldUser')` instead. These are three materially different implementation strategies, not just comment/formatting changes.
- The branch contains later alternative definitions in `20260922123000_powerhub_unified_field_user_guard.sql`, `20260922123000_powerhub_unified_field_user_policy.sql`, `20260922170000_powerhub_effective_quota_authority_and_addon_security.sql` and `20260925200000_powerhub_addon_lifecycle_production_reconciliation.sql`. A targeted name/version ledger query found **none** of those entries in Staging. Production shows a separate `20260925165839_powerhub_addon_lifecycle_production_reconciliation` row. Name absence is **not** proof no equivalent reconciliation ever occurred.
- **Staging** `private.chat_mark_read_up_to(bigint,bigint)` currently has a `v_count` return path and visibility-sensitive authorization, distinct from the archived source version returning a constant `1` after the update. This may reflect subsequent hardening; never replace the current function with older SQL merely to align a historical filename.

**Actionable gate:** perform source-versus-live semantic/behavior tests for quota enforcement and Chat mark-read before Staging application approval. In particular, test active subscription-package lookup, legacy-plan fallback, feature controls and quota limits for field staff, and validate Chat read ownership/internal visibility with representative, isolated fixtures. Do **not** mutate Staging or Production in this audit and do **not** replay the old source-only migrations.
