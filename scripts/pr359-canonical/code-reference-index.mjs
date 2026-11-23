import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {pinnedJson} from './audit-eleven-live-gaps.mjs';

// Code name mentions are candidate evidence, never verified runtime callers.
const F='docs/security/pr359-cb-a-six-function-live-evidence-20261123.json';
const T='docs/security/pr359-cb-a-five-table-live-evidence-20261123.json';
const FSHA='a4f3a62680874cef47149f4d908fca0ef05da354';
const TSHA='df0b1d008e881a31a9bf779317109e8ccc79097b';
const extensions=/\.(ts|tsx|js|jsx|mjs|cjs)$/;
const tests=/(?:^|\/)(?:__tests__|__mocks__|fixtures?)\/|(?:\.test|\.spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const gitBlob=b=>createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
const quote=s=>s.replace(/[-\/\\^$*+?.()|[\]{}]/g,'\\$&');
export function codePath(p){
 return typeof p==='string'&&/^(server|client|shared|api)\//.test(p)
  &&extensions.test(p)&&!p.endsWith('.d.ts')
  &&!p.split('/').includes('..')&&!p.includes('\\');
}
export function targetsFromEvidence(f,t){
 assert.equal(f.format,'PR359_CB_A_6_MISSING_FUNCTIONS_LIVE_EVIDENCE_V1');
 assert.equal(t.format,'PR359_CB_A_5_MISSING_TABLES_LIVE_EVIDENCE_V1');
 assert.equal(f.source_project_ref,'iyuryuhaylhisjfcrwkz');
 assert.equal(t.source_project_ref,'iyuryuhaylhisjfcrwkz');
 assert.equal(f.canonical_baseline_approved,false);
 assert.equal(t.canonical_baseline_approved,false);
 assert.equal(f.staging_inplace_go,false);assert.equal(t.staging_inplace_go,false);
 assert.equal(f.functions.length,6);assert.equal(t.tables.length,5);
 const targets=[
  ...f.functions.map(x=>({name:x.name,kind:'function',security_definer:x.security_definer})),
  ...t.tables.map(x=>({name:x.table_name,kind:'table',security_definer:null}))
 ];
 assert.equal(new Set(targets.map(x=>x.name)).size,11);
 for(const x of targets)assert.match(x.name,/^[a-z_][a-z0-9_]*$/);
 return targets.sort((a,b)=>a.name.localeCompare(b,'en'));
}
function getContext(line,target){
 const lit='["\\x27\\x60]';
 const call=target.kind==='table'?'from':'rpc';
 if(new RegExp('\\.'+call+'\\s*\\(\\s*'+lit+quote(target.name)+lit).test(line))
  return target.kind==='table'?'supabase_from_literal':'supabase_rpc_literal';
 if(new RegExp('\\b(?:public|private|powerhub_private)\\s*\\.\\s*'+quote(target.name)+'\\b').test(line))
  return 'schema_qualified_lexical';
 return 'other_lexical';
}
export function makeReferenceIndex(inputs,targets){
 assert.equal(targets.length,11,'root coverage drift');
 assert.equal(new Set(targets.map(t=>t.name)).size,11,'duplicate root');
 assert.ok(Array.isArray(inputs)&&inputs.length>0,'no files scanned');
 const files=new Set(),matches=[],counts={server:0,client:0,shared:0,api:0};
 for(const input of inputs){
  assert.ok(codePath(input.path),'unexpected code source: '+input.path);
  assert.ok(!files.has(input.path),'duplicate code file: '+input.path);
  files.add(input.path);
  assert.ok(Buffer.isBuffer(input.bytes),'original file bytes required');
  assert.ok(input.bytes.length<=2*1024*1024,'oversized code file');
  const sha=gitBlob(input.bytes);
  const area=input.path.split('/')[0];
  counts[area]++;
  const category=tests.test(input.path)?'test_or_fixture':'application_candidate';
  const lines=input.bytes.toString('utf8').split(/\r?\n/);
  for(let i=0;i<lines.length;i++){
   for(const t of targets){
    const exact=new RegExp('(?<![A-Za-z0-9_$])'+quote(t.name)+'(?![A-Za-z0-9_$])');
    if(!exact.test(lines[i]))continue;
    matches.push({name:t.name,kind:t.kind,file:input.path,
     file_git_blob_sha:sha,line:i+1,area,category,
     lexical_context:getContext(lines[i],t),verified_runtime_invocation:false});
   }
  }
 }
 matches.sort((a,b)=>a.name.localeCompare(b.name,'en')||
  a.file.localeCompare(b.file,'en')||a.line-b.line);
 const targetsOut=targets.map(t=>{
  const rows=matches.filter(m=>m.name===t.name);
  return {...t,
   lexical_matches:rows.length,
   application_candidate_files:new Set(rows.filter(x=>x.category==='application_candidate').map(x=>x.file)).size,
   test_or_fixture_files:new Set(rows.filter(x=>x.category==='test_or_fixture').map(x=>x.file)).size,
   runtime_invocation_verified:false,unresolved_review:true};
 });
 const contexts={};
 for(const m of matches)contexts[m.lexical_context]=(contexts[m.lexical_context]||0)+1;
 return {
  format:'PR359_CB_A_ELEVEN_CODE_REFERENCE_INDEX_V1',
  scope:'tracked JS-TS files in server/client/shared/api only',
  limitations:'lexical mentions may be comments; multiline calls, dynamic SQL, triggers, server imports, Android app and all runtime call graphs are unverified',
  code_files_scanned:files.size,areas:counts,names_indexed:11,
  names_with_application_candidate_files:targetsOut.filter(x=>x.application_candidate_files>0).length,
  context_counts:contexts,targets:targetsOut,matches,
  android_external_repository_audited:false,
  code_call_graph_verified:false,objects_approved:0,
  canonical_baseline_approved:false,clean_bootstrap_pass:false,
  app_owned_approved:false,destructive_allowlist:[],
  staging_inplace_go:false,production_inplace_go:false,pr359_merge_go:false};
}
const cli=process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href;
if(cli){
 const args=process.argv.slice(2);
 assert.ok(args.length===0||(args.length===2&&args[0]==='--out'),'Usage: code-reference-index.mjs [--out file.json]');
 const f=pinnedJson(readFileSync(F),FSHA);
 const t=pinnedJson(readFileSync(T),TSHA);
 const names=targetsFromEvidence(f,t);
 const paths=execFileSync('git',['ls-files','-z','--','server','client','shared','api'],
  {encoding:'utf8',maxBuffer:16*1024*1024}).split('\0').filter(codePath).sort();
 const result=makeReferenceIndex(paths.map(p=>({path:p,bytes:readFileSync(p)})),names);
 if(args.length)writeFileSync(args[1],JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({format:result.format,files:result.code_files_scanned,
  names_with_application_candidate_files:result.names_with_application_candidate_files,
  lexical_matches:result.matches.length,contexts:result.context_counts,
  android_verified:result.android_external_repository_audited,
  app_owned_approved:result.app_owned_approved}));
}
