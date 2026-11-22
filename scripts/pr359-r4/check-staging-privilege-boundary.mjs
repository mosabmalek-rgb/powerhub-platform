import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const categories=['column_acl','default_acl','schema'];
// Immutable OBSERVED source catalog evidence captured from read-only Staging
// iyuryuhaylhisjfcrwkz on 2026-11-22 using staging-privilege-boundary.sql.
// The source SHA must match BOTH the reviewed object counts and content hashes.
// It is NOT approval for APP_OWNED, rebaseline, in-place cutover, or PR merge.
export const observedStagingBoundary=Object.freeze({
 column_acl:Object.freeze({objects:0,sha256:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'}),
 default_acl:Object.freeze({objects:4,sha256:'798d82d1e21dcbe5bc080f9433efc22d50307122c495fe4f2522304aef75d41b'}),
 schema:Object.freeze({objects:3,sha256:'79fe12e8da35c07850612559c5edd288844e0611b6f120c1a7f5bbf6ebc5d504'})
});
export function parseBoundary(raw){
 assert.equal(typeof raw,'string');
 const lines=raw.trim().split(String.fromCharCode(10)).map(x=>x.trim()).filter(Boolean);
 assert.equal(lines.length,3,'incomplete privilege evidence');
 const records=new Map();
 for(const line of lines){
  const row=JSON.parse(line);
  assert.deepEqual(Object.keys(row).sort(),['category','objects','sha256']);
  assert.ok(categories.includes(row.category),'unreviewed privilege category');
  assert.ok(Number.isSafeInteger(row.objects)&&row.objects>=0,'invalid count');
  assert.match(row.sha256,/^[a-f0-9]{64}$/);
  assert.ok(!records.has(row.category),'duplicate category');
  records.set(row.category,row);
 }
 assert.deepEqual([...records.keys()].sort(),categories);
 return records;
}
export function verifySource(raw){
 const records=parseBoundary(raw);
 for(const category of categories){
  assert.equal(records.get(category).objects,observedStagingBoundary[category].objects,
    'unreviewed source privilege inventory '+category);
  assert.equal(records.get(category).sha256,observedStagingBoundary[category].sha256,
    'unreviewed source privilege fingerprint '+category);
 }
 return {pass:true};
}
export function compareBoundary(source,target){
 const a=parseBoundary(source),b=parseBoundary(target);
 const drift=categories.filter(cat=>a.get(cat).objects!==b.get(cat).objects||
   a.get(cat).sha256!==b.get(cat).sha256);
 return {pass:drift.length===0,drift,stagingInplaceGo:false,mergeGo:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [mode,first,second]=process.argv.slice(2);
 if(mode==='--verify-source'){
  assert.ok(first&&!second);
  verifySource(readFileSync(first,'utf8'));
  console.log('PR359_REVIEWED_SOURCE_PRIVILEGE_INVENTORY_PASS');
 }else if(mode==='--compare'){
  assert.ok(first&&second);
  const outcome=compareBoundary(readFileSync(first,'utf8'),readFileSync(second,'utf8'));
  for(const category of outcome.drift)console.error('PR359_PRIVILEGE_DRIFT='+category);
  if(!outcome.pass){console.error('PR359_PRIVILEGE_BOUNDARY_MISMATCH_BLOCKED');process.exitCode=2;}
  else console.log('PR359_PRIVILEGE_BOUNDARY_PARITY_PASS');
 }else if(mode==='--compare-default-only'){
  assert.ok(first&&second,'source and local target evidence required');
  const source=parseBoundary(readFileSync(first,'utf8'));
  const target=parseBoundary(readFileSync(second,'utf8'));
  const a=source.get('default_acl'),b=target.get('default_acl');
  assert.ok(a.objects>0,'missing source future-object ACL contract');
  const match=a.objects===b.objects&&a.sha256===b.sha256;
  console.log('PR359_LOCAL_PRE_SCHEMA_DEFAULT_ACL_PARITY='+match);
  if(!match){console.error('PR359_LOCAL_DEFAULT_ACL_DRIFT_BLOCKED');process.exitCode=2;}
 }else throw Error('Usage: --verify-source source | --compare source target | --compare-default-only source local-target');
 console.log('PR359_STAGING_INPLACE_GO=FALSE');
 console.log('PR359_MERGE_GO=FALSE');
}
