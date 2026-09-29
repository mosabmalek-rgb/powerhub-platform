# PowerHub Documentation

## Start here

- [Current repository status](CURRENT_STATUS.md)
- [Access model](access-model.md)
- [Production release checklist](production-release-checklist.md)
- [Production verification](production-verification.md)
- [Supabase migration status](admin-supabase-migration-status.md)
- [Full platform acceptance test](full-platform-acceptance-test-plan-2026-09-17.md)

## Architecture and operations

- `architecture/` — architecture decisions and contracts.
- `ops/` — operational runbooks and deployment material.
- Active `*.md` files — current product, security, integration and release documentation.
- `archive/YYYY-MM/` — historical snapshots and superseded notes; not authoritative for current behavior.

## Source of truth

For implementation behavior, source code and current database migrations are authoritative. Documentation is supporting material and must not be used to infer that a feature is enabled merely because an old note mentions it.

Before release, use the production release checklist and verify the exact deployed commit.
