import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assessSchemaFingerprint} from './check-staging-schema-fingerprint.mjs';
import {diagnoseSchemaObjectDrift} from './diagnose-staging-schema-object-drift.mjs';
import {compareSchemaAttributes} from './diagnose-staging-schema-attribute-drift.mjs';

// Only the exact, source-reviewed physical catalog differences observed in
// protected Staging run 44903864944 may be canonicalized. Semantic equality
// compares every grantor, grantee, privilege and grant option and all 7 schema
// categories; it is NOT a shortcut around ACL/RLS or a hosted cutover permit.
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
 assert.deepEqual(Object.keys(summary).sort(),['columns','functions','relations']);
 assert.deepEqual(
  {missing:summary.columns.missing,extra:summary.columns.extra,
   changed:[...summary.columns.changed].sort()},
  {missing:[COLUMNS+'9'],extra:[COLUMNS+'3'],
   changed:[4,5,6,7,8].map(n=>COLUMNS+n)},
  'only the reviewed dropped-attribute ordinal shift is allowed');
 for(const [category,count] of [['functions',579],['relations',216]]){
  const part=summary[category];
  assert.equal(part.changed.length,count,'unexpected raw '+category+' difference count');
  assert.deepEqual(part.missing,[]);
  assert.deepEqual(part.extra,[]);
 }
 const details=compareSchemaAttributes(sourceAttributes,targetAttributes);
 assert.equal(details.match,false,'expected attribute-level raw differences');
 let sawFunctions=false,sawRelations=false,sawColumns=false;
 for(const g of details.summary){
  if(g.category==='functions'){
   sawFunctions=true;
   assert.equal(g.field,'acl','unreviewed function definition/owner/security change');
   assert.equal(g.changed.length,579);
   assert.equal(g.missing.length,0); assert.equal(g.extra.length,0);
  } else if(g.category==='relations'){
   sawRelations=true;
   assert.equal(g.field,'acl','unreviewed relation RLS/owner/kind/options change');
   assert.equal(g.changed.length,216);
   assert.equal(g.missing.length,0); assert.equal(g.extra.length,0);
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
 assert.equal(sawFunctions&&sawRelations&&sawColumns,true,'incomplete raw difference coverage');
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
