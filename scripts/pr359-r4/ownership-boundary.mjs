import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

// Exact read-only observation. This is intentionally NOT an executable drop allowlist.
const counts=new Map([
 ['function:powerhub_private',5],['function:private',57],['function:public',579],
 ['relation:private',12],['relation:public',325],
]);
const jobs=new Map([
 ['powerhub-subscription-lifecycle','*/15 * * * *'],
 ['powerhub_reconcile_expired_field_readers','*/5 * * * *'],
]);
export function assessR4OwnershipBoundary(snapshot){
 assert.ok(snapshot && typeof snapshot==='object','invalid inventory');
 const blockers=[];
 if(snapshot.project_ref!=='iyuryuhaylhisjfcrwkz') blockers.push('WRONG_PROJECT');
 if(snapshot.capture_mode!=='single-statement-read-only') blockers.push('INVALID_CAPTURE_MODE');
 const m=snapshot.metadata;
 if(!m || m.scope!=='PR359_R4_STAGING_OWNERSHIP_BOUNDARY_V1')
   return {blockers:[...blockers,'MISSING_OR_UNRECOGNIZED_METADATA'],
     inventoryMatches:false,appOwnedApproved:false,stagingInplaceGo:false};
 if(!Array.isArray(m.owned_groups)) blockers.push('MISSING_OBJECT_GROUPS');
 else{
   const seen=new Set();
   for(const g of m.owned_groups){
     const key=g.kind+':'+g.schema;
     if(seen.has(key)) blockers.push('DUPLICATE_OBJECT_GROUP:'+key);
     seen.add(key);
     if(!counts.has(key)) blockers.push('UNREVIEWED_OBJECT_GROUP:'+key);
     if(g.owner!=='postgres'||g.extension_owned!==false)
       blockers.push('PROVIDER_OR_OWNER_BOUNDARY:'+key);
     if(g.object_count!==counts.get(key))
       blockers.push('OBJECT_COUNT_DRIFT:'+key);
   }
   for(const key of counts.keys()) if(!seen.has(key)) blockers.push('MISSING_OBJECT_GROUP:'+key);
 }
 if(!Array.isArray(m.managed_edges)) blockers.push('MISSING_DEPENDENCY_EVIDENCE');
 else if(m.managed_edges.length!==0) blockers.push('MANAGED_DEPENDENCY_REVIEW_REQUIRED');
 if(!Array.isArray(m.cron_inventory)) blockers.push('MISSING_CRON_INVENTORY');
 else{
   const found=new Set();
   for(const job of m.cron_inventory){
     if(found.has(job.name)) blockers.push('DUPLICATE_CRON:'+job.name);
     found.add(job.name);
     if(!jobs.has(job.name) || jobs.get(job.name)!==job.schedule || job.active!==true)
       blockers.push('CRON_CHANGE_REQUIRES_REVIEW:'+job.name);
   }
   for(const name of jobs.keys()) if(!found.has(name)) blockers.push('CRON_MISSING:'+name);
 }
 if(m.app_trigger_count!==202) blockers.push('TRIGGER_COUNT_DRIFT');
 if(m.app_rel_with_rls_no_policy!==78) blockers.push('RLS_POLICY_BASELINE_DRIFT');
 return {
   inventoryMatches:blockers.length===0,blockers,
   provisionalObjectCount:978,
   // pg_depend does not fully capture dynamic SQL, function-body references,
   // application/runtime dependencies or provider ownership in shared schemas.
   appOwnedApproved:false,stagingInplaceGo:false
 };
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 assert.equal(process.argv.length,3,'Usage: ownership-boundary.mjs metadata-evidence.json');
 const r=assessR4OwnershipBoundary(JSON.parse(readFileSync(process.argv[2],'utf8')));
 for(const e of r.blockers) console.error('PR359_R4_OWNERSHIP_BLOCKER='+e);
 console.log('PR359_R4_OWNERSHIP_INVENTORY_MATCH='+r.inventoryMatches);
 console.log('PR359_R4_APP_OWNED_SIGNED=false');
 console.log('PR359_R4_STAGING_INPLACE_GO=false');
 if(!r.inventoryMatches) process.exitCode=2;
}
