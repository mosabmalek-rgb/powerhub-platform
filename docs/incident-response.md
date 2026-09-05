# PowerHub Incident Response

## Severity
- **SEV-1:** security breach, cross-tenant access, corrupted financial data, or complete production outage.
- **SEV-2:** major feature unavailable, sustained elevated 5xx, or serious performance degradation.
- **SEV-3:** limited feature defect with a workaround.

## First 15 minutes
1. Record the incident start time and affected deployment/version.
2. Identify whether the issue is application, database, authentication, integration, or deployment related.
3. Preserve relevant Vercel runtime/build logs and database audit evidence.
4. For suspected security or financial integrity issues, restrict the affected operation before attempting a code fix.
5. Do not delete logs or test evidence.

## Security incident
1. Stop the affected endpoint or release path if practical.
2. Revoke/rotate compromised credentials through the provider secret store.
3. Review authentication, RLS, RPC execution privileges, and audit logs.
4. Determine affected tenants/sites and the time window.
5. Apply a corrective migration or code release only after scope is understood.

## Financial incident
1. Stop further affected financial writes if balances may be incorrect.
2. Identify duplicate/replayed operations using `client_operation_id` and payment/invoice numbers.
3. Compare invoice, payment, account transaction, and audit records.
4. Never repair financial history by destructive deletion; prefer a controlled corrective transaction/migration.
5. Re-run financial integrity checks before reopening the operation.

## Deployment incident
1. Check the latest Vercel deployment state and runtime errors.
2. If the release is the likely cause, roll back to the last known-good production deployment.
3. Keep the failed deployment available for investigation.
4. If a database migration is involved, evaluate a forward corrective migration instead of an automatic rollback.

## Recovery
- Confirm authentication and authorization.
- Confirm tenant/site isolation.
- Confirm subscriber portal behavior and rate limiting.
- Confirm financial write/read consistency.
- Run smoke tests.
- Monitor runtime errors for at least one hour.

## Post-incident
Create a short incident record containing:
- summary;
- severity;
- timeline;
- affected components and tenants/sites;
- root cause;
- customer impact;
- mitigation;
- permanent corrective action;
- tests added to prevent recurrence.
