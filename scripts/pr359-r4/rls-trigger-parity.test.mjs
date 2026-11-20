import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildSurfacePlan,assessSurfaceReports,makeSurfaceBatch,REFERENCE_PATH} from './rls-trigger-parity.mjs';
const inventory=()=>JSON.parse(readFileSync(REFERENCE_PATH,'utf8'));
const plan=()=>buildSurfacePlan(inventory());
const passing=items=>items.map(x=>({kind:'rls_trigger',batch:x.number,total_batches:x.totalBatches,
  expected_batch:x.expected,actual_total:331,missing:0,changed:0,sample:[]}));

test('all 129 app policies and 202 triggers are covered, provider managed excluded',()=>{
 const x=plan();
 assert.equal(x.length,5);
 assert.equal(x.reduce((a,b)=>a+b.expected,0),331);
 assert.match(x[0].sql,/pg_get_triggerdef\(t.oid,true\)/);
 assert.match(x[0].sql,/pg_get_expr\(p.polwithcheck,p.polrelid\)/);
 assert.match(x[0].sql,/p.polpermissive/);
 assert.match(x[0].sql,/t.tgenabled/);
 assert.ok(x.every(b=>b.sql.trimEnd().endsWith('AS pr359_r4_surface_attestation;')));
});
test('green reports prove only metadata parity, never R4 execution approval',()=>{
 const x=plan(),result=assessSurfaceReports(x,passing(x));
 assert.equal(result.validated,true);
 assert.equal(result.appPolicyCount,129);
 assert.equal(result.appTriggerCount,202);
 assert.equal(result.dropAuthorized,false);
 assert.equal(result.stagingInplaceGo,false);
});
test('wrong totals, altered policy or trigger, duplicate, missing results fail closed',()=>{
 const x=plan();
 const a=passing(x);a[0].changed=1;a[0].sample=['users.changed_policy'];
 assert.ok(assessSurfaceReports(x,a).blockers.some(z=>z.startsWith('SURFACE_SECURITY_DRIFT')));
 const b=passing(x);b[0].actual_total++;
 assert.ok(assessSurfaceReports(x,b).blockers.some(z=>z.startsWith('SURFACE_COUNT_OR_BATCH_DRIFT')));
 const c=passing(x);c[1]=c[0];
 assert.ok(assessSurfaceReports(x,c).blockers.some(z=>z.startsWith('DUPLICATE_SURFACE_REPORT')));
 assert.equal(assessSurfaceReports(x,passing(x).slice(1)).validated,false);
});
test('source corruption or provider-managed object reclassification cannot pass',()=>{
 const a=inventory();a.objects.splice(a.objects.findIndex(x=>x.schema==='public'),1);
 assert.throws(()=>buildSurfacePlan(a));
 const b=inventory();const provider=b.objects.find(x=>x.schema!=='public');
 provider.schema='public';
 assert.throws(()=>buildSurfacePlan(b));
 const c=inventory();const trig=c.objects.find(x=>x.category==='TRIGGER'&&x.schema==='public');
 trig.details.definition_sha256='x';
 assert.throws(()=>buildSurfacePlan(c));
 const d=inventory();const pol=d.objects.find(x=>x.category==='POLICY'&&x.schema==='public');
 pol.details.roles=['anon','authenticated'];
 assert.throws(()=>buildSurfacePlan(d),undefined);
});
test('SQL quote escaping never creates a second statement',()=>{
 const sql=makeSurfaceBatch([{category:'POLICY',schema:'public',
  identity:"x'; DROP TABLE accounts; --",using_sha:'a'.repeat(64),
  check_sha:'b'.repeat(64),roles:['authenticated'],cmd:'r',permissive:true}],1,1);
 assert.match(sql,/x''; DROP TABLE/);
 assert.equal((sql.match(/AS pr359_r4_surface_attestation;/g)||[]).length,1);
});
