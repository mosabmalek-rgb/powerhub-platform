import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const EXPECTED_SURFACE=Object.freeze({
 columns:2723,constraints:1437,functions:641,indexes:688,
 policies:129,relations:337,triggers:202
});
// Observed twice directly from read-only Staging catalog transactions on
// 2026-11-20. This is a drift tripwire, not an APP_OWNED or baseline approval.
export const REVIEWED_STAGING_SHA256=Object.freeze({
 columns:'94ea6f6d596ddd15b2470d58b932560fb06342fa72b66903e4bab92801f854e5',
 constraints:'98578119d651da5537133463c8b0ea7abf202ceec9d87b66a3a3d866556f13f4',
 functions:'1427e72722c0fa4f2d20c20c5a9157845d819503e221f32a430ecef14b3fdccd',
 indexes:'976f2eb76232b86ab964a160279494e984bfc8f11dc50a74243a148b391df170',
 policies:'bb3051d6d8adc6a0d86a80ed2914c1d678315b30759e969220aa3a40b18fe5f7',
 relations:'847ce3f0e4442c67fb62be8dd0e3730cab7cec2f5aef4c73a233eddb2c57c7b7',
 triggers:'59b4cf5fd8f4bbadc60d2e6dab650e7599bc8172632fa4699d7a960f9734d3c9'
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
export function assessReviewedStagingSource(snapshot) {
 const parsed=parseSchemaFingerprint(snapshot);
 const changedCategories=expectedNames.filter(name=>parsed.get(name)!==REVIEWED_STAGING_SHA256[name]);
 return {
  reviewedSourceMatch:changedCategories.length===0,
  checked:expectedNames.length,
  changedCategories,
  // An observed hash is not an authorization to drop or rebuild objects.
  canonicalBaselineApproved:false,appOwnedSigned:false,stagingInplaceGo:false
 };
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
 const [mode,sourcePath,targetPath]=process.argv.slice(2);
 if(mode==='--verify-reviewed-source'){
  assert.equal(process.argv.length,4,
   'Usage: check-staging-schema-fingerprint.mjs --verify-reviewed-source source.jsonl');
  const r=assessReviewedStagingSource(readFileSync(sourcePath,'utf8'));
  console.log('PR359_STAGING_REVIEWED_SOURCE_SCHEMA_MATCH='+r.reviewedSourceMatch);
  console.log('PR359_STAGING_SCHEMA_CATEGORIES_CHECKED='+r.checked);
  console.log('PR359_CANONICAL_BASELINE_APPROVED=FALSE');
  console.log('PR359_STAGING_INPLACE_GO=FALSE');
  if(!r.reviewedSourceMatch){
   console.error('PR359_STAGING_REVIEWED_SCHEMA_DRIFT='+r.changedCategories.join(','));
   process.exitCode=2;
  }
 }else{
  assert.equal(process.argv.length,5,
   'Usage: check-staging-schema-fingerprint.mjs --compare source.jsonl target.jsonl');
  assert.equal(mode,'--compare');
  const r=assessSchemaFingerprint(readFileSync(sourcePath,'utf8'),readFileSync(targetPath,'utf8'));
  console.log('PR359_STAGING_SCHEMA_CATEGORIES_CHECKED='+r.scopeCount);
  console.log('PR359_STAGING_APP_SCHEMA_FINGERPRINT_MATCH='+r.definitionShaMatch);
  console.log('PR359_CANONICAL_BASELINE_APPROVED=FALSE');
  console.log('PR359_STAGING_INPLACE_GO=FALSE');
  if(!r.definitionShaMatch){
   console.error('PR359_STAGING_SCHEMA_MISMATCH_CATEGORIES='+r.changedCategories.join(','));
   process.exitCode=2;
  }
 }
}
