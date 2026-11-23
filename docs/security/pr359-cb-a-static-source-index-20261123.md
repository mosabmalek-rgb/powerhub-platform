# PR359 CB-A: provisional source-of-truth candidates

2026-11-23; parent commit bd3c01c5b9faa2d835d8f79abed465fbd16996d5.

Implemented: a conservative lexical index of top-level CREATE table, function,
view, materialized view and sequence statements in the 700 SHA-pinned
historical migration SQL files. Each candidate includes path, Git blob SHA,
statement kind and offset. SQL comments, quoted strings and dollar bodies
are masked. There is no object-level ownership approval.

All 978 objects remain unreviewed. Current signatures and final DDL after
ALTER/DROP are NOT proven; unqualified names assume public only provisionally.
Implicit sequences and dynamic DDL may not have a direct CREATE source.
Historical Drizzle SQL uses MySQL syntax and is not PostgreSQL baseline input.

The Docker Shadow workflow publishes a non-authorizing JSON inventory artifact.
Approval still requires per-object DDL and runtime/dependency reconciliation,
managed Auth/Storage/Realtime/Cron links, clean compatible Supabase builds
twice, financial/tenant tests and a separate hosted change approval.

CB_A_STATIC_INDEX=CI_PENDING
CANONICAL_BASELINE_APPROVED=FALSE
CLEAN_BOOTSTRAP_PASS=FALSE
STAGING_INPLACE_GO=FALSE
PRODUCTION_INPLACE_GO=FALSE
PR359_MERGE_GO=FALSE
