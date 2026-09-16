# GitHub Actions hosted-runner incident — 2026-09-16

## Scope
PR #43 (`6d45a08196f0ac65b436a45de4d93d364791c0f9`) is release-blocked by GitHub Actions jobs failing before the first workflow step.

## Repository evidence
The affected PR workflows report jobs with empty step arrays and no usable job logs. The same pre-step signature is also present in the scheduled `PowerHub Operations Smoke` workflow on `main`, which uses a standard `ubuntu-latest` runner and a minimal sequence of Checkout, Node setup, and the smoke command.

## External corroboration
On 2026-09-15, a GitHub Community discussion documented a similar cross-repository failure pattern: `ubuntu-latest`, `runner_id=0`, empty `steps=[]`, no Set up job/checkout/logs, and failures within seconds. The discussion explicitly raised account-level hosted-runner allocation/entitlement/backend state as an area to investigate, without establishing a root cause.

## Current conclusion
The PowerHub evidence is consistent with a hosted-runner provisioning/allocation failure occurring before workflow execution. The exact root cause is not established and must not be inferred solely from the external discussion.

## Release rule
Do not bypass or weaken CI/Security/Admin Guard, substitute self-hosted runners as a release workaround, or modify Production to work around this incident. Release requires a genuine current-head execution with runner assignment, executed steps, and terminal successful results for the required workflows.
