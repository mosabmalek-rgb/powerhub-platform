# PowerHub PR359 — CB-A platform code-reference findings (non-authorizing)

Date: 2026-11-23. Evidence parent SHA: `f3afa1c57d36b0846d69b72cd6ed575d3f1851e4`.
CI run: https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/45206005761
Artifact: `pr359-cb-a-candidates`; internal `pr359-cb-a-code-references.json`.
The artifact was downloaded and inspected, not inferred from a search response.

## Exact observed result

- 697 tracked platform code files: 330 server, 356 client, 10 shared, 1 API.
- 11 target catalog names (six functions and five tables).
- 14 lexical mentions in total: 8 other, 5 same-line Supabase `.from()` literal, 1 schema-qualified lexical reference.
- Only two target names occur in non-test platform files.
- The `payment_documentation_requests` table appears four times in `server/powerhub.ts` at lines 3844, 4096, 4106, and 4121. Git blob SHA `4a19352875df5553c7e98689eacaf29a19925f51`.
- The `tenant_feature_entitlements` table appears in `server/admin-platform-setting-router.ts` at line 150. Git blob SHA `bc20899e4f20458bcbb29c4b105716b6a17d5c53`.
- Remaining targets had no non-test lexical match in the scoped files, including all six functions. This **does not** mean they are unused.

## Security interpretation

The named table call sites use `supabaseAdmin()` (service credentials), which is consistent with R4's observed absence of direct `anon`/`authenticated` table SELECT rights. This static observation does **not** certify per-handler tenant authorization or prevent privileged API bypass; those require separate tests.

For `payment_documentation_requests`, inspected handlers use tenant and site restrictions, feature checks and role checks for the specifically inspected paths. This is not a proof of complete route coverage. The `tenant_feature_entitlements` listing checks platform admin role in the inspected handler, but other routes and indirect uses remain to be examined.

## Mandatory next gates

1. Trace privileged server procedure inputs and effective tenant/site authorization on every relevant route.
2. Review trigger-to-function and function-to-function references, especially all three SECURITY DEFINER functions.
3. Distinguish historical test functions from operational functions using pinned references, not intuition or absence of strings.
4. Audit the separate Android `mosabmalek-rgb/app-power-` repository before concluding complete runtime coverage.
5. Confirm live DDL, provider-managed links and transaction invariants; then perform two independent fresh compatible Supabase builds before any CB-B approval.

This is evidence of **lexical references**, not an AST or executed call graph.
No DROP, migration repair, hosted mutation, merging, clean-baseline approval or cutover is authorized.

```text
CB_A_PLATFORM_CODE_REFERENCE_SCAN=PASS_ON_PARENT_SHA
CB_A_TARGETS_WITH_NONTEST_LITERAL_REFERENCES=2
CB_A_RUNTIME_CALL_GRAPH_APPROVED=FALSE
ANDROID_REFERENCE_REVIEW_COMPLETE=FALSE
APP_OWNED_APPROVED=FALSE
CANONICAL_BASELINE_APPROVED=FALSE
STAGING_INPLACE_GO=FALSE
PRODUCTION_INPLACE_GO=FALSE
PR359_MERGE_GO=FALSE
```
