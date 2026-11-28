import test from 'node:test';
import assert from 'node:assert/strict';
import {codePath,targetsFromEvidence,makeReferenceIndex} from './code-reference-index.mjs';
const fixture=()=>{
 const f={format:'PR359_CB_A_6_MISSING_FUNCTIONS_LIVE_EVIDENCE_V1',
  source_project_ref:'iyuryuhaylhisjfcrwkz',canonical_baseline_approved:false,staging_inplace_go:false,
  functions:Array.from({length:6},(_,i)=>({name:'my_fn_'+i,security_definer:i===0}))};
 const t={format:'PR359_CB_A_5_MISSING_TABLES_LIVE_EVIDENCE_V1',
  source_project_ref:'iyuryuhaylhisjfcrwkz',canonical_baseline_approved:false,staging_inplace_go:false,
  tables:Array.from({length:5},(_,i)=>({table_name:'my_table_'+i}))};
 return targetsFromEvidence(f,t);
};
test('limits scope to checked-in platform JS/TS, not migrations or Android',()=>{
 for(const p of ['drizzle/a.sql','supabase/migrations/1.sql','docs/report.ts',
   'server/a.d.ts','server/../secrets.ts','app-power-/Main.kt'])
  assert.equal(codePath(p),false,p);
 for(const p of ['server/a.ts','client/src/App.tsx','api/[...path].js','shared/defs.mjs'])
  assert.equal(codePath(p),true,p);
});
test('records pinned paths and line without promoting a lexical hit to a caller',()=>{
 const names=fixture();
 const x=makeReferenceIndex([
  {path:'server/billing.ts',bytes:Buffer.from('admin.from("my_table_0");\nadmin.rpc("my_fn_0");\nconst note="my_fn_1";\n')},
  {path:'server/billing.test.ts',bytes:Buffer.from('expect("my_table_0");')},
  {path:'client/src/App.tsx',bytes:Buffer.from('const y="my_table_3";')}
 ],names);
 assert.equal(x.code_files_scanned,3);
 assert.equal(x.names_with_application_candidate_files,4);
 assert.ok(x.matches.some(m=>m.lexical_context==='supabase_rpc_literal'));
 assert.ok(x.matches.some(m=>m.lexical_context==='supabase_from_literal'));
 assert.ok(x.matches.every(m=>!m.verified_runtime_invocation&&!Object.hasOwn(m,'snippet')));
 assert.equal(x.targets.find(t=>t.name==='my_table_0').test_or_fixture_files,1);
 assert.equal(x.android_external_repository_audited,false);
 assert.equal(x.canonical_baseline_approved,false);
 assert.deepEqual(x.destructive_allowlist,[]);
});
test('rejects missing coverage, out-of-scope files and duplicate paths',()=>{
 const names=fixture(),item={path:'server/a.ts',bytes:Buffer.from('my_fn_0')};
 assert.throws(()=>makeReferenceIndex([item,item],names),/duplicate code file/);
 assert.throws(()=>makeReferenceIndex([{...item,path:'supabase/migrations/a.sql'}],names),/unexpected code source/);
 assert.throws(()=>makeReferenceIndex([item],names.slice(1)),/root coverage drift/);
});
