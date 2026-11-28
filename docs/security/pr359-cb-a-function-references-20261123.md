# Canonical Baseline — CB-A six function dependency evidence (non-authorizing)

Review source: the six pinned, live `pg_get_functiondef` definitions and
978-root R4 catalog inventory on PR #359. This is a **source-only** lexical
reference crosswalk, not an AST, a resolved PostgreSQL execution plan or a
runtime call graph. Historical source CREATE lineage for the six functions
remains unresolved; no definition is approved for execution.

## Confirmed source mentions

| Function | Qualified references found in body | Security review |
| --- | --- | --- |
| `p6_assert_subscription_guard()` | `public.p6_subscription_access_status`, `public.tenants` | Contains archived test-tenant marker; independently classify as test vs runtime |
| `p6_subscription_access_status(...)` | `public.tenant_subscriptions` | Tenant subscription privilege and caller review pending |
| `powerhub_ensure_owner_main_site()` | `public.sites`, `public.staff_profiles`, `public.tenant_members` | SECURITY DEFINER, trigger owner and idempotent tenant/site creation review required |
| `powerhub_financial_period_cash_flow_raw(...)` | `public.account_transactions` | Financial tenant/site filtering and caller authorization review required |
| `powerhub_mobile_touch_session(...)` | `public.mobile_api_sessions` | SECURITY DEFINER, advisory lock, session-user-tenant predicates, EXECUTE privilege review required |
| `powerhub_refresh_fuel_maintenance_delta_after_generator_name_up()` | `public.generator_fuel_events`, `public.generator_maintenance_work_orders`, `public.powerhub_emit_fuel_maintenance_delta_sync_change` | SECURITY DEFINER, trigger routing and dependent function privilege review required |

The six bodies contain **11 distinct per-function qualified-name mentions**:
nine relation mentions and two function mentions. Each resolves to exactly one
registered R4 root identity and carries a separately pinned `pg_depend`
digest. A lexical match does not prove actual runtime calls; `pg_depend`
does not establish PL/pgSQL dynamic dependencies.

Implemented non-authorizing checks:

- `node --test scripts/pr359-canonical/cb-a-function-references.test.mjs`
- `node scripts/pr359-canonical/cb-a-function-references.mjs --out /tmp/pr359-cb-a-function-refs.json`

The Docker Shadow smoke workflow publishes `pr359-cb-a-function-refs.json`
with the existing candidate audit bundle. Altered source, ambiguous or absent
catalog target, changed privileges and missing dependency evidence fail closed.
The scanner deliberately does not emit executable DDL or grant any privileges.

## Open approvals

For every reference: verify exact final table/function DDL, current trigger
attachment, ownership, caller authorization, tenant and site isolation,
EXECUTE grants, RLS, locked search_path and provider dependencies. Resolve
the archived test marker before deciding whether to include that function.
Then obtain independent security sign-off for all three SECURITY DEFINER
functions. This leaves all 978 canonical root reviews open.

```text
CB_A_QUALIFIED_FUNCTION_REFERENCE_CANDIDATES=CI_PENDING
CB_A_FULL_EXECUTABLE_CALL_GRAPH=FALSE
CB_A_FUNCTION_SECURITY_SIGNOFF=FALSE
APP_OWNED_APPROVED=FALSE
CANONICAL_BASELINE_APPROVED=FALSE
CLEAN_BOOTSTRAP_PASS=FALSE
STAGING_INPLACE_GO=FALSE
PRODUCTION_INPLACE_GO=FALSE
PR359_MERGE_GO=FALSE
```
