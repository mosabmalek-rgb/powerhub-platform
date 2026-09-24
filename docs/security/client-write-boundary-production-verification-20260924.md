# Client Write Boundary — Production Verification

**Verification date:** 2026-09-24  
**Repository:** `mosabmalek-rgb/powerhub-platform`  
**Production Supabase project:** `vvcdiqcyhaloxesvpppc`

## Decision

The direct client table-write boundary is already present in Supabase Production. No migration from PR #57 is being merged, and no new schema migration is being introduced by this documentation change. The purpose of this record is to preserve the verified relationship between the production migration history and the repository history without replaying an equivalent migration under a different filename.

## Production evidence

Supabase Production reports the following canonical boundary migrations as applied:

| Version | Production migration |
|---:|---|
| `20260917204731` | `harden_financial_table_write_boundary` |
| `20260917205230` | `lock_users_client_write_surface` |
| `20260917205611` | `harden_client_write_boundary` |
| `20260917205630` | `close_remaining_client_table_writes` |

The production history also contains the surrounding platform-role and RPC hardening migrations that provide the server-side mutation boundary. These entries were verified through `supabase_migrations.schema_migrations` on the Production project.

The boundary verification showed that the production database contains the relevant protections: direct DML is revoked from `anon` and `authenticated` on the reviewed business/configuration tables, the authority-bearing self-update path on `public.users` is removed, and business mutations remain routed through server-side/RPC paths.

## Repository evidence

The complete Git history was searched before adding this record. The relevant boundary work exists in Git history under the following commits and files:

| Commit | Repository evidence |
|---|---|
| `3aad200` | Financial table write boundary migration |
| `05575ca` | Financial write-boundary verification migration |
| `a63a045` | Browser client write-boundary migration and earlier verification documentation |
| `0e646f4` | Remaining client table-write migration |
| `36b9718`, `04afc79` | Earlier iterations of the browser write-boundary migration |

PR #57 contains older copies of the boundary migrations and a short document that refer to alternate timestamps. Those files are not copied into `main`, because Production already records the canonical versions above and replaying the older copies would create migration-history drift or duplicate schema intent.

## Reconciliation rule

Future changes to this boundary must first compare all three sources:

1. the repository migration files and Git history;
2. `supabase_migrations.schema_migrations` in Production; and
3. the effective table privileges, policies, and RPC grants.

A new migration may be added only when it represents a genuinely new state transition that is absent from both Git and Production. A renamed or timestamp-shifted copy of an already-applied boundary migration must not be added.

## Scope and limitations

This verification documents the presence and alignment of the write boundary. It does not claim that every server-side RPC is perfect; each RPC still requires its own tenant, site, actor, idempotency, concurrency, and audit checks. It also does not authorize direct client DML or grant `service_role` to browser clients.

**Outcome:** PR #57's old migration code is not merged. The verified Production state is recorded in the repository without introducing a duplicate migration.
