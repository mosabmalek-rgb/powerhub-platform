import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {auditOwnershipCandidates} from '../pr359-r4/audit-ownership-candidates.mjs';
import {verifyLiveOwnershipCatalog} from '../pr359-r4/verify-live-ownership-catalog.mjs';
import {assessRootDependencies} from '../pr359-r4/verify-root-dependency-digests.mjs';
import {buildIndex} from './source-index.mjs';
import {buildCbBGapReviewBundle,loadCbBGapReviewInputs} from './cb-b-gap-review-bundle.mjs';
import {auditDefinerAttachments,loadDefinerAttachmentEvidence} from './cb-a-definer-attachments.mjs';
import {validateMigrationProvenance} from '../pr359-r4/verify-legacy-migration-provenance.mjs';

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
export function attachHistoricalCandidates(report,index){
 assert.equal(report.app_owned_approved,false);
 assert.equal(index.canonical_baseline_approved,false);
 assert.equal(index.object_count,978);
 assert.equal(index.objects.length,978);
 const byId=new Map(index.objects.map(x=>[x.id,x]));
 assert.equal(byId.size,978);
 const records=report.records.map(row=>{
  const x=byId.get(row.identity);
  assert.ok(x&&x.kind==='function','missing source index identity: '+row.identity);
  assert.equal(x.approved,false);
  assert.equal(x.exact_signature_verified,false);
  assert.equal(x.current_executable_definition_verified,false);
  return {...row,historical_source_status:x.source_status,historical_source_candidates:x.source_candidates};
 });
 assert.equal(records.length,296);
 return {...report,records,historical_source_index_files:index.legacy_files,
  with_lexical_source_candidates:records.filter(x=>x.historical_source_candidates.length>0).length,
  without_lexical_source_candidates:records.filter(x=>x.historical_source_candidates.length===0).length,
  historical_source_candidates_only:true};
}
export function attachForensicGaps(report,bundle){
 assert.equal(report.app_owned_approved,false);
 assert.equal(bundle.canonical_baseline_approved,false);
 assert.equal(bundle.executable_sql_approved,false);
 const byId=new Map(bundle.records.filter(x=>x.kind==='function').map(x=>[x.identity,x]));
 const records=report.records.map(row=>{
  if(row.historical_source_candidates.length) return row;
  const evidence=byId.get(row.identity);
  if(!evidence) return {...row,forensic_gap_evidence:null};
  assert.equal(evidence.exact_catalog_definition_sha256,row.definition_sha256,'forensic DDL drift: '+row.identity);
  assert.equal(evidence.security_definer,true);
  assert.equal(evidence.ddl_selected_for_execution,false);
  assert.equal(evidence.app_owned_approved,false);
  return {...row,forensic_gap_evidence:{source_blob_sha:bundle.evidence.function_source_blob_sha1,
   definition_sha256:evidence.exact_catalog_definition_sha256,identity_arguments:evidence.identity_arguments,
   blockers:evidence.blockers,ddl_selected_for_execution:false}};
 });
 const gaps=records.filter(row=>!row.historical_source_candidates.length);
 return {...report,records,missing_historical_identities:gaps.map(x=>x.identity),
  with_forensic_gap_evidence:gaps.filter(x=>x.forensic_gap_evidence).length,
  without_forensic_gap_evidence:gaps.filter(x=>!x.forensic_gap_evidence).length};
}
export function attachGapCallerEvidence(report,attachments){
 assert.equal(report.app_owned_approved,false);
 assert.equal(attachments.full_runtime_call_graph_verified,false);
 assert.equal(attachments.trigger_runtime_firing_verified,false);
 assert.equal(attachments.security_definer_signoff_complete,false);
 assert.equal(attachments.source_ownership_approved,false);
 assert.equal(attachments.exact_security_definers,3);
 assert.equal(attachments.attached_direct_triggers,2);
 const byId=new Map(attachments.direct_trigger_bindings.map(x=>[x.function_identity,x]));
 assert.equal(byId.size,2);
 assert.ok(!byId.has(attachments.mobile_session_function_identity));
 const ids=new Set([...byId.keys(),attachments.mobile_session_function_identity]);
 assert.equal(ids.size,3);
 assert.deepEqual([...ids].sort(),[...report.missing_historical_identities].sort(),'gap attachment identity mismatch');
 assert.equal(attachments.mobile_api_scoped_direct_update_in_pinned_code,true);
 assert.equal(attachments.mobile_api_direct_touch_rpc_literal_in_pinned_code,false);
 const records=report.records.map(row=>{
  if(!ids.has(row.identity)) return row;
  assert.ok(row.forensic_gap_evidence,'missing forensic definition');
  const binding=byId.get(row.identity);
  return {...row,forensic_caller_evidence:{
   evidence_git_blob_sha:attachments.evidence_git_blob_sha,
   direct_trigger_binding:binding??null,
   pinned_mobile_api_source:binding?null:{
    blob_sha:attachments.inspected_mobile_api_git_blob_sha,
    scoped_direct_update:true,direct_touch_rpc_literal:false},
   full_runtime_call_graph_verified:false,trigger_runtime_firing_verified:false
  }};
 });
 return {...report,records,gap_caller_evidence_count:records.filter(x=>x.forensic_caller_evidence).length,
  gap_runtime_caller_closure_approved:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 assert.equal(process.argv.length,4);assert.equal(process.argv[2],'--out');
 const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 const input=loadSources();
 const manifest=JSON.parse(readFileSync(dir+'pr359-r4-legacy-migration-provenance-20261123.json','utf8'));
 validateMigrationProvenance(manifest);
 const index=buildIndex(input.register,manifest.files.map(f=>({path:f.path,sha:f.sha,bytes:readFileSync(f.path)})));
 const gapInputs=loadCbBGapReviewInputs();
 const report=attachGapCallerEvidence(
  attachForensicGaps(attachHistoricalCandidates(buildP0Review(input,commit),index),buildCbBGapReviewBundle(...gapInputs)),
  auditDefinerAttachments(loadDefinerAttachmentEvidence(),gapInputs,readFileSync('server/mobile-api.ts','utf8')));
 writeFileSync(process.argv[3],JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log('PR359_CB_A_P0_REVIEW_QUEUE',JSON.stringify({commit,candidates:report.candidate_count,signed_approvals:report.signed_approvals,with_lexical_source_candidates:report.with_lexical_source_candidates,without_lexical_source_candidates:report.without_lexical_source_candidates,missing_historical_identities:report.missing_historical_identities,with_forensic_gap_evidence:report.with_forensic_gap_evidence,without_forensic_gap_evidence:report.without_forensic_gap_evidence,gap_caller_evidence_count:report.gap_caller_evidence_count,app_owned_approved:false}));
}
