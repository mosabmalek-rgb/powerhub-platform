import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const exporter=()=>readFileSync('scripts/pr359-r4/staging-atomic-export.sh','utf8');
const runner=()=>readFileSync('scripts/pr359-shadow/run.sh','utf8');
test('provider-managed metadata collectors import the same exported source MVCC snapshot',()=>{
 const x=exporter();
 for(const q of ['for surface in catalog migrations relations; do','source_psql "$workdir/staging-managed-$surface-snapshot.json"','scripts/pr359-shadow/managed-$surface.sql','source-managed-$surface.json','staging-managed-$surface-snapshot.json','PR359_STAGING_PROVIDER_MANAGED_PREFLIGHT_SNAPSHOT_DRIFT'])assert.ok(x.includes(q),q);
 assert.ok(x.indexOf('for surface in catalog migrations relations; do')<x.indexOf('dump_schema schema.sql'));
});
test('existing provider compatibility and Production exporter remain intact',()=>{
 const x=runner();
 for(const q of ['source-managed-catalog.json','source-managed-migrations.json','source-managed-relations.json','docker-managed-catalog.json','docker-managed-migrations.json','docker-managed-relations.json','check-managed-stack-compatibility.mjs','dump roles.sql --role-only','dump schema.sql','dump history-data.sql --schema supabase_migrations --data-only --use-copy']) assert.ok(x.includes(q),q);
});
test('metadata parity does not authorize Staging modification',()=>{
 const x=exporter();
 assert.ok(x.includes('PR359_STAGING_INPLACE_GO=FALSE'));
 assert.doesNotMatch(x,/\b(?:DROP|TRUNCATE|DELETE FROM)\b/i);
});
