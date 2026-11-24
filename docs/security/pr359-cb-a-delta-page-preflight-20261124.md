# CB-A — Delta page preflight (2026-11-24)

Base: e87d165fa64506b78563c998407e742241b7e921

The pull coordinator previously called applyPage before commitDeltaPage validated every change. Move shared change validation ahead of the query-cache callback and retain it at the durable transaction boundary. Reject unknown statuses and operations, empty IDs, scope and identity mismatches, malformed tombstones, duplicate/out-of-order cursors, and changes outside page bounds. Reject changes at or before the requested cursor before projection. Regression fixtures exercise the coordinator with write spies and unchanged checkpoints.

Scope: source and isolated tests only. CI pending on the new commit. No hosted changes, migration, merge, or operational acceptance. This does not prove cross-tab compare-and-commit for query projections or end-to-end Outbox recovery. CB-A remains open; CB-B and merge remain blocked.
