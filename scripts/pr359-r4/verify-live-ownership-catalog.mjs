import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

// R4 historical-vs-current snapshot provenance; not a release, deletion,
// ownership-classification or full executable relation-DDL certificate.
const HEX=/^[a-f0-9]{64}$/;
const PROJECT='iyuryuhaylhisjfcrwkz';
const HIST='docs/security/';
const keyRel=o=>o.schema+'.'+o.name+'#'+o.kind;
export function verifyLiveOwnershipCatalog(live,registry,histFunctions,histRelations){
 assert.equal(live.format,'PR359_R4_STAGING_LIVE_OWNERSHIP_FINGERPRINTS_V1');
 assert.equal(live.project_ref,PROJECT);
 assert.equal(live.capture_mode,'single-transaction-repeatable-read-read-only');
 assert.equal(live.source_ref_review_head,'3a296b6a49343fc64d909ea4b372959de8e86141');
 assert.equal(live.relation_hash_scope,'catalog-structure-only-not-complete-executable-DDL');
 assert.equal(live.object_count,978);assert.equal(live.unique_identity_count,978);
 assert.equal(live.function_count,641);assert.equal(live.relation_count,337);
 assert.ok(typeof live.captured_at==='string'&&live.captured_at.length>10);
 assert.equal(registry.staging_project_ref,PROJECT);
 assert.equal(registry.objects.length,978);
 assert.equal(registry.decision.app_owned_signed,false);
 assert.deepEqual(registry.decision.destructive_allowlist,[]);
 assert.equal(registry.decision.staging_inplace_go,false);
 const histF=new Map(histFunctions.objects.map(o=>[o.signature,o]));
 const histR=new Map(histRelations.objects.map(o=>[keyRel(o),o]));
 const register=new Map(registry.objects.map(o=>[o.id,o]));
 assert.equal(histF.size,641);assert.equal(histR.size,337);assert.equal(register.size,978);
 assert.ok(Array.isArray(live.objects)&&live.objects.length===978);
 let functions=0,relations=0;
 const seen=new Set();
 for(const obj of live.objects){
  assert.ok(typeof obj.id==='string'&&obj.id.length>2);
  assert.ok(!seen.has(obj.id),'duplicate current object: '+obj.id);seen.add(obj.id);
  const registered=register.get(obj.id);
  assert.ok(registered,'unregistered current object: '+obj.id);
  assert.equal(obj.kind,registered.kind,'kind drift: '+obj.id);
  assert.equal(obj.schema,registered.schema,'schema drift: '+obj.id);
  assert.equal(obj.owner,'postgres','unreviewed owner: '+obj.id);
  assert.equal(obj.extension_name,'','extension membership drift: '+obj.id);
  assert.equal(obj.acl_sha256,registered.acl_sha256,'ACL drift: '+obj.id);
  assert.match(obj.acl_sha256,HEX);
  assert.equal(registered.reviewed,false,'unauthorized reviewed candidate');
  assert.equal(registered.classification,'APP_OWNED_CANDIDATE','unauthorized ownership');
  if(obj.kind==='function'){
   functions++;
   const historical=histF.get(obj.id);
   assert.ok(historical,'historical function missing: '+obj.id);
   assert.equal(obj.definition_sha256,historical.definition_sha256,'definition SHA drift: '+obj.id);
   assert.equal(obj.definition_sha256,registered.definition_sha256,'register definition drift');
   assert.match(obj.definition_sha256,HEX);
   for(const f of ['security_definer','anon_execute','authenticated_execute'])
    assert.equal(obj[f],historical[f],'function privilege drift: '+obj.id+' '+f);
  }else{
   relations++;
   const historical=histR.get(obj.id);
   assert.ok(historical,'historical relation missing: '+obj.id);
   for(const [field,old] of Object.entries({relkind:'kind',rls:'rls',force_rls:'force_rls'}))
    assert.equal(obj[field],historical[old],'relation structural drift: '+obj.id+' '+field);
   assert.equal(obj.catalog_structure_not_full_ddl,true,'full DDL wrongly claimed');
   assert.match(obj.catalog_structure_sha256,HEX,'missing catalog digest');
   assert.equal(registered.definition_sha256,null,'fabricated full relation DDL SHA');
  }
 }
 assert.equal(functions,641);assert.equal(relations,337);
 for(const id of register.keys())assert.ok(seen.has(id),'missing live candidate: '+id);
 return {
  format:'PR359_R4_LIVE_OWNERSHIP_AUDIT_RESULT_V1',
  reviewed_head:live.source_ref_review_head,
  object_count:978,functions:641,relations:337,
  function_definition_acl_parity:true,
  relation_historical_acl_kind_rls_parity:true,
  relation_catalog_structure_sha256_captured:337,
  full_relation_executable_ddl_verified:false,
  current_dependency_graph_reviewed:false,
  object_by_object_ownership_approved:false,
  unresolved_ownership_count:978,
  destructive_allowlist:[],
  app_owned_approved:false,staging_inplace_go:false,
  production_inplace_go:false,merge_go:false
 };
}
const isCli=process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href;
if(isCli){
 assert.equal(process.argv.length,2,'This audit takes only versioned repository metadata');
 const read=p=>JSON.parse(readFileSync(p,'utf8'));
 const x=verifyLiveOwnershipCatalog(
  read(HIST+'pr359-r4-staging-live-ownership-fingerprints-20261123.json'),
  read(HIST+'pr359-r4-staging-object-register-20261120.json'),
  read(HIST+'pr359-r0-staging-functions-20261119.json'),
  read(HIST+'pr359-r0-staging-relations-20261119.json'));
 console.log(JSON.stringify(x));
}
