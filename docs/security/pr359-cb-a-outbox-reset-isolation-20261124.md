# CB-A — Outbox preservation during Delta recovery

Base: fb553e617ebbc65647a0b3be9de66a04a181a434

Added a regression suite invoking the real pullDeltaPages, replaceDeltaSnapshot and clearDeltaSyncDataForUser functions with a scoped transactional IndexedDB model. Seed both users with pending reading, retryable payment and conflicted expense intents, stable client operation IDs, dependencies, retry metadata, claims, grants, conflicts, field reading and bootstrap state. Assert byte-equivalent structured state before and after reset, injected transaction abort/retry, and identity change followed by old-user Delta cleanup. Assert that no protected store is opened by Delta transactions.

This is a code-level transactional model, not native IndexedDB or real-device acceptance. Query cache is a separate database. End-to-end Outbox replay, optimistic UI reconstruction and cross-tab recovery remain open. CI pending. No hosted changes, migrations, merge or deployment.
