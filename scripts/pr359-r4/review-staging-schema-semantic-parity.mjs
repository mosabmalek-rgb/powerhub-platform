import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assessSchemaFingerprint} from './check-staging-schema-fingerprint.mjs';
import {diagnoseSchemaObjectDrift} from './diagnose-staging-schema-object-drift.mjs';
import {compareSchemaAttributes} from './diagnose-staging-schema-attribute-drift.mjs';

// Only the reviewed physical dropped-column ordinal shift and ACL storage
// representation can be canonicalized. The count of raw ACL discrepancies is
// NOT invariant: source-attested grant replay can alter textual proacl layout.
// Every normalized effective grant, definition, owner, RLS and all 7 schema
// categories must still match EXACTLY; no unauthorized ACL drift is allowed.
const COLUMNS='public.tenant_invoice_message_templates.';
export function reviewRestoredSchemaSemanticParity(
 sourceSemantic,targetSemantic,sourceObjects,targetObjects,sourceAttributes,targetAttributes
){
 const semantic=assessSchemaFingerprint(sourceSemantic,targetSemantic);
 assert.equal(semantic.definitionShaMatch,true,
   'effective PostgreSQL privileges or semantic schema definitions differ');
 const objectDiff=diagnoseSchemaObjectDrift(sourceObjects,targetObjects);
 assert.equal(objectDiff.match,false,'unexpected raw mismatch classification');
 const summary=Object.fromEntries(objectDiff.summary.map(x=>[x.category,x]));
 assert.ok(Object.keys(summary).every(k=>['columns','functions','relations'].includes(k)),
  'unreviewed raw catalog category');
 assert.ok(summary.columns,'reviewed dropped-column shift must be present');
 assert.deepEqual(
  {missing:summary.columns.missing,extra:summary.columns.extra,
   changed:[...summary.columns.changed].sort()},
  {missing:[COLUMNS+'9'],extra:[COLUMNS+'3'],
   changed:[4,5,6,7,8].map(n=>COLUMNS+n)},
  'only the reviewed dropped-attribute ordinal shift is allowed');
 for(const category of ['functions','relations']){
  const part=summary[category];
  if(!part)continue;
  assert.ok(part.changed.length>0,'empty raw '+category+' difference');
  assert.deepEqual(part.missing,[],'missing '+category+' object');
  assert.deepEqual(part.extra,[],'unexpected '+category+' object');
 }
 const details=compareSchemaAttributes(sourceAttributes,targetAttributes);
 assert.equal(details.match,false,'expected attribute-level raw differences');
 let sawColumns=false;
 const seenAclCategories=new Set();
 for(const g of details.summary){
  if(g.category==='functions'){
   assert.equal(g.field,'acl','unreviewed function definition/owner/security change');
   assert.ok(!seenAclCategories.has('functions'),'duplicate function ACL drift');
   seenAclCategories.add('functions');
   assert.deepEqual([...g.changed].sort(),[...(summary.functions?.changed||[])].sort());
   assert.deepEqual(g.missing,[]); assert.deepEqual(g.extra,[]);
  } else if(g.category==='relations'){
   assert.equal(g.field,'acl','unreviewed relation RLS/owner/kind/options change');
   assert.ok(!seenAclCategories.has('relations'),'duplicate relation ACL drift');
   seenAclCategories.add('relations');
   assert.deepEqual([...g.changed].sort(),[...(summary.relations?.changed||[])].sort());
   assert.deepEqual(g.missing,[]); assert.deepEqual(g.extra,[]);
  } else if(g.category==='columns'){
   sawColumns=true;
   assert.ok(['name','type','nullable','default','generated','identity'].includes(g.field),
     'unexpected column attribute');
   assert.deepEqual(g.missing,[COLUMNS+'9']);
   assert.deepEqual(g.extra,[COLUMNS+'3']);
   assert.ok(g.changed.every(id=>[4,5,6,7,8].some(n=>id===COLUMNS+n)),
     'column metadata changed outside the reviewed physical ordinal shift');
  } else throw Error('Unreviewed schema drift category');
 }
 assert.equal(sawColumns,true,'reviewed physical column drift not evidenced');
 for(const category of ['functions','relations'])
  assert.equal(seenAclCategories.has(category),Boolean(summary[category]),
   'unexpected missing or extra raw ACL field difference');
 return {canonicalSemanticParity:true,reviewedPhysicalDrift:true,
  scopeCount:semantic.scopeCount,appOwnedApproved:false,
  stagingInplaceGo:false,productionInplaceGo:false,mergeGo:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 assert.equal(process.argv.length,8,
  'Usage: review-staging-schema-semantic-parity.mjs source-sem target-sem source-objects target-objects source-attrs target-attrs');
 const paths=process.argv.slice(2);
 const result=reviewRestoredSchemaSemanticParity(...paths.map(p=>readFileSync(p,'utf8')));
 console.log('PR359_R4_FULL_SEVEN_CATEGORY_SEMANTIC_PARITY='+result.canonicalSemanticParity);
 console.log('PR359_R4_ONLY_REVIEWED_PHYSICAL_ACL_ORDINAL_DRIFT='+result.reviewedPhysicalDrift);
 console.log('PR359_R4_SEMANTIC_CATEGORIES_CHECKED='+result.scopeCount);
 console.log('PR359_APP_OWNED_APPROVED=FALSE');
 console.log('PR359_STAGING_INPLACE_GO=FALSE');
 console.log('PR359_PRODUCTION_INPLACE_GO=FALSE');
 console.log('PR359_MERGE_GO=FALSE');
}
