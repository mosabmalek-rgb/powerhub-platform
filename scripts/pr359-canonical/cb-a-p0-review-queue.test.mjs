import test from 'node:test';
import assert from 'node:assert/strict';
import {buildP0Review,loadSources,parsePinned,sources,attachHistoricalCandidates,attachForensicGaps,attachGapCallerEvidence,summarizePrivilegeReview,attachReadOnlyRecapture,recaptureSource,attachChatGuardScreening,chatGuardSource,assessManagedEdgeDetail,managedEdgeDetailSource} from './cb-a-p0-review-queue.mjs';
import {readFileSync} from 'node:fs';
const head='a'.repeat(40);
test('joins all 296 P0 candidates without promoting ownership',()=>{
 const r=buildP0Review(loadSources(),head);
 assert.equal(r.records.length,296);
 assert.equal(r.signed_approvals,0);
 assert.equal(r.app_owned_approved,false);
 assert.deepEqual(r.destructive_allowlist,[]);
 assert.ok(r.records.every(x=>x.schema==='public'&&x.security_definer&&x.review_status==='PENDING'&&x.reviewer_approval===null&&x.canonical_source===null));
 assert.deepEqual(r,buildP0Review(loadSources(),head));
});
test('rejects altered pinned bytes and inconsistent evidence',()=>{
 const [name,sha]=sources.live;
 const raw=readFileSync('docs/security/'+name);
 assert.throws(()=>parsePinned(Buffer.concat([raw,Buffer.from(' ')]),sha),/source blob drift/);
 const x=loadSources();x.register.objects[0].reviewed=true;
 assert.throws(()=>buildP0Review(x,head));
 const y=loadSources();y.live.objects[0].definition_sha256='f'.repeat(64);
 assert.throws(()=>buildP0Review(y,head));
});

test('joins exact identities but never promotes a lexical historical candidate',()=>{
 const input=loadSources();const report=buildP0Review(input,head);
 const first=report.records[0].identity;
 const candidate={source_path:'supabase/migrations/1_test.sql',source_blob_sha:'a'.repeat(40),statement_kind:'FUNCTION',offset:0,match_basis:'explicit_schema_name_only'};
 const index={object_count:978,legacy_files:700,canonical_baseline_approved:false,objects:input.register.objects.map(x=>({id:x.id,kind:x.kind,approved:false,exact_signature_verified:false,current_executable_definition_verified:false,source_status:x.id===first?'LEXICAL_CANDIDATE_ONLY':'NO_STATIC_CREATE_EVIDENCE',source_candidates:x.id===first?[candidate]:[]}))};
 const joined=attachHistoricalCandidates(report,index);
 assert.equal(joined.with_lexical_source_candidates,1);assert.equal(joined.without_lexical_source_candidates,295);
 assert.equal(joined.records[0].canonical_source,null);assert.equal(joined.records[0].reviewer_approval,null);
 assert.deepEqual(joined.records[0].historical_source_candidates,[candidate]);
 index.objects.find(x=>x.id===first).approved=true;
 assert.throws(()=>attachHistoricalCandidates(report,index));
});

test('forensic evidence binds definition hash without approving execution',()=>{
 const report=buildP0Review(loadSources(),head);
 const row=report.records[0];
 const input={...report,records:[{...row,historical_source_candidates:[]}]};
 const bundle={canonical_baseline_approved:false,executable_sql_approved:false,evidence:{function_source_blob_sha1:'a'.repeat(40)},records:[{kind:'function',identity:row.identity,exact_catalog_definition_sha256:row.definition_sha256,security_definer:true,ddl_selected_for_execution:false,app_owned_approved:false,blockers:['REVIEW_PENDING']}]};
 const joined=attachForensicGaps(input,bundle);
 assert.equal(joined.with_forensic_gap_evidence,1);
 assert.deepEqual(joined.missing_historical_identities,[row.identity]);
 assert.equal(joined.records[0].canonical_source,null);
 assert.equal(joined.records[0].forensic_gap_evidence.ddl_selected_for_execution,false);
 bundle.records[0].exact_catalog_definition_sha256='f'.repeat(64);
 assert.throws(()=>attachForensicGaps(input,bundle),/forensic DDL drift/);
});

test('attaches exactly two historical trigger bindings and one mobile source hint without runtime approval',()=>{
 const ids=['a()','b()','c()'];
 const report={app_owned_approved:false,missing_historical_identities:ids,records:ids.map(identity=>({identity,forensic_gap_evidence:{definition_sha256:'a'.repeat(64)}}))};
 const attachments={full_runtime_call_graph_verified:false,trigger_runtime_firing_verified:false,security_definer_signoff_complete:false,source_ownership_approved:false,exact_security_definers:3,attached_direct_triggers:2,direct_trigger_bindings:ids.slice(0,2).map(function_identity=>({function_identity,relation:'fixture'})),mobile_session_function_identity:ids[2],mobile_api_scoped_direct_update_in_pinned_code:true,mobile_api_direct_touch_rpc_literal_in_pinned_code:false};
 const result=attachGapCallerEvidence(report,attachments);
 assert.equal(result.gap_caller_evidence_count,3);assert.equal(result.gap_runtime_caller_closure_approved,false);
 assert.equal(result.records[2].forensic_caller_evidence.pinned_mobile_api_source.scoped_direct_update,true);
 assert.equal(result.records[0].forensic_caller_evidence.direct_trigger_binding.function_identity,'a()');
 assert.throws(()=>attachGapCallerEvidence(report,{...attachments,mobile_session_function_identity:'other()'}),/identity mismatch/);
 assert.throws(()=>attachGapCallerEvidence(report,{...attachments,full_runtime_call_graph_verified:true}));
});

test('privilege review buckets partition 296 pending records without granting signoff',()=>{
 const report=buildP0Review(loadSources(),head);
 const result=summarizePrivilegeReview(report);
 const s=result.privilege_review_summary;
 assert.equal(s.counts.anon_execute+s.counts.authenticated_only+s.counts.neither_client_role,296);
 assert.equal(new Set([...s.identities.anon_execute,...s.identities.authenticated_only,...s.identities.neither_client_role]).size,296);
 assert.equal(s.security_review_approved,false);
 assert.equal(result.signed_approvals,0);
 const broken=structuredClone(report);broken.records[0].review_status='APPROVED';
 assert.throws(()=>summarizePrivilegeReview(broken));
});

test('all 296 read-only recapture records match archived exact definitions and client EXECUTE flags without approval',()=>{
 const capture=parsePinned(readFileSync('docs/security/'+recaptureSource[0]),recaptureSource[1]);
 const report=buildP0Review(loadSources(),head);
 const result=attachReadOnlyRecapture(report,capture);
 assert.equal(result.read_only_recapture_summary.matched,296);
 assert.equal(result.read_only_recapture_summary.runtime_authorization_verified,false);
 assert.equal(result.records.filter(x=>x.read_only_recapture.authenticated_execute).length,34);
 assert.ok(result.records.every(x=>!x.effective_privileges_reviewed&&x.reviewer_approval===null));
 for(const field of ['definition_sha256','anon_exec','authenticated_exec']){
  const drift=structuredClone(capture);drift.rows[0][field]=field==='definition_sha256'?'f'.repeat(64):!drift.rows[0][field];
  assert.throws(()=>attachReadOnlyRecapture(report,drift),/drift/);
 }
 const duplicate=structuredClone(capture);duplicate.rows[1]=duplicate.rows[0];
 assert.throws(()=>attachReadOnlyRecapture(report,duplicate));
});

test('pins and joins 15 public and 14 private chat guard screenings without approving P0',()=>{
 const report=attachReadOnlyRecapture(buildP0Review(loadSources(),head),parsePinned(readFileSync('docs/security/'+recaptureSource[0]),recaptureSource[1]));
 const raw=readFileSync('docs/security/'+chatGuardSource[0]);
 const evidence=parsePinned(raw,chatGuardSource[1]);
 const result=attachChatGuardScreening(report,evidence);
 assert.equal(result.chat_guard_screening_summary.public_matched,15);
 assert.equal(result.chat_guard_screening_summary.private_matched,14);
 assert.equal(result.records.filter(x=>x.chat_guard_screening).length,15);
 assert.ok(result.records.every(x=>x.review_status==='PENDING'&&x.reviewer_approval===null&&!x.effective_privileges_reviewed));
 assert.equal(result.signed_approvals,0);
 assert.throws(()=>parsePinned(Buffer.concat([raw,Buffer.from(' ')]),chatGuardSource[1]),/source blob drift/);
 const publicRow=evidence.functions.findIndex(x=>x.schema_name==='public');
 const privateRow=evidence.functions.findIndex(x=>x.schema_name==='private');
 for(const change of [
  x=>{x.functions[publicRow].definition_sha256='f'.repeat(64)},
  x=>{x.functions[privateRow].authenticated_execute=true},
  x=>{x.functions[publicRow].args='p_fake integer'},
  x=>{x.functions[publicRow].proconfig=['search_path=public']},
  x=>{x.functions[privateRow]=x.functions[privateRow+1]}
 ]){
  const altered=structuredClone(evidence);change(altered);
  assert.throws(()=>attachChatGuardScreening(report,altered));
 }
});

test('pins the 48 detailed managed reverse edges without approving dependency closure',()=>{
 const raw=readFileSync('docs/security/'+managedEdgeDetailSource[0]);
 const e=parsePinned(raw,managedEdgeDetailSource[1]);
 const report=assessManagedEdgeDetail(e);
 assert.equal(report.edge_count,48);assert.equal(report.target_count,9);assert.equal(report.full_dependency_closure_approved,false);
 assert.throws(()=>parsePinned(Buffer.concat([raw,Buffer.from(' ')]),managedEdgeDetailSource[1]));
 for(const change of [x=>{x.edges.pop()},x=>{x.edges[0].source_schema='public'},x=>{x.ownership_approved=true},x=>{x.identity_sha256='f'.repeat(64)}]){const altered=structuredClone(e);change(altered);assert.throws(()=>assessManagedEdgeDetail(altered));}
});
