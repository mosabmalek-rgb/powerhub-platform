import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {auditEleven,pinnedJson} from './audit-eleven-live-gaps.mjs';
const load=p=>JSON.parse(readFileSync(p,'utf8'));
const factory=()=>[
 load('docs/security/pr359-cb-a-six-function-live-evidence-20261123.json'),
 load('docs/security/pr359-cb-a-five-table-live-evidence-20261123.json'),
 load('docs/security/pr359-r0-staging-functions-20261119.json'),
 load('docs/security/pr359-r0-staging-relations-20261119.json'),
 load('docs/security/pr359-r4-staging-object-register-20261120.json')];
test('Six exact live definitions and five table catalogs reconcile R0; nobody approved',()=>{
 const result=auditEleven(...factory());
 assert.equal(result.live_functions_reconciled,6);
 assert.equal(result.live_tables_reconciled,5);
 assert.equal(result.object_approvals,0);
 assert.equal(result.remaining_object_reviews,978);
 assert.equal(result.staging_inplace_go,false);
});
test('Security and drift regressions fail closed',()=>{
 const changes=[
  a=>{a[0].functions[0].sha256='0'.repeat(64)},
  a=>{a[0].functions[0].authenticated_execute=true},
  a=>{a[0].functions[2].security_definer=false},
  a=>{a[1].tables[0].rls=false},
  a=>{a[1].tables[0].anon_select=true},
  a=>{a[1].tables[0].columns[0].type='text'},
  a=>{a[1].tables[0].policies.push({name:'unreviewed'})},
  a=>{a[1].tables[0].indexes[0].valid=false},
  a=>{a[1].tables[1].triggers.pop()},
  a=>{a[4].objects.find(x=>x.id==='p6_assert_subscription_guard()').reviewed=true},
  a=>{a[0].canonical_baseline_approved=true}
 ];
 for(const change of changes){const fixture=factory();change(fixture);
  assert.throws(()=>auditEleven(...fixture));}
});
test('Pinned live evidence blobs cannot change',()=>{
 assert.throws(()=>pinnedJson('{"forged":true}','0'.repeat(40)),/pinned evidence blob changed/);
});
