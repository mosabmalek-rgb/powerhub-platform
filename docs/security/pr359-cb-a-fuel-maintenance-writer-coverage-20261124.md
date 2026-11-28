# CB-A.4 — privileged Append characterization and known writer contracts

Source reviewed at 6e02dfe75a9b27c33d197f7df4bcb12ab6783d7c. The six existing CI passes do not cover this batch. Archived catalog evidence blob f851a32e73ce652729e418d570973d1967e8934e is unchanged.

## Scope
Six known tRPC writer paths are covered by lexical contracts, including the latest chronological CREATE definition found in migration files; three direct trigger declarations are checked. This is not a SQL parser, full overload inventory, effective trigger-state audit, or runtime call graph. Scheduled jobs, direct service-role writers, administrative paths, dynamic SQL, cascades, and actual grants remain open.

The archived Append compares site ownership and entity ID but does not explicitly compare payload tenant/site/order to journal scope. Archived ACL flags deny anon/authenticated and allow service_role. No ordinary-user exploit or actual cross-tenant leak is established. The disposable fixture characterizes privileged mismatched synthetic input, validates journal and Pull output, and rolls back. A changed behavior must fail this characterization, not be silently accepted. The runner retains its existing networkless-container and unpublished-port guards. No SQL migration is introduced.

## Additional source findings
In 20261101083020_powerhub_delta_fuel_events_maintenance_orders_parts.sql:
- Generator rename selects the tenant/site top-500 fuel/top-200 order window before selecting the affected generator, matching the source snapshot. Full-history refresh is not automatically required.
- Two warehouse-name triggers can both refresh an order's parts. Measure actual latest bindings, journal and cursor effects before changing them.
- Item/warehouse refresh of parts is limited to orders in the top-200 window, but the parts snapshot accepts any valid in-scope order. Confirm historical-order cache reachability and lifetime before changing the window.
- SQL three-valued logic around nullable operation/entity inputs needs review alongside actual constraints.

## Gates
CI on the new head is required. Characterization success is not a hardened implementation or full producer closure. Candidate hardening must be separately tested with full projector payloads, valid deletes/moves, missing and malformed fields, role ACL, rollback, concurrency and retention. Do not change hosted data or create executable canonical SQL.

CANONICAL_BASELINE_APPROVED=FALSE
CB_B_CANONICAL_SQL_APPROVED=FALSE
STAGING_INPLACE_GO=FALSE
PRODUCTION_INPLACE_GO=FALSE
PR359_MERGE_GO=FALSE
