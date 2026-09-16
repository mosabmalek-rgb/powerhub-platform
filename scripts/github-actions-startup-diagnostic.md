# GitHub Actions startup diagnostic

Observed on commit `e48b649c40171ee2a111dc3c067e890591a9f719` (2026-09-16):

- PowerHub CI run `35075586114`, attempt 3: job created, failed in ~2s, `steps=[]`, `runner_id=0`.
- PowerHub Security run `35075585974`: dependency-audit failed with `steps=[]`; other jobs skipped.
- Supabase Admin Guard run `35075585973`: job failed with `steps=[]`, `runner_id=0`.
- Re-runs reproduce the same pre-step failure.
- Workflow definitions all use standard `ubuntu-latest` GitHub-hosted runners.

This signature is consistent with the current GitHub Actions hosted-runner startup/provisioning failures reported by other private repositories in September 2026. No PowerHub workflow step has been shown to execute in the affected runs, so this is not currently attributable to TypeScript, tests, pnpm, migrations, or build code.

Release policy: do not bypass or weaken CI checks; do not modify Production to work around this infrastructure condition.
