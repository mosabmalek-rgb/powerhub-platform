import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {validateMigrationProvenance} from '../pr359-r4/verify-legacy-migration-provenance.mjs';

// Provisional SOURCE CANDIDATES only: not executable SQL, final DDL or ownership approval.
const id='[a-zA-Z_][a-zA-Z0-9_$]*';
const ddl=new RegExp('\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?(MATERIALIZED\\s+VIEW|FUNCTION|TABLE|VIEW|SEQUENCE)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?('+id+'(?:\\s*\\.\\s*'+id+')?)','gi');
const gitBlob=b=>createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
function masked(sql){
 const chars=sql.split('');
 const hide=(a,b)=>{for(let k=a;k<b;k++)if(chars[k]!=='\n'&&chars[k]!=='\r')chars[k]=' ';};
 for(let i=0;i<sql.length;){
  if(sql.startsWith('--',i)){let j=sql.indexOf('\n',i+2);if(j<0)j=sql.length;hide(i,j);i=j;continue;}
  if(sql.startsWith('/*',i)){let d=1,j=i+2;while(j<sql.length&&d){if(sql.startsWith('/*',j)){d++;j+=2;}else if(sql.startsWith('*/',j)){d--;j+=2;}else j++;}hide(i,j);i=j;continue;}
  if(sql[i]==="'"){let j=i+1;while(j<sql.length){if(sql[j]==="'"&&sql[j+1]==="'"){j+=2;continue;}if(sql[j]==="'"){j++;break;}j++;}hide(i,j);i=j;continue;}
  if(sql[i]==='$'){let m=/^\$[a-zA-Z0-9_]*\$/.exec(sql.slice(i));if(m){let j=sql.indexOf(m[0],i+m[0].length);j=j<0?sql.length:j+m[0].length;hide(i,j);i=j;continue;}}
  i++;
 }
 return chars.join('');
}
export function extractCreates(sql){
 const found=[];
 for(const m of masked(sql).matchAll(ddl)){
  const name=m[2].replace(/\s+/g,'').toLowerCase();
  found.push({target:name.includes('.')?name:'public.'+name,type:m[1].replace(/\s+/g,' ').toUpperCase(),
   offset:m.index,match_basis:name.includes('.')?'explicit_schema_name_only':'unqualified_assumed_public'});
 }
 return found;
}
const objectKey=o=>{
 const raw=o.kind==='function'?o.id.split('(')[0]:o.id.split('#')[0];
 return (raw.includes('.')?raw:o.schema+'.'+raw).toLowerCase();
};
function kindCompatible(o,k){
 if(o.kind==='function')return k==='FUNCTION';
 const r=o.id.slice(o.id.lastIndexOf('#')+1);
 return (k==='TABLE'&&(r==='r'||r==='p'))||(k==='SEQUENCE'&&r==='S')||
  (k==='VIEW'&&r==='v')||(k==='MATERIALIZED VIEW'&&r==='m');
}
export function buildIndex(register,sources){
 assert.equal(register.format,'PR359 R4 provisional object review register v1');
 assert.equal(register.staging_project_ref,'iyuryuhaylhisjfcrwkz');
 assert.equal(register.objects.length,978);
 assert.equal(register.decision.app_owned_signed,false);
 assert.equal(register.decision.staging_inplace_go,false);
 assert.deepEqual(register.decision.destructive_allowlist,[]);
 assert.equal(sources.length,700,'source count drift');
 const byName=new Map(),seenFiles=new Set();
 for(const s of sources){
  assert.match(s.path,/^supabase\/migrations\/[a-zA-Z0-9_-]+\.sql$/);
  assert.ok(!seenFiles.has(s.path),'duplicate path');seenFiles.add(s.path);
  assert.equal(gitBlob(s.bytes),s.sha,'historical blob differs: '+s.path);
  const sql=s.bytes.toString('utf8');
  assert.ok(!/\bAUTO_INCREMENT\b|\x60[^\x60]+\x60/.test(sql),'MySQL DDL excluded');
  for(const hit of extractCreates(sql)){
   const items=byName.get(hit.target)||[];
   items.push({source_path:s.path,source_blob_sha:s.sha,statement_kind:hit.type,
    match_basis:hit.match_basis,offset:hit.offset});
   byName.set(hit.target,items);
  }
 }
 const objects=[],seen=new Set();
 for(const o of register.objects){
  assert.ok(!seen.has(o.id),'duplicate catalog object');seen.add(o.id);
  assert.ok(o.kind==='function'||o.kind==='relation');
  assert.equal(o.classification,'APP_OWNED_CANDIDATE','unauthorized ownership');
  assert.equal(o.reviewed,false,'unauthorized review');
  assert.equal(o.owner,'postgres','owner drift');
  assert.equal(o.extension,null,'unreviewed extension');
  const candidates=(byName.get(objectKey(o))||[]).filter(x=>kindCompatible(o,x.statement_kind))
   .sort((a,b)=>a.source_path.localeCompare(b.source_path)||a.offset-b.offset);
  objects.push({id:o.id,kind:o.kind,source_candidates:candidates,
   source_status:candidates.length?'LEXICAL_CANDIDATE_ONLY':'NO_STATIC_CREATE_EVIDENCE',
   current_executable_definition_verified:false,exact_signature_verified:false,
   app_callers_verified:false,managed_dependencies_verified:false,approved:false});
 }
 assert.equal(seen.size,978);
 objects.sort((a,b)=>a.id.localeCompare(b.id,'en'));
 const matched=objects.filter(o=>o.source_candidates.length).length;
 return {format:'PR359_CB_A_SOURCE_INDEX_V1',
  warning:'Unreviewed lexical CREATE evidence only; not current DDL, exact overload, managed dependencies, owned objects or bootstrap SQL',
  object_count:978,legacy_files:700,with_source_candidates:matched,
  without_static_source_candidates:978-matched,unresolved_review_count:978,
  objects,app_owned_approved:false,canonical_baseline_approved:false,
  clean_bootstrap_pass:false,epoch_v2_operational:false,
  destructive_allowlist:[],staging_inplace_go:false,production_inplace_go:false,pr359_merge_go:false};
}
export function requireCanonicalApproval(result){
 assert.equal(result.object_count,978);
 const pending=result.objects.filter(o=>!o.approved||!o.current_executable_definition_verified||
  !o.exact_signature_verified||!o.app_callers_verified||!o.managed_dependencies_verified);
 assert.equal(pending.length,0,'unresolved objects: '+pending.length);
 assert.equal(result.canonical_baseline_approved,true,'canonical baseline not approved');
 assert.equal(result.clean_bootstrap_pass,true,'clean bootstrap not proven');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const args=process.argv.slice(2);
 assert.ok(args.length===0||(args.length===2&&args[0]==='--out'),'Usage: source-index.mjs [--out path]');
 const load=p=>JSON.parse(readFileSync(p,'utf8'));
 const m=load('docs/security/pr359-r4-legacy-migration-provenance-20261123.json');
 validateMigrationProvenance(m);
 const result=buildIndex(load('docs/security/pr359-r4-staging-object-register-20261120.json'),
  m.files.map(f=>({path:f.path,sha:f.sha,bytes:readFileSync(f.path)})));
 if(args.length)writeFileSync(args[1],JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({format:result.format,objects:result.object_count,
  matched:result.with_source_candidates,unmatched:result.without_static_source_candidates,
  unresolved:result.unresolved_review_count,approved:result.canonical_baseline_approved}));
}
