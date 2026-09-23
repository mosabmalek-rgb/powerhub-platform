# PowerHub — Current Repository Status

## Canonical release line

- **Canonical branch:** `main`
- **Current HEAD:** `7844ae957e1079a3072481af6e4b35e0fb89b798`
- **Current focus:** production validation and release verification.
- Do not treat old diagnostic/release branches as the current source of truth.

## Validation gate

The current release is considered complete only when all of these are verified on the same HEAD:

1. PowerHub CI — SUCCESS
2. PowerHub Security — SUCCESS
3. PowerHub Supabase Admin Guard — SUCCESS
4. Vercel production deployment is READY
5. Deployment commit SHA equals the current HEAD
6. `/api/health` is healthy
7. `/api/ready` is healthy
8. Runtime logs are free of release-blocking errors
9. Owner acceptance test passes
10. Critical tabs, buttons and mutation execution chains are verified

## Repository hygiene rules

- `main` is the only canonical release branch.
- Feature/fix branches are short-lived and should have a linked PR.
- Diagnostic branches are deleted after their findings are resolved.
- Closed/unmerged PR branches are not release sources.
- Historical notes belong under `docs/archive/YYYY-MM/`.
- Do not keep status snapshots, temporary TODO lists, or dated visual notes in the repository root.
- Do not delete an open branch or PR merely for cosmetic cleanup; review it first.

## Documentation rule

Active documentation must describe the current architecture and behavior. Historical implementation notes must be archived rather than presented as current instructions.

## Scope note

The field application currently keeps electronic payments hidden/out of scope. External SMS/WhatsApp activation remains separately controlled and must not be inferred from the presence of integration code.
