import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
const source=()=>readFileSync('scripts/pr359-canonical/fixtures/real-delta-retention-disposable.sql','utf8');
test('retention test must require actual captured append and pull, scoped reset and real paging',()=>{
 const sql=source();
 assert.match(sql,/generate_series\(1,10499\)/);
 assert.match(sql,/powerhub_append_fuel_maintenance_delta_sync_change\(/);
 assert.match(sql,/powerhub_pull_fuel_maintenance_sync_delta\(1,102,'fuel_events',499,NULL,200\)/);
 assert.match(sql,/powerhub_pull_fuel_maintenance_sync_delta\(1,102,'fuel_events',500,10500,200\)/);
 assert.match(sql,/retained_from_cursor.*?<>500/s);
 assert.match(sql,/count\(\*\).*?<>10000/s);
 assert.match(sql,/jsonb_array_length\(page1->'changes'\)<>200/);
 assert.match(sql,/PR359_REAL_RETENTION_10500_RESET_REQUIRED_PASS/);
 assert.match(sql,/PR359_ANDROID_REBOOTSTRAP_RUNTIME_VERIFIED=FALSE/);
 assert.match(sql,/PR359_CANONICAL_BASELINE_APPROVED=FALSE/);
 assert.ok(!sql.includes('CANONICAL_BASELINE_APPROVED=TRUE'));
 assert.ok(!/\\connect|\\copy|dblink|postgres(?:ql)?:\/\//i.test(sql));
});
