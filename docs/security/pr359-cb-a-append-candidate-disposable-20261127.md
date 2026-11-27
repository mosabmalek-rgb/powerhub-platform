# CB-A.4 — Append preflight candidate, isolated only

Parent 58eb64dffe07002d47ff995df9078ad5cc3bd66c. All six workflows passed on the parent. Docker Shadow run 45458567522, smoke job 138674540923 emitted PR359_ARCHIVED_PRIVILEGED_APPEND_PAYLOAD_GAP_REPRODUCED and PR359_ARCHIVED_PAYLOAD_TEST_ROLLBACK_PASS. This characterizes privileged synthetic input, not an ordinary-user exploit or observed production leak.

The test-only candidate injects a preflight into the loaded archived definition before cursor allocation, leaving the original journal, retention and cursor implementation intact. It rejects NULL operation/entity, malformed/nonpositive/out-of-bigint IDs, missing or mismatched scope in upsert JSON, and mismatched or nonexistent scoped maintenance parent. Both numeric and canonical string IDs are accepted. Deletes intentionally do not require the parent to still exist, to allow old-scope tombstones after deletion/moves.

The transaction-local synthetic test checks 17 invalid cases, journal count and full scope-state equality, valid fuel and part upserts, Pull, deleted-parent tombstone, rollback, retention at cursor 11000, and a synthetic denied role. It rolls back the candidate definition, fixtures, roles and cursor changes. No hosted migration. The ACL test does not attest to deployed roles. Existing archived concurrency and trigger tests remain unchanged; candidate-specific concurrent replay and real projector integration still require evidence. Projector identity fields and latest overload/ACL/caller closure must be validated before approving this candidate.

Canonical and deployment approvals remain FALSE. No CB-B transition.
