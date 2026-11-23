# PR359 CB-A: full-source evidence triage (no promotion)

Source: GitHub Actions HEAD c965b46fc4c177fca1ecde33046bf1bc73e58d2d.
R4 inventory provenance: 978 candidates (641 functions and 337 relations).

The green Docker Shadow run 45193016883 generated the exact name-only CB-A
source index: 820 roots with one or more historical CREATE candidates,
158 without a direct lexical CREATE, 978 without final review.

Among the 158 without static matches: six functions, five ordinary tables,
and 147 sequences; the latter may be implicitly generated from identity
columns, but this is NOT assumed or approved.

The new source-triage utility joins 978 identities to all the evidence:
static historical SQL origins with pinned Git blobs, R4 current catalog
function hashes, structural-only relation hashes, current ACL hashes and
978-root pg_depend adjacency digests. It records ambiguity, overload and
identity review risks as explicit blockers. Missing roots, tampered hashes
or attempted object/hosted approval fail closed.

No claims of full relation executable DDL, source-of-truth, dynamic
callers, provider policy subobject coverage or canonical SQL validity
are made by this new scanner. 296 public SECURITY DEFINER functions still
require individual security and runtime review.

Next: resolve the six function/5 ordinary relation source gaps and
147 implicit-sequence hypotheses. Cross-reference actual server, React
and Android callers and obtain complete executable current DDL. Only then
author and test independent CB-B SQL segments in clean Supabase stacks.

CB_A_SOURCE_TRIAGE=CI_PENDING
APP_OWNED_APPROVED=FALSE
CANONICAL_BASELINE_APPROVED=FALSE
STAGING_INPLACE_GO=FALSE
PRODUCTION_INPLACE_GO=FALSE
PR359_MERGE_GO=FALSE
