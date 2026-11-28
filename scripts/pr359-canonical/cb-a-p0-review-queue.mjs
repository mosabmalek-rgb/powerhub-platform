import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {auditOwnershipCandidates} from '../pr359-r4/audit-ownership-candidates.mjs';
import {verifyLiveOwnershipCatalog} from '../pr359-r4/verify-live-ownership-catalog.mjs';
import {assessRootDependencies} from '../pr359-r4/verify-root-dependency-digests.mjs';

const dir='docs/security/';
export const sources=Object.freeze({
 register:['pr359-r4-staging-object-register-20261120.json','568dbca50ed5509e4c6f41d08317228ab3ec0480'],
 functions:['pr359-r0-staging-functions-20261119.json','51c9434f836b761bf67ab3030c5ec709444a30c6'],
 relations:['pr359-r0-staging-relations-20261119.json','a3639fcd34d6259949daa2f9e1d72326d0ad96b4'],
 live:['pr359-r4-staging-live-ownership-fingerprints-20261123.json','b0b260cc0d5d5f80ece19d3ce0de80b3880612ba'],
 dependencies:['pr359-r4-staging-root-dependency-digests-20261123.json','f4bd79d64091ad3095cf618488530540635dd418']
});
export function parsePinned(raw,expected){
 const body=Buffer.from(raw);
 assert.equal(createHash('sha1').update('blob '+body.length+'\0').update(body).digest('hex'),expected,'source blob drift');
 return JSON.parse(body.toString('utf8'));
}
export function loadSources(){
 return Object.fromEntries(Object.entries(sources).map(([key,[file,sha]])=>[key,parsePinned(readFileSync(dir+file),sha)]));
}
export function buildP0Review(input,commit){
 assert.match(commit,/^[a-f0-9]{40}$/);
 const {register,functions,relations,live,dependencies}=input;
 const audit=auditOwnershipCandidates(register,relations,functions);
 verifyLiveOwnershipCatalog(live,register,functions,relations);
 assessRootDependencies(dependencies,register,functions,relations);
 const fns=new Map(functions.objects.map(x=>[x.signature,x]));
 const current=new Map(live.objects.map(x=>[x.id,x]));
 const deps=new Map(dependencies.entries.map(x=>[x.identity,x]));
 const records=audit.reviewQueue.filter(x=>x.priority==='P0_PUBLIC_SECURITY_DEFINER').map(x=>{
  const f=fns.get(x.identity),l=current.get(x.identity),d=deps.get(x.identity);
  assert.ok(f&&l&&d);
  assert.equal(f.schema,'public');assert.equal(f.security_definer,true);
  assert.ok(Array.isArray(f.configuration)||f.configuration===null,'unknown historical proconfig shape');
  const searchPath=(f.configuration??[]).filter(x=>typeof x==='string'&&x.startsWith('search_path='));
  assert.ok(searchPath.length<=1,'ambiguous historical search_path');
  return {identity:x.identity,schema:f.schema,owner:l.owner,security_definer:true,
   definition_sha256:l.definition_sha256,acl_sha256:l.acl_sha256,
   anon_execute:l.anon_execute,authenticated_execute:l.authenticated_execute,
   historical_service_execute:f.service_execute,historical_search_path:searchPath[0]??null,
   incoming_edges:d.incoming_edges,outgoing_edges:d.outgoing_edges,
   incoming_sha256:d.incoming_sha256,outgoing_sha256:d.outgoing_sha256,
   review_status:'PENDING',canonical_source:null,executable_sql_reviewed:false,
   effective_privileges_reviewed:false,runtime_callers_reviewed:false,
   tenant_isolation_reviewed:false,managed_dependencies_reviewed:false,
   reviewer_approval:null};
 });
 assert.equal(records.length,296);
 assert.equal(new Set(records.map(x=>x.identity)).size,296);
 return {format:'PR359_CB_A_P0_REVIEW_QUEUE_V1',report_checkout:commit,
  capture_dates:['2026-11-19','2026-11-23'],source_blobs:Object.fromEntries(Object.entries(sources).map(([k,[file,sha]])=>[k,{path:dir+file,blob_sha:sha}])),
  candidate_count:records.length,unresolved:records.length,signed_approvals:0,
  limitations:['Archived metadata only, not a fresh live capture','Historical search_path and service EXECUTE are review hints, not current effective privilege proof','Root pg_depend hashes exclude some managed subobjects and dynamic/runtime dependencies','No executable DDL or ownership authorization'],
  app_owned_approved:false,canonical_baseline_approved:false,destructive_allowlist:[],staging_inplace_go:false,production_inplace_go:false,pr359_merge_go:false,records};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 assert.equal(process.argv.length,4);assert.equal(process.argv[2],'--out');
 const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 const report=buildP0Review(loadSources(),commit);
 writeFileSync(process.argv[3],JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log('PR359_CB_A_P0_REVIEW_QUEUE',JSON.stringify({commit,candidates:report.candidate_count,signed_approvals:report.signed_approvals,app_owned_approved:false}));
}
