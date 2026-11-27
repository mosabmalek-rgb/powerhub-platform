# CB-A.4 — commit-wide writer candidate inventory (2026-11-27)

Parent reviewed: `4f4c3b2ea79b4d915f9486c7fc6906d521c9ed26`. The prior six CI gates passed on that parent only.

The existing source-index is restricted to 700 historical migrations and the eleven-name code-reference index to four application directories. The new inventory scans every tracked regular text blob of the checked-out commit using git grep, including administrative scripts, unrelated migrations and workflow files. It records exact commit, blob, path and line numbers without emitting source text, distinguishes documentation/tests/migration history/scripts and other source, includes the PostgreSQL 63-byte identifier alias, and flags selected trigger-bypass, truncation, cron and dynamic SQL candidates. The Vitest regression requires a source match for every root and does not approve closure. Generate a detailed local report with:

```sh
node scripts/pr359-canonical/cb-a-writer-inventory.mjs --out /tmp/pr359-writer-inventory-new.json
```

This is SOURCE EVIDENCE, not catalog evidence or a complete SQL parser. Binary blobs, external Android repository, dynamic names, multiline/obfuscated constructs, runtime callers, cascade paths, exact overloads and ACL are unresolved. Candidate matches may include comments and historical statements. The scan records the actual checkout SHA (including a CI merge ref when used), not an assumed PR SHA. Review each candidate before classifying it as a writer. The current candidate Append concurrency and full projector integration remain open.

No hosted database access or migration, release, merge, signoff, or destructive allowlist change. Full caller closure and all canonical approval gates remain false. New-head CI is required.

## Independent coverage and reproducible CI evidence

A follow-up excludes canonical audit tooling from source coverage and requires every root to have independent migration-history matches. This prevents the scanner's own root constants from satisfying its coverage requirement. PowerHub CI now invokes the CLI explicitly and retains its complete commit/blob/path/line report as a required artifact. The normal server regression remains enabled. Prior CI prints only the last 250 lines of the test log, so the missing stdout marker in the previous job log does not establish that the regression was skipped. No new-head PASS is asserted until the new report and run are verified.
