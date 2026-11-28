import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// Exact source object dependencies, not a certificate that pg_depend is
// complete for procedural SQL, runtime code, provider policy subobjects, etc.
export const EXPECTED_SNAPSHOT_GIT_BLOB='f4bd79d64091ad3095cf618488530540635dd418';
const SHA=/^[0-9a-f]{64}$/;
const PROJECT='iyuryuhaylhisjfcrwkz';
const HIST='docs/security/';
export function checkPinnedSnapshot(raw){
 const body=Buffer.from(raw,'utf8');
 const actual=createHash('sha1').update('blob '+body.length+'\0').update(body).digest('hex');
 assert.equal(actual,EXPECTED_SNAPSHOT_GIT_BLOB,'unreviewed source snapshot change');
 return JSON.parse(raw);
}
export function assessRootDependencies(snap,reg,fn,rel){
 assert.equal(snap.format,'PR359_R4_STAGING_ROOT_DEPENDENCY_DIGESTS_V1');
 assert.equal(snap.project_ref,PROJECT);
 assert.equal(snap.capture_mode,'repeatable-read-read-only');
 assert.equal(snap.source_review_head,'a8bdad79884a25ab74dfa810f9f14b0fd5e6b85c');
 assert.equal(snap.application_ownership_approved,false);
 assert.deepEqual(snap.destructive_allowlist,[]);
 assert.equal(snap.root_count,978);assert.equal(snap.unique_root_count,978);
 assert.equal(snap.function_count,641);assert.equal(snap.relation_count,337);
 assert.equal(snap.incoming_edge_count,6746);assert.equal(snap.outgoing_edge_count,1688);
 assert.equal(snap.managed_incoming_count,0);
 assert.equal(snap.managed_outgoing_count,0);
 assert.equal(snap.unidentified_incoming_count,0);
 assert.equal(snap.unidentified_outgoing_count,0);
 assert.ok(Array.isArray(snap.entries)&&snap.entries.length===978);
 assert.equal(reg.staging_project_ref,PROJECT);
 assert.equal(reg.decision?.app_owned_signed,false);
 assert.equal(reg.decision?.staging_inplace_go,false);
 assert.deepEqual(reg.decision?.destructive_allowlist,[]);
 const ids=new Set();
 for(const x of reg.objects){
  assert.equal(x.classification,'APP_OWNED_CANDIDATE');
  assert.equal(x.reviewed,false);
  assert.ok(!ids.has(x.id));ids.add(x.id);
 }
 assert.equal(ids.size,978);
 const sourceIds=new Set([
  ...fn.objects.map(x=>x.signature),
  ...rel.objects.map(x=>x.schema+'.'+x.name+'#'+x.kind)
 ]);
 assert.equal(sourceIds.size,978);
 let inTotal=0,outTotal=0,funcCount=0,relCount=0;
 const subTotals={managed_incoming:0,managed_outgoing:0,unidentified_incoming:0,unidentified_outgoing:0};
 const seen=new Set();
 for(const x of snap.entries){
  assert.ok(ids.has(x.identity),'unknown live root: '+x.identity);
  assert.ok(sourceIds.has(x.identity),'unknown archived source identity');
  assert.ok(!seen.has(x.identity),'duplicate root: '+x.identity);seen.add(x.identity);
  const registered=reg.objects.find(y=>y.id===x.identity);
  assert.equal(x.kind,registered.kind,'type changed: '+x.identity);
  assert.match(x.incoming_sha256,SHA);assert.match(x.outgoing_sha256,SHA);
  for(const k of ['incoming_edges','outgoing_edges','managed_incoming','managed_outgoing','unidentified_incoming','unidentified_outgoing']){
   assert.ok(Number.isSafeInteger(x[k])&&x[k]>=0,'bad count: '+x.identity+' '+k);
  }
  assert.ok(x.managed_incoming<=x.incoming_edges);
  assert.ok(x.managed_outgoing<=x.outgoing_edges);
  assert.ok(x.unidentified_incoming<=x.incoming_edges);
  assert.ok(x.unidentified_outgoing<=x.outgoing_edges);
  for(const k of Object.keys(subTotals)) subTotals[k]+=x[k];
  inTotal+=x.incoming_edges;outTotal+=x.outgoing_edges;
  if(x.kind==='function')funcCount++;else relCount++;
 }
 assert.equal(funcCount,641);assert.equal(relCount,337);
 assert.equal(inTotal,snap.incoming_edge_count);assert.equal(outTotal,snap.outgoing_edge_count);
 for(const [key,total] of Object.entries(subTotals)) assert.equal(total,snap[key+'_count'],'dependency subtotal mismatch: '+key);
 for(const id of ids)assert.ok(seen.has(id),'missing root '+id);
 return {
  scope:'PR359_R4_ROOT_DEPENDENCIES_VERIFIED_V1',
  objects:978,functions:641,relations:337,
  incoming:inTotal,outgoing:outTotal,
  separate_managed_policy_subobject_edges_expected:48,
  catalog_only:true,
  dynamic_sql_and_application_callers_audited:false,
  complete_provider_subobject_graph_approved:false,
  full_executable_canonical_baseline_ready:false,
  ownership_signed:false,
  app_owned_approved:false,
  staging_inplace_go:false,
  production_inplace_go:false,
  pr_merge_go:false
 };
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 assert.equal(process.argv.length,2);
 const read=p=>readFileSync(p,'utf8');
 const data=checkPinnedSnapshot(read(HIST+'pr359-r4-staging-root-dependency-digests-20261123.json'));
 console.log(JSON.stringify(assessRootDependencies(data,
  JSON.parse(read(HIST+'pr359-r4-staging-object-register-20261120.json')),
  JSON.parse(read(HIST+'pr359-r0-staging-functions-20261119.json')),
  JSON.parse(read(HIST+'pr359-r0-staging-relations-20261119.json')))));
}
