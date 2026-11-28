# CB-A chat send replay characterization — 2026-11-28

Parent 63bacd0dce6541aaf34737f4427eee8966e885be has six successful workflows. Native browser job 141015324077 emitted all 13 markers, including snapshot/live-query boundary.

New disposable PostgreSQL fixture captures live Staging public-message/internal-note private implementations and rate limiter with SHA-256 hashes. Original behavior assertions cover same-sender payload/reply mismatch, cross-visibility UUID reuse and null internal-note keys. Candidate matches actor, tenant, visibility, sender/message type, normalized body and reply target and rejects missing UUIDs. A common conversation row lock is a **candidate** serialization strategy, not a migration or certified global lock order. Separate real sessions must block and then return the same committed row without duplicate rate consumption or SLA event. Synthetic identity, capability, access and SLA/audit helpers limit evidence. Real rate-limit function is retained. Fixture database is guarded; default rolls back.

Remaining: inspect compatibility of this candidate with ticket assignment, transition, rate limiter and other producer lock order; full caller review; concurrent mixed public/internal/assignment/rollback cases; actual JWT/RLS and hosted runtime acceptance; ownership. No grants, hosted schema mutations or approvals.
