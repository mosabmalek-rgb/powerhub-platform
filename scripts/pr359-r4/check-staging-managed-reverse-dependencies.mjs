import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';

// Verified twice in read-only transactions on Staging 2026-11-20.
// This is a drift guard, never a destructive-operations allowlist.
export const EXPECTED_REVERSE_DEPENDENCIES=Object.freeze({
  scope:'PR359_R4_MANAGED_REVERSE_DEPENDENCIES_V1',
  edge_count:48,
  identity_sha256:'86c83659f5781ac140aa6145ba651b8d2d5a6b0042df3305090c02b094f8722f',
  groups:[
    {source_catalog:'pg_policy',source_schema:'realtime',target_catalog:'pg_class',deptype:'n',edges:32},
    {source_catalog:'pg_policy',source_schema:'realtime',target_catalog:'pg_proc',deptype:'n',edges:11},
    {source_catalog:'pg_policy',source_schema:'storage',target_catalog:'pg_class',deptype:'n',edges:4},
    {source_catalog:'pg_policy',source_schema:'storage',target_catalog:'pg_proc',deptype:'n',edges:1}
  ]
});
const sortedFields=(x)=>Object.keys(x).sort();
export function assessManagedReverseDependencies(raw){
 assert.equal(typeof raw,'string');
 const lines=raw.trim().split(/\r?\n/);
 assert.equal(lines.length,1,'expected one managed reverse dependency inventory');
 const incoming=JSON.parse(lines[0]);
 assert.deepEqual(sortedFields(incoming),sortedFields(EXPECTED_REVERSE_DEPENDENCIES),
   'unreviewed reverse inventory fields');
 assert.equal(incoming.scope,EXPECTED_REVERSE_DEPENDENCIES.scope);
 assert.ok(Number.isSafeInteger(incoming.edge_count)&&incoming.edge_count>=0);
 assert.match(incoming.identity_sha256,/^[0-9a-f]{64}$/);
 assert.ok(Array.isArray(incoming.groups),'reverse dependency groups missing');
 let total=0;
 for(const group of incoming.groups){
   assert.deepEqual(sortedFields(group),sortedFields(EXPECTED_REVERSE_DEPENDENCIES.groups[0]));
   assert.ok(Number.isSafeInteger(group.edges)&&group.edges>=0);
   total+=group.edges;
 }
 assert.equal(total,incoming.edge_count,'reverse dependency group count mismatch');
 const same=incoming.edge_count===EXPECTED_REVERSE_DEPENDENCIES.edge_count &&
  incoming.identity_sha256===EXPECTED_REVERSE_DEPENDENCIES.identity_sha256 &&
  // PostgreSQL jsonb object keys may appear in a different order than JS object
  // literals. Compare the reviewed values/array order, never JSON key order.
  isDeepStrictEqual(incoming.groups,EXPECTED_REVERSE_DEPENDENCIES.groups);
 return {matched:same,edgeCount:incoming.edge_count,
   reviewedObjectRemoval:false,appOwnedApproved:false,stagingInplaceGo:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 assert.equal(process.argv.length,3,'Usage: check-staging-managed-reverse-dependencies.mjs source.json');
 const result=assessManagedReverseDependencies(readFileSync(process.argv[2],'utf8'));
 console.log('PR359_STAGING_MANAGED_REVERSE_DEPS_MATCH='+result.matched);
 console.log('PR359_STAGING_MANAGED_REVERSE_DEPS_EDGES='+result.edgeCount);
 console.log('PR359_APP_OWNED_APPROVED=FALSE');
 console.log('PR359_STAGING_INPLACE_GO=FALSE');
 if(!result.matched){
   console.error('PR359_MANAGED_REVERSE_DEPENDENCY_DRIFT');
   process.exitCode=2;
 }
}
