# GitHub Actions hosted-runner incident — 2026-09-16

## Scope
PR #43 (`625f4c6083e2c499de081b2f5b7c5ebb65cd2950`) is release-blocked by GitHub Actions jobs failing before the first workflow step.

## Repository evidence
The affected PR workflows report jobs with empty step arrays and no usable job logs. The same pre-step signature is also present in the scheduled `PowerHub Operations Smoke` workflow on `main`, which uses a standard `ubuntu-latest` runner and a minimal sequence of Checkout, Node setup, and the smoke command.

A fresh execution was observed on the updated PR head `625f4c6083e2c499de081b2f5b7c5ebb65cd2950`: the TypeScript/tests/build job and Supabase runtime migration guard both completed as failures within about two seconds, both with `steps=[]`; fetching the job log for the CI job returned `BlobNotFound`.

## External corroboration
On 2026-09-15, a GitHub Community discussion documented a similar cross-repository failure pattern: `ubuntu-latest`, `runner_id=0`, empty `steps=[]`, no Set up job/checkout/logs, and failures within seconds. The discussion explicitly raised account-level hosted-runner allocation/entitlement/backend state as an area to investigate, without establishing a root cause.

GitHub's public status page currently reports Actions as operational, so the repository evidence should be treated as a scoped hosted-runner/account/provisioning incident rather than proof of a platform-wide outage.

## Current conclusion
The PowerHub evidence is consistent with a hosted-runner provisioning/allocation failure occurring before workflow execution. The exact root cause is not established and must not be inferred solely from external reports.

## Release rule
Do not bypass or weaken CI/Security/Admin Guard, substitute self-hosted runners as a release workaround, or modify Production to work around this incident. Release requires a genuine current-head execution with runner assignment, executed steps, and terminal successful results for the required workflows.
