import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compareAclCensus,parseAclCensus} from './diagnose-staging-acl-grant-census.mjs';
const row=(grantee,objects=1)=>JSON.stringify({category:'functions',schema:'public',
 grantor:'postgres',grantee,grantable:false,privilege:'EXECUTE',objects});
test('read-only grouped ACL census detects a new PUBLIC grant',()=>{
 const src=row('service_role')+'\n',dst=src+row('PUBLIC')+'\n';
 const diff=compareAclCensus(src,dst);
 assert.equal(diff.match,false);
 assert.deepEqual(diff.deviations.map(x=>[x.grantee,x.source,x.target]),[['PUBLIC',0,1]]);
 assert.equal(diff.stagingInplaceGo,false);
});
test('census catches same-total grant role replacement',()=>{
 const src=row('service_role')+'\n';
 const dst=row('anon')+'\n';
 const result=compareAclCensus(src,dst);
 assert.equal(result.match,false);
 assert.equal(result.deviations.length,2);
 assert.equal(compareAclCensus(src,src).match,true);
});
test('rejects untrusted role label or duplicate group',()=>{
 assert.throws(()=>parseAclCensus(row('custom_private_role')),/unexpected grantee label/);
 assert.throws(()=>parseAclCensus(row('service_role')+'\n'+row('service_role')),/duplicate ACL census/);
});
test('diagnostic does not suppress strict seven-category semantic gate',()=>{
 const exporter=readFileSync('scripts/pr359-r4/staging-atomic-export.sh','utf8');
 const twin=readFileSync('scripts/pr359-r4/check-independent-staging-exports.mjs','utf8');
 const runner=readFileSync('scripts/pr359-shadow/run.sh','utf8');
 const fixture=readFileSync('scripts/pr359-r4/staging-dump-filter-real-restore.sh','utf8');
 assert.ok(exporter.includes('staging-acl-grant-census-source.jsonl'));
 assert.ok(twin.includes("'staging-acl-grant-census-source.jsonl'"));
 assert.ok(runner.includes('PR359_R4_ACL_GRANT_CENSUS_DIAGNOSTIC_FAILED'));
 assert.ok(runner.includes('PR359_R4_UNREVIEWED_RESTORED_SCHEMA_DRIFT_BLOCKED'));
 assert.ok(runner.includes('review-staging-schema-semantic-parity.mjs'));
 assert.ok(runner.indexOf('diagnose-staging-acl-grant-census.mjs')>
   runner.indexOf('review-staging-schema-semantic-parity.mjs'));
 assert.ok(fixture.includes('PR359_LOCAL_ACL_GRANT_CENSUS_NEGATIVE_CONTROL_PASS'));
});
