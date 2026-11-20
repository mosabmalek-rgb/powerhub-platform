import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const EXPECTED_SURFACE=Object.freeze({
 columns:2723,constraints:1437,functions:641,indexes:688,
 policies:129,relations:337,triggers:202
});
const expectedNames=Object.keys(EXPECTED_SURFACE).sort();
export function parseSchemaFingerprint(lines){
 assert.equal(typeof lines,'string');
 const rows=lines.split(/\r?\n/).filter(Boolean);
 assert.equal(rows.length,expectedNames.length,'missing or unexpected catalog category');
 const out=new Map();
 for(const line of rows){
  const x=JSON.parse(line);
  assert.deepEqual(Object.keys(x).sort(),['category','objects','sha256']);
  assert.ok(Object.hasOwn(EXPECTED_SURFACE,x.category),'unreviewed catalog category');
  assert.ok(!out.has(x.category),'duplicate catalog category');
  assert.equal(x.objects,EXPECTED_SURFACE[x.category],'catalog inventory count drift in '+x.category);
  assert.match(x.sha256,/^[0-9a-f]{64}$/,'invalid catalog fingerprint');
  out.set(x.category,x.sha256);
 }
 assert.equal(out.size,expectedNames.length);
 return out;
}
export function assessSchemaFingerprint(before,after){
 const source=parseSchemaFingerprint(before),target=parseSchemaFingerprint(after);
 const mismatches=[];
 for(const [name,hash] of source){
  if(target.get(name)!==hash)mismatches.push(name);
 }
 return {scopeCount:source.size,identityCountsMatch:true,
   definitionShaMatch:mismatches.length===0,changedCategories:mismatches,
   canonicalBaselineApproved:false,appOwnedSigned:false,stagingInplaceGo:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 assert.equal(process.argv.length,5,'Usage: check-staging-schema-fingerprint.mjs --compare source.jsonl target.jsonl');
 assert.equal(process.argv[2],'--compare');
 const r=assessSchemaFingerprint(readFileSync(process.argv[3],'utf8'),readFileSync(process.argv[4],'utf8'));
 console.log('PR359_STAGING_SCHEMA_CATEGORIES_CHECKED='+r.scopeCount);
 console.log('PR359_STAGING_APP_SCHEMA_FINGERPRINT_MATCH='+r.definitionShaMatch);
 console.log('PR359_CANONICAL_BASELINE_APPROVED=FALSE');
 console.log('PR359_STAGING_INPLACE_GO=FALSE');
 if(!r.definitionShaMatch){
  console.error('PR359_STAGING_SCHEMA_MISMATCH_CATEGORIES='+r.changedCategories.join(','));
  process.exitCode=2;
 }
}
