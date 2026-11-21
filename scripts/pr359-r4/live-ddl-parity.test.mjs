import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  buildReadOnlyBatchPlan,makeReadOnlyBatch,
  assessBatchReports,expectedTotals
} from './live-ddl-parity.mjs';

const load=(file)=>JSON.parse(readFileSync(file,'utf8'));
const plan=()=>buildReadOnlyBatchPlan(
 load('docs/security/pr359-r0-staging-functions-20261119.json'),
 load('docs/security/pr359-r0-staging-indexes-constraints-20261119.json')
);
const passing=(p)=>p.map(x=>({kind:x.kind,batch:x.batch,total_batches:x.total_batches,
  expected_batch:x.expected_count,actual_total:expectedTotals[x.kind],
  missing:0,changed:0,sample:[]}));

test('historical evidence generates every read-only SHA batch without skipping objects',()=>{
 const p=plan();
 assert.equal(p.length,22);
 assert.equal(p.filter(x=>x.kind==='functions').length,7);
 assert.equal(p.filter(x=>x.kind==='catalog').length,15);
 assert.equal(p.reduce((n,x)=>n+x.expected_count,0),641+2125);
 assert.match(p.find(x=>x.kind==='catalog').sql,/pg_get_constraintdef\(c\.oid,true\)/);
 assert.match(p.find(x=>x.kind==='functions').sql,/pg_get_functiondef\(p\.oid\)/);
 for(const entry of p){
  assert.ok(entry.sql.startsWith('-- PR359 R4: read-only'));
  assert.ok(entry.sql.includes('SELECT jsonb_build_object'));
  assert.ok(entry.sql.trimEnd().endsWith('AS pr359_r4_attestation;'));
 }
});
test('complete SHA parity is evidence only, never R4 authorization',()=>{
 const p=plan();
 const result=assessBatchReports(p,passing(p));
 assert.equal(result.metadataParityPassed,true,JSON.stringify(result.blockers));
 assert.deepEqual(result.totals,expectedTotals);
 assert.equal(result.stagingInplaceGo,false);
 assert.equal(result.dropAuthorized,false);
});
test('missing, extra, altered hashes or partial results block evidence acceptance',()=>{
 const p=plan(),base=passing(p);
 assert.ok(assessBatchReports(p,base.slice(1)).blockers.includes('INCOMPLETE_REPORT_COLLECTION'));
 const a=structuredClone(base);a[0].changed=1;a[0].sample=['some_definition'];
 assert.ok(assessBatchReports(p,a).blockers.some(b=>b.startsWith('DDL_PARITY_MISMATCH')));
 const b=structuredClone(base);b[0].actual_total++;
 assert.ok(assessBatchReports(p,b).blockers.some(x=>x.startsWith('COUNT_OR_BATCH_DRIFT')));
 const c=structuredClone(base);c.push(c[0]);
 assert.ok(assessBatchReports(p,c).blockers.some(x=>x.startsWith('DUPLICATE_REPORT')));
});
test('embedded apostrophes in metadata do not escape the SQL JSON literal',()=>{
 const sql=makeReadOnlyBatch('functions',[{identity:"public.example(text' OR 1=1 --)",sha:'a'.repeat(64)}],1,1);
 assert.ok(sql.includes("text'' OR 1=1 --"));
 assert.equal((sql.match(/SELECT jsonb_build_object/g)||[]).length,1);
});
test('unexpected source rows or modified hashes are rejected before query creation',()=>{
 const a=load('docs/security/pr359-r0-staging-functions-20261119.json');
 a.objects[0].definition_sha256='invalid';
 assert.throws(()=>buildReadOnlyBatchPlan(a,load('docs/security/pr359-r0-staging-indexes-constraints-20261119.json')));
 const b=load('docs/security/pr359-r0-staging-indexes-constraints-20261119.json');
 b.objects.push({...b.objects[0]});
 assert.throws(()=>buildReadOnlyBatchPlan(load('docs/security/pr359-r0-staging-functions-20261119.json'),b));
});
