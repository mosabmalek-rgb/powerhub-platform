# CB-A.6 — P0 review queue and dependency subtotal integrity (2026-11-28)

Parent `bdc00da0b4a969927236da666d707607d2a925bc`: all six PR workflows succeeded, including Docker Shadow run 46129917145. This is not acceptance of this new change.

The root dependency validator previously checked row-level ranges and overall incoming/outgoing edge totals but did not sum managed/unidentified incoming/outgoing subcounts. It now rejects all four subtotal mismatches, including a nonzero count on a root with sufficient edges. This is a verifier hardening, not evidence of live catalog drift.

The new P0 queue joins the existing audited ownership register, historical functions/relations, captured live metadata and root dependency evidence. All five inputs are pinned to their exact Git blob bytes. The report binds the actual checkout, exact signatures, DDL/ACL digests, historical search_path and service EXECUTE hints, and dependency digests for 296 P0 public SECURITY DEFINER functions. All records remain pending, with null canonical source and reviewer approval. Historical configuration is not proof of current effective privileges or safety. CI uploads the report after regression tests.

The repair runtime was also reviewed: current query-cache-before-cursor ordering deliberately supports idempotent replay after interruption; changing it to commit-first without a recoverable cache reconciliation protocol could skip cache updates. No operational repair activation or production code change in this batch. Need a certified producer version and full multi-tab/session/query persistence acceptance first.

No hosted mutations, ownership promotion, canonical SQL approval, release or merge.
