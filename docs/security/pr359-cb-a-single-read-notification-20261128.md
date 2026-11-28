# CB-A chat single-read and notification visibility characterization

Parent 2cf3a1ce87da9327800407362df615e9353d8e0b: five workflows successful at initial verification, disposable shadow still running; native Chromium emitted 12/12 markers (job 141008091017).

Read-only Staging catalog capture confirmed single-message pointer regression and mismatch between bulk notification read and visible unread/mark-one scope. The existing isolated characterization now includes captured definitions, original-behavior assertions, and candidates with deterministic tuple ordering and matching notification visibility. No hosted migration or grants. Synthetic authorization helpers are retained; these tests do not prove JWT, membership, RLS or concurrent transaction acceptance.

Independent P0 screening: all 15 remaining authenticated-facing signatures and 14 private implementations were recaptured. All 15 public signatures have authenticated EXECUTE and no anon EXECUTE; all 14 private signatures have neither. See companion JSON for exact signatures, definition hashes, search path and guard excerpts. This is source screening only, not final caller closure, full ACL proof or signed ownership. Review priorities: reply target and idempotency, support assignment eligibility, tenant membership/feature checks, and cross-tenant support capability behavior.
