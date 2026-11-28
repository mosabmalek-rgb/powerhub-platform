# CB-A chat SQL recovery and concurrency review — 2026-11-28

Parent d9d91b75bcdd4db443736f3c89b9ebbf4567288b: five workflows passed, PostgreSQL integration failed at line 315, after both single-read markers had been emitted (job 141010295741). The generated SQL helper had a single dollar delimiter instead of a matched pair, due to string replacement processing. Use named dollar quoting and literal replacement. Notification checks now evaluate count and mutation in separate statements. No acceptance condition removed.

The disposable CI database retains the successful candidate only with an explicit psql fixture variable; standalone default remains rollback. A separate guarded bash harness runs real concurrent PostgreSQL sessions, observes actual blocking through pg_stat_activity/pg_blocking_pids, requires successful commits, and asserts exact bulk counts, monotonic pointer, and exclusion of internal, own and unrelated receipts. This is not proof of real hosted JWT authorization or complete global lock ordering.

## Independent read-only Staging source review

- private.chat_send_message validates non-null client UUID, public reply target in the same conversation, actor access, body length and rate limits. Existing replay matches sender only; it does not compare normalized body, visibility, or reply target. A same-sender UUID collision across public message and internal note may return the wrong semantic result. Concurrent duplicate requests need explicit replay acceptance; unique indexes protect the row count, but do not prove successful idempotent responses.
- private.chat_send_internal_note checks active identity, support capability, conversation type and body. It has no explicit null client UUID rejection and only compares sender on replay.
- private.chat_assign_support checks active identity, support capability, support conversation type and eligibility via chat_support_user_ids(). It reads and releases the open assignment before inserting the replacement; concurrent assignment must be characterized before selecting a serialization strategy.
- Catalog confirms unique (conversation_id,client_message_id) indexes on chat_messages (one full, one partial), unique (conversation_id,user_id) on chat_participants, and partial unique (conversation_id) on chat_support_assignments WHERE status IN ('pending','active'). Do not remove either message index without dependency review.
- These are source findings and test requirements, not proof of an exploited defect or a certified correction. No hosted mutations or ownership approvals.
