import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

const hex64=/^[a-f0-9]{64}$/;
const gitBlobSha=/^[a-f0-9]{40}$/;
export function assessR4ObjectRegister(register) {
 const blockers=[];
 if(register?.format!=='PR359 R4 provisional object review register v1'||
    register.staging_project_ref!=='iyuryuhaylhisjfcrwkz')
   blockers.push('UNRECOGNIZED_REGISTER');
 if(!Array.isArray(register?.objects)) return {blockers:[...blockers,'OBJECTS_MISSING'],observed:false,dropAuthorized:false};
 if(register.objects.length!==978) blockers.push('OBJECT_COUNT_DRIFT');
 const unique=new Set(),totals={relation:0,function:0};
 for(const o of register.objects){
   if(!o || typeof o.id!=='string' || !['relation','function'].includes(o.kind) ||
      !['public','private','powerhub_private'].includes(o.schema)) {
     blockers.push('INVALID_IDENTITY'); continue;
   }
   const key=o.kind+':'+o.id;
   if(unique.has(key)) blockers.push('DUPLICATE_ID:'+key);
   unique.add(key);
   totals[o.kind]++;
   if(o.owner!=='postgres'||o.extension!==null) blockers.push('PROVIDER_OR_OWNER_DRIFT:'+key);
   if(o.classification!=='APP_OWNED_CANDIDATE'||
      o.reviewed!==false) blockers.push('UNATTESTED_CLASSIFICATION:'+key);
   if(o.kind==='function' && !hex64.test(o.definition_sha256||''))
     blockers.push('FUNCTION_SHA_MISSING:'+key);
   if(o.kind==='relation' && o.definition_sha256!==null)
     blockers.push('RELATION_SHA_NOT_FROM_R0:'+key);
 }
 if(totals.relation!==337||totals.function!==641) blockers.push('CLASS_COUNTS_DRIFT');
 if(!Array.isArray(register.source_evidence)||register.source_evidence.length!==3||
    register.source_evidence.some(x=>typeof x.blob_sha!=='string'||!gitBlobSha.test(x.blob_sha)))
    blockers.push('SOURCE_EVIDENCE_MISSING');
 // R0 indexes/constraint source was not parseable in a GitHub fetch. Do not certify it.
 if(register.source_evidence?.[2]?.parseable!==true ||
    register.source_evidence?.[2]?.object_count!==2125)
    blockers.push('INDEX_CONSTRAINT_EVIDENCE_MISSING');
 if(register.decision?.app_owned_signed!==false||
    register.decision?.migration_epoch_v2_proven!==false||
    register.decision?.staging_inplace_go!==false||
    !Array.isArray(register.decision?.destructive_allowlist)||
    register.decision.destructive_allowlist.length!==0)
    blockers.push('UNAUTHORIZED_GO_OR_DROP_LIST');
 return {blockers,observed:blockers.length===0,
   unresolvedClassification:register.objects.filter(x=>x?.reviewed!==true).length,
   dropAuthorized:false,stagingInplaceGo:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 assert.equal(process.argv.length,3,'Usage: object-register.mjs register.json');
 const result=assessR4ObjectRegister(JSON.parse(readFileSync(process.argv[2],'utf8')));
 console.log('PR359_R4_REGISTER_ROWS='+result.unresolvedClassification);
 console.log('PR359_R4_REGISTER_METADATA_VALID='+result.observed);
 console.log('PR359_R4_DROP_AUTHORIZED=FALSE');
 console.log('PR359_R4_STAGING_INPLACE_GO=FALSE');
 for(const b of result.blockers.slice(0,30)) console.error('PR359_R4_REGISTER_BLOCKER='+b);
 if(result.blockers.length) process.exitCode=2;
}
