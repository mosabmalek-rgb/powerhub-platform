# Platform Capability Test Matrix v1

Status: IMPLEMENTED / EXECUTION GATE

## Required decisions

| Scenario | Expected |
|---|---|
| Active platform_admin + explicit allow | ALLOW |
| Active platform_owner + explicit allow | ALLOW |
| Active finance_admin + explicit allow | ALLOW |
| Any supported platform role + no policy | DENY |
| Any supported platform role + is_allowed=false | DENY |
| Disabled/locked user + explicit allow | DENY |
| Tenant owner + manageMessaging only | DENY |
| Tenant manager + manageMessaging only | DENY |
| finance_admin without explicit support policy | DENY |
| platform_owner without explicit support policy | DENY |
| Unknown capability | DENY |
| Forged actor/user id supplied by client | IGNORE; use auth.uid() |
| Participant membership alone | DENY for platform authorization |

## Release rule

No support RPC, Realtime queue policy, or chat Storage policy may rely on tenant `manageMessaging`, `users.role='admin'`, `powerhub_is_platform_admin()`, or a client-supplied actor ID as a platform support grant.

Production deployment remains blocked until these cases are executed against Supabase with authenticated test identities and the results are recorded.
