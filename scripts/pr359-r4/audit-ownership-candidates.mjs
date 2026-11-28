import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// Cross-check archived R0 source snapshots against the provisional R4 register.
// This is PROVENANCE ONLY, never ownership certification or a DROP allowlist.
const STAGING='iyuryuhaylhisjfcrwkz';
const HEX=/^[a-f0-9]{64}$/;
const PRIORITIES=['P0_PUBLIC_SECURITY_DEFINER','P1_PRIVILEGED_FUNCTION',
  'P2_RELATION_FULL_DDL_MISSING','P3_FUNCTION_REVIEW'];
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const verifySourceObject=o=>{
 assert.equal(o.owner,'postgres','owner drift');
 assert.equal(o.classification,'APP_OWNED_CANDIDATE','unapproved classification');
 assert.equal(o.classification_reviewed,false,'unapproved source review');
 assert.equal(o.extension_name,'','extension membership requires review');
 assert.match(o.acl_sha256,HEX,'missing ACL evidence');
};
function countBy(rows,field){
 const result={};
 for(const row of rows)result[row[field]]=(result[row[field]]||0)+1;
 return Object.fromEntries(Object.entries(result).sort(([a],[b])=>a.localeCompare(b)));
}
export function auditOwnershipCandidates(register,relations,functions){
 assert.equal(register.staging_project_ref,STAGING,'wrong register project');
 assert.equal(relations.project_ref,STAGING,'wrong relation source project');
 assert.equal(functions.project_ref,STAGING,'wrong function source project');
 assert.equal(register.format,'PR359 R4 provisional object review register v1');
 assert.equal(register.decision?.app_owned_signed,false,'unexpected ownership approval');
 assert.equal(register.decision?.staging_inplace_go,false,'unexpected Staging GO');
 assert.equal(register.decision?.migration_epoch_v2_proven,false,'unexpected epoch approval');
 assert.deepEqual(register.decision?.destructive_allowlist,[],'destructive allowlist must be empty');
 assert.equal(register.objects.length,978,'unexpected candidate count');
 assert.equal(relations.objects.length,337,'relation source count drift');
 assert.equal(functions.objects.length,641,'function source count drift');
 const source=new Map();
 for(const item of relations.objects){
  verifySourceObject(item);
  assert.ok(['r','p','v','m','S'].includes(item.kind),'unreviewed relation kind');
  const key=item.schema+'.'+item.name+'#'+item.kind;
  assert.ok(!source.has(key),'duplicate relation source: '+key);
  source.set(key,{kind:'relation',object:item});
 }
 for(const item of functions.objects){
  verifySourceObject(item);
  assert.match(item.definition_sha256,HEX,'function definition SHA missing');
  assert.equal(typeof item.security_definer,'boolean');
  assert.equal(typeof item.anon_execute,'boolean');
  assert.equal(typeof item.authenticated_execute,'boolean');
  const key=item.signature;
  assert.ok(!source.has(key),'duplicate function source: '+key);
  source.set(key,{kind:'function',object:item});
 }
 const seen=new Set(),queue=[];
 for(const entry of register.objects){
  assert.ok(['relation','function'].includes(entry.kind),'unreviewed register kind');
  assert.ok(typeof entry.id==='string'&&entry.id.length>1,'empty identity');
  assert.ok(!seen.has(entry.id),'duplicate register identity: '+entry.id);
  seen.add(entry.id);
  assert.equal(entry.owner,'postgres','unreviewed owner: '+entry.id);
  assert.equal(entry.extension,null,'extension-owned candidate: '+entry.id);
  assert.equal(entry.classification,'APP_OWNED_CANDIDATE','unapproved classification: '+entry.id);
  assert.equal(entry.reviewed,false,'review signature not accepted: '+entry.id);
  assert.match(entry.acl_sha256,HEX,'ACL SHA missing: '+entry.id);
  const baseline=source.get(entry.id);
  assert.ok(baseline,'object not present in R0 source: '+entry.id);
  assert.equal(baseline.kind,entry.kind,'object kind changed: '+entry.id);
  const item=baseline.object;
  assert.equal(entry.schema,item.schema,'schema identity drift: '+entry.id);
  assert.equal(entry.acl_sha256,item.acl_sha256,'ACL hash mismatch: '+entry.id);
  let priority;
  if(entry.kind==='function'){
   assert.equal(entry.definition_sha256,item.definition_sha256,'function DDL mismatch: '+entry.id);
   assert.equal(entry.security_definer,item.security_definer,'SECURITY DEFINER drift: '+entry.id);
   assert.equal(entry.anon_execute,item.anon_execute,'anon EXECUTE drift: '+entry.id);
   assert.equal(entry.authenticated_execute,item.authenticated_execute,'auth EXECUTE drift: '+entry.id);
   priority=item.security_definer&&item.schema==='public'?PRIORITIES[0]:
     item.security_definer||item.authenticated_execute?PRIORITIES[1]:PRIORITIES[3];
  }else{
   assert.equal(entry.definition_sha256,null,'unreviewed relation full DDL SHA: '+entry.id);
   priority=PRIORITIES[2];
  }
  queue.push({identity:entry.id,kind:entry.kind,priority,
   needs_live_ddl_sha:true,needs_dependency_review:true,reviewed:false});
 }
 assert.equal(seen.size,source.size,'missing candidate objects');
 for(const key of source.keys())assert.ok(seen.has(key),'missing source identity: '+key);
 queue.sort((a,b)=>PRIORITIES.indexOf(a.priority)-PRIORITIES.indexOf(b.priority)||
   a.identity.localeCompare(b.identity,'en'));
 const summary={
  scope:'PR359_R4_OWNERSHIP_CANDIDATE_PROVENANCE_V1',
  project_ref:STAGING,
  historical_source_only:true,
  candidate_count:queue.length,
  source_function_count:functions.objects.length,
  source_relation_count:relations.objects.length,
  priority_counts:countBy(queue,'priority'),
  unresolved_review_count:queue.length,
  missing_current_same_sha_ddl_attestation:queue.length,
  missing_relation_full_ddl_in_historical_register:337,
  source_register_identity_sha256:hash(queue.map(x=>[x.identity,x.kind,x.priority])),
  app_owned_approved:false,
  destructive_allowlist:[],
  staging_inplace_go:false,
  production_inplace_go:false,
  pr359_merge_go:false
 };
 return {summary,reviewQueue:queue};
}
const current=process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]);
if(current){
 assert.equal(process.argv.length,2,'Usage: node scripts/pr359-r4/audit-ownership-candidates.mjs');
 const load=p=>JSON.parse(readFileSync(p,'utf8'));
 const result=auditOwnershipCandidates(
  load('docs/security/pr359-r4-staging-object-register-20261120.json'),
  load('docs/security/pr359-r0-staging-relations-20261119.json'),
  load('docs/security/pr359-r0-staging-functions-20261119.json'));
 console.log(JSON.stringify(result.summary));
}
