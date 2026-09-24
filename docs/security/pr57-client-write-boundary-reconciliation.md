# PR #57 reconciliation

This branch rebases the intent of PR #57 onto the current `main` line without
replaying the three-commit stale branch.

## Security contract

Browser roles (`public`, `anon`, `authenticated`) must not perform direct
INSERT/UPDATE/DELETE/TRUNCATE on the reviewed business, tenant, authorization,
messaging, audit, and mobile synchronization tables.

Server-side/RPC paths remain responsible for:

- actor identity and tenant/site scope
- authorization and capability checks
- audit logging
- idempotency and concurrency protection

The migration deliberately does **not** revoke privileges from `service_role`.

## Staging verification required before merge

Run against a staging database built from this exact branch:

```sql
select table_name, privilege_type, grantee
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'authenticated', 'public')
  and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
order by table_name, grantee, privilege_type;
```

Expected result: none of the protected tables appear.

Also verify that representative server-side mutation paths still succeed with
the configured service role and that RLS remains enabled for every exposed table.
