import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

const hex=/^[0-9a-f]{64}$/;
const shared=new Set([
 'public:powerhub_user_device_locks.powerhub_user_device_locks_user_id_fkey',
 'public:staff_password_reset_intents.staff_password_reset_intents_auth_user_id_fkey',
 'public:users.users_auth_user_id_fkey'
]);

// Metadata-only, non-executable evidence reconciliation.
// Neither the older catalog nor successful checks are permissions to DROP objects.
export function assessR4IndexConstraintEvidence(source,register,live){
 const errors=[];
 if(source?.format!=='R0 indexes and constraints inventory v1' ||
    source.project_ref!=='iyuryuhaylhisjfcrwkz') errors.push('WRONG_HISTORICAL_SOURCE');
 if(register?.format!=='PR359 R4 provisional object review register v1' ||
    register.staging_project_ref!=='iyuryuhaylhisjfcrwkz') errors.push('WRONG_OBJECT_REGISTER');
 if(live?.project_ref!=='iyuryuhaylhisjfcrwkz' ||
    live.capture_mode!=='single-statement-read-only') errors.push('WRONG_LIVE_CAPTURE');
 if(!Array.isArray(source?.objects)||!Array.isArray(register?.objects))
   return {valid:false,errors:[...errors,'MISSING_OBJECT_LIST'],dropAuthorized:false};
 const parent=new Set(register.objects.filter(o=>o.kind==='relation').map(o=>o.id.split('#')[0]));
 const seen=new Set();
 const counts={INDEX:0,CONSTRAINT:0,foreign_keys:0,invalid_indexes:0,unvalidated_constraints:0};
 const sharedFound=new Set();
 for(const o of source.objects){
   const identity=[o?.category,o?.schema,o?.identity].join(':');
   if(seen.has(identity)) errors.push('DUPLICATE_IDENTITY:'+identity);
   seen.add(identity);
   if(!['INDEX','CONSTRAINT'].includes(o?.category) || !['public','private'].includes(o.schema) ||
      typeof o.identity!=='string'||!o.details || typeof o.details.table!=='string'){
     errors.push('INVALID_OBJECT:'+identity);continue;
   }
   counts[o.category]++;
   if(!parent.has(o.schema+'.'+o.details.table))
     errors.push('MISSING_PARENT:'+identity);
   if(!hex.test(o.details.definition_sha256||'')) errors.push('INVALID_SHA256:'+identity);
   if(o.classification_reviewed!==false) errors.push('UNSIGNED_CLASSIFICATION:'+identity);
   const isShared=o.category==='CONSTRAINT' && shared.has(o.schema+':'+o.identity);
   if(o.classification!==(isShared?'SHARED_DEPENDENCY':'APP_OWNED_CANDIDATE'))
     errors.push('CLASSIFICATION_DRIFT:'+identity);
   if(o.category==='INDEX' && o.details.valid!==true) counts.invalid_indexes++;
   if(o.category==='CONSTRAINT' && o.details.validated!==true) counts.unvalidated_constraints++;
   if(o.category==='CONSTRAINT' && o.details.kind==='f'){
     counts.foreign_keys++;
     if(o.details.references==='auth.users' && !isShared)
       errors.push('UNREVIEWED_AUTH_FK:'+identity);
     if(isShared){
       if(o.details.references!=='auth.users') errors.push('SHARED_FK_TARGET_DRIFT:'+identity);
       sharedFound.add(o.schema+':'+o.identity);
     }
   } else if(isShared) errors.push('SHARED_NOT_FK:'+identity);
 }
 for(const key of shared) if(!sharedFound.has(key)) errors.push('MISSING_SHARED_FK:'+key);
 if(counts.INDEX!==688||counts.CONSTRAINT!==1437||counts.foreign_keys!==561)
   errors.push('HISTORICAL_COUNTS_DRIFT');
 if(counts.invalid_indexes!==0||counts.unvalidated_constraints!==0)
   errors.push('HISTORICAL_INVALID_DDL');
 if(!live?.metadata || live.metadata.indexes!==counts.INDEX ||
    live.metadata.constraints!==counts.CONSTRAINT ||
    live.metadata.foreign_keys!==counts.foreign_keys ||
    live.metadata.invalid_indexes!==counts.invalid_indexes ||
    live.metadata.unvalidated_constraints!==counts.unvalidated_constraints)
   errors.push('LIVE_COUNTS_DRIFT');
 const actualLive=live?.metadata?.managed_foreign_keys;
 if(!Array.isArray(actualLive)||actualLive.length!==shared.size)
   errors.push('LIVE_MANAGED_FKS_MISSING');
 else{
   const ids=new Set(actualLive.map(x=>'public:'+x.table+'.'+x.name));
   for(const key of shared) if(!ids.has(key)) errors.push('LIVE_SHARED_FK_MISSING:'+key);
   if(actualLive.some(x=>x.references!=='auth.users'||x.owner_schema!=='public'))
     errors.push('LIVE_FK_TARGET_DRIFT');
 }
 if(register?.decision?.destructive_allowlist?.length!==0 ||
    register?.decision?.app_owned_signed!==false ||
    register?.decision?.staging_inplace_go!==false) errors.push('UNAUTHORIZED_RELEASE_FLAG');
 return {valid:errors.length===0,errors,counts,sharedCount:sharedFound.size,
   // Historical and live identities/counts do not prove exact live DDL SHA parity.
   liveDefinitionHashParity:false,dropAuthorized:false,stagingInplaceGo:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 assert.equal(process.argv.length,5,'Usage: evidence.mjs R0-indexes.json R4-register.json live-metadata.json');
 const args=process.argv.slice(2).map(f=>JSON.parse(readFileSync(f,'utf8')));
 const r=assessR4IndexConstraintEvidence(...args);
 console.log('PR359_R4_INDEX_CONSTRAINT_EVIDENCE='+String(r.valid));
 console.log('PR359_R4_INDEXES='+r.counts?.INDEX+' CONSTRAINTS='+r.counts?.CONSTRAINT+' FKS='+r.counts?.foreign_keys);
 console.log('PR359_R4_LIVE_DEFINITION_SHA_PARITY=false');
 console.log('PR359_R4_STAGING_INPLACE_GO=false');
 for(const e of r.errors.slice(0,20)) console.error('PR359_R4_INDEX_BLOCKER='+e);
 if(!r.valid)process.exitCode=2;
}
