import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {parseBoundary,verifySource,compareBoundary,observedStagingBoundary} from './check-staging-privilege-boundary.mjs';
const sha=c=>c.repeat(64);
const baselineCounts=Object.fromEntries(Object.entries(observedStagingBoundary).map(([name,v])=>[name,v.objects]));
const rows=(count=baselineCounts,override={})=>
 Object.entries(count).map(([category,objects])=>
 JSON.stringify({category,objects,sha256:override[category]||observedStagingBoundary[category]?.sha256||sha('a')}))
 .join(String.fromCharCode(10))+String.fromCharCode(10);
test('reviewed inventory includes three categories with fixed source counts',()=>{
 assert.equal(verifySource(rows()).pass,true);
 // An attacker can keep catalog counts identical while widening grants.
 // Source must reject a changed SHA before the first data export.
 for(const cat of ['schema','default_acl','column_acl']){
  assert.throws(()=>verifySource(rows(undefined,{[cat]:sha('b')})),
   /unreviewed source privilege fingerprint/);
 }
 for(const cat of ['schema','default_acl','column_acl']){
  const changed={column_acl:0,default_acl:4,schema:3};
  changed[cat]++;
  assert.throws(()=>verifySource(rows(changed)),/unreviewed source privilege/);
 }
 assert.throws(()=>parseBoundary(rows().split(String.fromCharCode(10)).slice(0,2).join(String.fromCharCode(10))),/incomplete privilege/);
});
test('cross-restore comparison blocks any expanded or removed security grant',()=>{
 assert.equal(compareBoundary(rows(),rows()).pass,true);
 for(const cat of ['schema','default_acl','column_acl']){
  const outcome=compareBoundary(rows(),rows(undefined,{[cat]:sha('b')}));
  assert.equal(outcome.pass,false);
  assert.deepEqual(outcome.drift,[cat]);
  assert.equal(outcome.stagingInplaceGo,false);
 }
});
test('reviewer runs source attestation and two fail-closed restored checks',()=>{
 const exporter=readFileSync('scripts/pr359-r4/staging-atomic-export.sh','utf8');
 const twin=readFileSync('scripts/pr359-r4/check-independent-staging-exports.mjs','utf8');
 const runner=readFileSync('scripts/pr359-shadow/run.sh','utf8');
 const fixture=readFileSync('scripts/pr359-r4/staging-dump-filter-real-restore.sh','utf8');
 const sql=readFileSync('scripts/pr359-r4/staging-privilege-boundary.sql','utf8');
 assert.ok(exporter.includes('staging-privilege-boundary-source.jsonl'));
 assert.ok(exporter.indexOf('staging-privilege-boundary-source.jsonl')<exporter.indexOf('dump_schema schema.sql'));
 assert.ok(twin.includes("'staging-privilege-boundary-source.jsonl'"));
 assert.match(sql,/pg_namespace/);
 assert.match(sql,/pg_default_acl/);
 assert.match(sql,/attacl IS NOT NULL/);
 assert.match(sql,/READ ONLY/);
 assert.equal(runner.split('check_staging_privilege_boundary "$stage"').length-1,2);
 assert.ok(runner.indexOf('check_staging_privilege_boundary "$stage"')<runner.indexOf('SHADOW_STAGE=restore-data'));
 assert.ok(runner.includes('PR359_PRIVILEGE_BOUNDARY_MISMATCH_BLOCKED'));
 assert.ok(fixture.includes('PR359_LOCAL_PRIVILEGE_BOUNDARY_NEGATIVE_CONTROLS_PASS'));
});
