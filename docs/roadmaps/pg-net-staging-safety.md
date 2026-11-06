# pg_net Staging controls

Staging exposes only `public` and `graphql_public` through the Data API.
The `net` schema is not in the exposed-schema list. The `extensions`
entry in Extra search path does not expose that schema.

On the inspected hosted project, pg_net objects are owned by
`supabase_admin`; migrations run as `postgres`. The pg_net worker uses
`pg_net.username = postgres`. Preserve Supabase-managed grants: do not
revoke `PUBLIC` access or assume the migration role owns the extension.

The first pg_net migration installs the extension in `extensions` on a
fresh database and does not create HTTP jobs. The second is a placement
preflight only. `CREATE EXTENSION IF NOT EXISTS` does not relocate an
already-installed extension.

Staging still requires an independently authorized, Supabase-managed
relocation. Record queue and response counts first. Staging currently has
zero queued requests and six stored responses; those response records must
not be discarded without an explicit decision.

Keep HTTP scheduling out of schema migrations. A separate Staging operation
must verify the Staging deployment, an explicit Staging environment marker,
its own HTTPS application origin, the matching Staging bearer secret, the
extension's final schema, and the exact job definitions. Never copy the
Production secret or use a Production URL.

Production already has pg_net in `extensions` and active pg_net jobs.
Do not modify Production jobs, Vault values, extension placement, or response
history during this Staging review.
