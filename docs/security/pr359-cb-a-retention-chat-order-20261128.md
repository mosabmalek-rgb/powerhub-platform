# CB-A retention checkpoint and chat ordering — 2026-11-28

Pinned parent: 7c2bc423aae98e1e19f105daa323be7eb05b8b73. All six workflows on that parent completed successfully. PostgreSQL job 141002740109 emitted all four chat characterization/candidate markers; Chromium job 141002740275 emitted all eleven native markers.

## Changes under review

- Preserve a previously committed repair version in an ordinary, validated same-scope snapshot replacement, in the same native IndexedDB transaction as the entity and cursor changes. A reset without a version cannot certify a new repair version. Explicit older versions remain rejected. The server-certified repair activation remains disabled and must be reviewed separately against canonical producer and snapshot guarantees.
- Extend existing unit and native-browser tests to exercise retention reset, durable checkpoint, repeat repair suppression, old-version rejection and protected-store isolation.
- Align the two support message views' database order and realtime insertion order with the proposed (created_at, id) SQL tuple. Preserve PostgreSQL microsecond ordering in the shared comparator, with tests for equal instants and timestamp precision.

No hosted migrations, grants, or ownership approvals. This is not full runtime browser acceptance, full receipt concurrency/JWT acceptance or global producer lock order proof. New head results must be established by CI; parent results do not transfer.
