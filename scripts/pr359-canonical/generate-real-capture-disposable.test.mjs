import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {buildRealCaptureDisposableSql,CAPTURE_TEMPLATE} from './generate-real-capture-disposable.mjs';
import {loadPinnedProducerEvidence} from './cb-a-real-delta-producer-audit.mjs';

test('archived operational trigger chain is inserted unchanged, and test stubs remain explicit',()=>{
 const data=loadPinnedProducerEvidence();
 const sql=buildRealCaptureDisposableSql(data);
 assert.equal(sql,buildRealCaptureDisposableSql(data));
 for(const name of ['powerhub_append_fuel_maintenance_delta_sync_change',
                      'powerhub_emit_fuel_maintenance_delta_sync_change',
                      'powerhub_capture_fuel_maintenance_delta_sync_change']){
  const f=data.functions.find(x=>x.identity.startsWith(name+'('));
  assert.ok(f && sql.includes(f.executable_ddl.trimEnd()),name);
 }
 const triggers=data.functions.find(x=>x.identity==='powerhub_capture_fuel_maintenance_delta_sync_change()').direct_triggers;
 for(const t of triggers)assert.ok(sql.includes(t.definition),t.name);
 for(const k of ['PR359_REAL_CAPTURE_FUEL_LIFECYCLE_PASS',
  'PR359_REAL_CAPTURE_SCOPE_MOVE_PASS','PR359_REAL_CAPTURE_PARTS_SCOPE_PASS',
  'PR359_REAL_CAPTURE_SOURCE_LOG_ROLLBACK_PASS',
  'PR359_REAL_CAPTURE_INVALID_SCOPE_ROLLBACK_PASS',
  'PR359_REAL_TRIGGER_FULL_PROJECTION_AND_RLS_VERIFIED=FALSE',
  'PR359_CANONICAL_BASELINE_APPROVED=FALSE']) assert.ok(sql.includes(k));
 assert.equal((sql.match(/CREATE TRIGGER powerhub_delta_/g)||[]).length,3);
 assert.ok(!sql.includes('CANONICAL_BASELINE_APPROVED=TRUE'));
});
test('missing placeholder or altered pinned function source fails closed',()=>{
 const template=readFileSync(CAPTURE_TEMPLATE,'utf8');
 assert.throws(()=>buildRealCaptureDisposableSql(loadPinnedProducerEvidence(),
  template.replace('-- PR359_PINNED_CAPTURE_EMIT','-- MISSING')));
 const modified=loadPinnedProducerEvidence();
 modified.functions[0].executable_ddl=modified.functions[0].executable_ddl.replace('last_cursor+1','last_cursor+9');
 assert.throws(()=>buildRealCaptureDisposableSql(modified));
});
