import test from 'node:test';
import assert from 'node:assert/strict';
import {buildP0Review,loadSources,parsePinned,sources,attachHistoricalCandidates} from './cb-a-p0-review-queue.mjs';
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
