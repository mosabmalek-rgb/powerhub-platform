# PowerHub Production Release Checklist

## 1. Code quality
- [ ] `pnpm check` passes.
- [ ] `pnpm test` passes.
- [ ] `pnpm build` passes.
- [ ] No debug credentials, tokens, or secrets are committed.
- [ ] Database migrations are reviewed and ordered.

## 2. Security
- [ ] RLS is enabled on every exposed public table.
- [ ] SECURITY DEFINER functions use a controlled `search_path` and least-privilege execution grants.
- [ ] Financial RPCs enforce tenant/site scope and idempotency.
- [ ] Closed financial periods are immutable.
- [ ] Public subscriber portal has anti-enumeration and rate limiting.
- [ ] Dependency and CodeQL checks are green.
- [ ] Production secrets are stored only in the hosting/provider secret store.

## 3. Database
- [ ] Migration applied successfully in the target environment.
- [ ] Required indexes exist.
- [ ] Backup policy is enabled at the provider level.
- [ ] Restore procedure is documented and tested before major production expansion.

## 4. Deployment
- [ ] Preview deployment is healthy.
- [ ] Production deployment is `READY`.
- [ ] Production smoke test passes.
- [ ] Previous production deployment is retained as rollback candidate.
- [ ] No new runtime errors are observed after release.

## 5. Post-release monitoring
- [ ] Check runtime errors after 15 minutes.
- [ ] Check runtime errors after 1 hour.
- [ ] Review financial RPC failures.
- [ ] Review subscriber portal rate-limit telemetry.
- [ ] Review database performance for new slow queries.

## 6. Rollback criteria
Rollback if any of the following occurs:
- authentication failure affecting normal users;
- cross-tenant or cross-site authorization failure;
- incorrect financial balances, duplicate payments, or duplicate invoices;
- sustained HTTP 5xx errors;
- migration causes data integrity issues;
- critical performance regression.

## 7. Rollback procedure
1. Stop or pause further release activity.
2. Identify the last known-good Vercel production deployment.
3. Roll back the deployment using the Vercel deployment controls.
4. Preserve logs and incident timestamps.
5. If a database migration is involved, do not blindly reverse it; assess whether a forward corrective migration is safer.
6. Re-run smoke tests and financial integrity checks.
7. Document the incident and corrective action.
