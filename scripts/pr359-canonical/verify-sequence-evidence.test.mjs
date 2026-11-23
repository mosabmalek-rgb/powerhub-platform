import test from 'node:test';
import assert from 'node:assert/strict';
import {verifySequenceEvidence,checkPinnedBytes} from './verify-sequence-evidence.mjs';
function fixtures(){
 const relations=Array.from({length:147},(_,i)=>({
  schema:'public',name:'tbl_'+i,kind:'r',columns:[{name:'id',identity:'d'}]
 }));
 const other=Array.from({length:190},(_,i)=>({schema:'public',name:'other_'+i,kind:'r',columns:[]}));
 const seq=Array.from({length:147},(_,i)=>({id:'public.tbl_'+i+'_id_seq#S',
  kind:'relation',approved:false,source_candidates:[]}));
 const manual=Array.from({length:7},(_,i)=>({id:'public.manual_'+i+'_seq#S',
  kind:'relation',approved:false,source_candidates:[{statement_kind:'SEQUENCE'}]}));
 const rest=Array.from({length:813},(_,i)=>({id:'public.unknown_'+i+'#r',
  kind:'relation',approved:false,source_candidates:i<11?[]:[{statement_kind:'TABLE'}]}));
 // 147 + 7 + 813 = 967; preserve 978 roots by adding 11 covered objects.
 const covered=Array.from({length:11},(_,i)=>({id:'public.otherfn_'+i+'()',kind:'function',
  approved:false,source_candidates:[{statement_kind:'FUNCTION'}]}));
 const index={format:'PR359_CB_A_SOURCE_INDEX_V1',object_count:978,legacy_files:700,
  objects:[...seq,...manual,...rest,...covered],canonical_baseline_approved:false,
  staging_inplace_go:false,destructive_allowlist:[]};
 // Constrain 158 total missing sources: 147 identities + 11 remaining gaps.
 for(let i=11;i<rest.length;i++)rest[i].source_candidates=[{statement_kind:'TABLE'}];
 const rows=[
  ...Array.from({length:147},(_,i)=>({
   sequence_schema:'public',sequence_name:'tbl_'+i+'_id_seq',
   ownership_dependency_type:'i',
   owning_table_schema:'public',owning_table_name:'tbl_'+i,owning_column_name:'id',
   owning_column_identity_kind:'d',pg_get_serial_sequence_result:'public.tbl_'+i+'_id_seq'
  })),
  ...Array.from({length:7},(_,i)=>({
   sequence_schema:'public',sequence_name:'manual_'+i+'_seq',
   ownership_dependency_type:null,
   owning_table_schema:null,owning_table_name:null,owning_column_name:null,
   owning_column_identity_kind:null,pg_get_serial_sequence_result:null
  }))
 ];
 const evidence={format:'PR359_CB_A_STAGING_SEQUENCE_OWNERSHIP_CATALOG_V1',
  project_ref:'iyuryuhaylhisjfcrwkz',
  source_pr_head:'9d2d1a135dadfea24bb1c8827b903f9b6814a1f0',
  capture_mode:'read-only pg_catalog SELECT; no hosted mutation',
  expected_sequences:154,identity_owned_count:147,non_owned_count:7,
  approved_app_owned:false,staging_inplace_go:false,production_inplace_go:false,rows};
 return [index,evidence,{objects:[...relations,...other]}];
}
test('147 identity ownerships, seven explicit SQL sequences, no false baseline GO',()=>{
 const r=verifySequenceEvidence(...fixtures());
 assert.equal(r.implicit_identity_sequences_with_catalog_and_R0_owner_evidence,147);
 assert.equal(r.explicit_historical_create_sequences_without_owned_column,7);
 assert.equal(r.non_sequence_missing_static_create,11);
 assert.equal(r.remaining_unresolved_object_count,978);
 assert.equal(r.staging_inplace_go,false);
});
test('fail closed for orphan, missing sequence, mismatched R0, spoofed GO and extra static origin',()=>{
 const changes=[
  a=>{a[1].rows[0].ownership_dependency_type=null},
  a=>{a[1].rows[0].owning_table_name='incorrect'},
  a=>{a[1].rows[0].pg_get_serial_sequence_result='public.other'},
  a=>{a[2].objects[0].columns[0].identity=''},
  a=>{a[1].rows.pop()},
  a=>{a[0].objects[0].approved=true},
  a=>{a[1].staging_inplace_go=true},
  a=>{a[0].objects[0].source_candidates=[{statement_kind:'SEQUENCE'}]},
  a=>{a[1].rows[0].sequence_name='unknown'}
 ];
 for(const change of changes){const f=fixtures();change(f);assert.throws(()=>verifySequenceEvidence(...f));}
});
test('pin immutable Git blob bytes',()=>{
 assert.throws(()=>checkPinnedBytes('unreviewed evidence','f'.repeat(40)),
  /unreviewed catalog evidence/);
});
