import assert from 'node:assert/strict';
import test from 'node:test';
import {buildRealAppendDisposableSql} from './generate-real-delta-disposable.mjs';
import {loadPinnedProducerEvidence} from './cb-a-real-delta-producer-audit.mjs';

test('networkless runner embeds exact captured real append/pull functions with no approval',()=>{
 const evidence=loadPinnedProducerEvidence();
 const ddl=buildRealAppendDisposableSql(evidence);
 assert.equal(ddl,buildRealAppendDisposableSql(evidence));
 for(const f of evidence.functions.filter(x=>/powerhub_(append|pull)_fuel_maintenance/.test(x.identity))){
  assert.ok(ddl.includes(f.executable_ddl));
 }
 assert.match(ddl,/CREATE TABLE public\.powerhub_sync_scope_state/);
 assert.match(ddl,/PRIMARY KEY\(tenant_id,site_id,entity_type\)/);
 assert.match(ddl,/CREATE TABLE public\.powerhub_sync_changes/);
 assert.match(ddl,/PRIMARY KEY\(tenant_id,site_id,entity_type,cursor\)/);
 assert.match(ddl,/PR359_REAL_APPEND_ROLLBACK_ATOMICITY_PASS/);
 assert.match(ddl,/PR359_REAL_APPEND_DISTINCT_SCOPES_PASS/);
 assert.match(ddl,/PR359_CANONICAL_BASELINE_APPROVED=FALSE/);
 assert.ok(!ddl.includes('CANONICAL_BASELINE_APPROVED=TRUE'));
 assert.ok(!/\\connect|\\copy|dblink|postgres(?:ql)?:\/\//i.test(ddl));
});
test('source tampering fails before local DDL generation',()=>{
 const evidence=loadPinnedProducerEvidence();
 evidence.functions[0].executable_ddl=evidence.functions[0].executable_ddl.replace('last_cursor+1','last_cursor+9');
 assert.throws(()=>buildRealAppendDisposableSql(evidence));
});
