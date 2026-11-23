import test from 'node:test';
import assert from 'node:assert/strict';
import {triageSourceIndex} from './source-triage.mjs';
const sha='a'.repeat(64);
const raw=()=>{
 const objects=Array.from({length:978},(_,i)=>({
  id:i===0?'public.secure()':i===1?'public.test_seq#S':i===2?'public.data#r':'public.mock_'+i+'#r',
  kind:i===0?'function':'relation',schema:'public',acl_sha256:sha,
  definition_sha256:i===0?sha:null,classification:'APP_OWNED_CANDIDATE',
  reviewed:false,security_definer:i===0,anon_execute:false,
  authenticated_execute:i===0
 }));
 const index={format:'PR359_CB_A_SOURCE_INDEX_V1',object_count:978,legacy_files:700,
  unresolved_review_count:978,app_owned_approved:false,canonical_baseline_approved:false,
  staging_inplace_go:false,destructive_allowlist:[],
  objects:objects.map((o,i)=>({id:o.id,kind:o.kind,approved:false,
   source_candidates:i===0?[{source_path:'supabase/migrations/0001_test.sql',
     source_blob_sha:'b'.repeat(40),offset:12,statement_kind:'FUNCTION',
     match_basis:'explicit_schema_name_only'}]:
    i===2?[{source_path:'supabase/migrations/0001_test.sql',
     source_blob_sha:'b'.repeat(40),offset:12,statement_kind:'TABLE'},
     {source_path:'supabase/migrations/0002_test.sql',source_blob_sha:'c'.repeat(40),
       offset:33,statement_kind:'TABLE'}]:[]
  }))};
 const reg={objects,decision:{app_owned_signed:false,destructive_allowlist:[]}};
 const live={objects:objects.map(o=>({id:o.id,kind:o.kind,
  acl_sha256:sha,definition_sha256:o.kind==='function'?sha:undefined,
  catalog_structure_sha256:o.kind==='relation'?sha:undefined,
  catalog_structure_not_full_ddl:o.kind==='relation',security_definer:o.security_definer}))};
 const deps={application_ownership_approved:false,entries:objects.map(o=>({
  identity:o.id,kind:o.kind,incoming_edges:0,outgoing_edges:1,
  incoming_sha256:sha,outgoing_sha256:sha}))};
 return [index,reg,live,deps];
};
test('complete 978-object triage preserves ambiguity, implicit sequence suspicion and P0',()=>{
 const t=triageSourceIndex(...raw());
 assert.equal(t.objects_total,978);
 assert.equal(t.sources_matched,2);
 assert.equal(t.sources_missing,976);
 assert.equal(t.sources_ambiguous,1);
 assert.equal(t.source_issue_counts.SEQUENCE_WITHOUT_STATIC_CREATE,1);
 assert.equal(t.source_issue_counts.MULTIPLE_HISTORICAL_CREATE_CANDIDATES,1);
 assert.equal(t.priority_counts.P0_PUBLIC_SECURITY_DEFINER,1);
 assert.equal(t.object_approvals,0);
 assert.equal(t.staging_inplace_go,false);
 assert.ok(t.objects.every(o=>!o.app_owned_approved&&!o.final_ddl_reviewed));
});
test('missing, duplicated and drifted evidence must fail closed',()=>{
 const scenarios=[
  a=>{a[0].objects.pop()},
  a=>{a[0].objects[1].id=a[0].objects[0].id},
  a=>{a[2].objects[1].acl_sha256='0'.repeat(64)},
  a=>{a[3].entries[0].identity='unknown()'},
  a=>{a[1].objects[0].reviewed=true},
  a=>{a[1].objects[0].definition_sha256='0'.repeat(64)},
  a=>{a[0].objects[0].source_candidates[0].source_path='drizzle/0000.sql'},
  a=>{a[0].staging_inplace_go=true},
  a=>{a[0].canonical_baseline_approved=true}
 ];
 for(const mutate of scenarios){const args=raw();mutate(args);
  assert.throws(()=>triageSourceIndex(...args));}
});
