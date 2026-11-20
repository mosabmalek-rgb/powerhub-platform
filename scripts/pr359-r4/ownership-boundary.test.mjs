import test from 'node:test';
import assert from 'node:assert/strict';
import {assessR4OwnershipBoundary} from './ownership-boundary.mjs';
const fixture=()=>({
 project_ref:'iyuryuhaylhisjfcrwkz',capture_mode:'single-statement-read-only',
 metadata:{
  scope:'PR359_R4_STAGING_OWNERSHIP_BOUNDARY_V1',
  owned_groups:[
   {kind:'function',schema:'powerhub_private',owner:'postgres',extension_owned:false,object_count:5},
   {kind:'function',schema:'private',owner:'postgres',extension_owned:false,object_count:57},
   {kind:'function',schema:'public',owner:'postgres',extension_owned:false,object_count:579},
   {kind:'relation',schema:'private',owner:'postgres',extension_owned:false,object_count:12},
   {kind:'relation',schema:'public',owner:'postgres',extension_owned:false,object_count:325},
  ],
  managed_edges:[],
  managed_foreign_keys:[
   {constraint_name:'powerhub_user_device_locks_user_id_fkey',source_schema:'public',
    source_table:'powerhub_user_device_locks',target_schema:'auth',target_table:'users',
    validated:true,deferrable:false,deferred:false},
   {constraint_name:'staff_password_reset_intents_auth_user_id_fkey',source_schema:'public',
    source_table:'staff_password_reset_intents',target_schema:'auth',target_table:'users',
    validated:true,deferrable:false,deferred:false},
   {constraint_name:'users_auth_user_id_fkey',source_schema:'public',
    source_table:'users',target_schema:'auth',target_table:'users',
    validated:true,deferrable:false,deferred:false},
  ],
  cron_inventory:[
   {name:'powerhub-subscription-lifecycle',schedule:'*/15 * * * *',active:true},
   {name:'powerhub_reconcile_expired_field_readers',schedule:'*/5 * * * *',active:true},
  ],
  app_trigger_count:202,app_rel_with_rls_no_policy:78,
 }});
test('known metadata passes observation but NEVER grants APP_OWNED removal permission',()=>{
 const r=assessR4OwnershipBoundary(fixture());
 assert.deepEqual(r.blockers,[]);
 assert.equal(r.provisionalObjectCount,978);
 assert.equal(r.inventoryMatches,true);
 assert.equal(r.appOwnedApproved,false);
 assert.equal(r.stagingInplaceGo,false);
});
test('provider ownership and extension objects fail closed',()=>{
 const a=fixture();a.metadata.owned_groups[0].owner='supabase_admin';
 assert.ok(assessR4OwnershipBoundary(a).blockers.some(b=>b.startsWith('PROVIDER_OR_OWNER')));
 const b=fixture();b.metadata.owned_groups[0].extension_owned=true;
 assert.ok(assessR4OwnershipBoundary(b).blockers.some(s=>s.startsWith('PROVIDER_OR_OWNER')));
});
test('new groups and direct managed dependencies require review',()=>{
 const x=fixture();x.metadata.owned_groups.push({kind:'relation',schema:'storage',owner:'postgres',extension_owned:false,object_count:1});
 assert.ok(assessR4OwnershipBoundary(x).blockers.some(s=>s.startsWith('UNREVIEWED_OBJECT_GROUP')));
 const y=fixture();y.metadata.managed_edges.push({schema:'public',kind:'function',referenced_schema:'auth',deptype:'n',edges:1});
 assert.ok(assessR4OwnershipBoundary(y).blockers.includes('MANAGED_DEPENDENCY_REVIEW_REQUIRED'));
});
test('cron modification, missing job and count drift are blocking',()=>{
 const x=fixture();x.metadata.cron_inventory[0].active=false;
 assert.ok(assessR4OwnershipBoundary(x).blockers.some(s=>s.startsWith('CRON_CHANGE')));
 const y=fixture();y.metadata.cron_inventory.pop();
 assert.ok(assessR4OwnershipBoundary(y).blockers.some(s=>s.startsWith('CRON_MISSING')));
 const z=fixture();z.metadata.app_trigger_count++;
 assert.ok(assessR4OwnershipBoundary(z).blockers.includes('TRIGGER_COUNT_DRIFT'));
});
test('different database, schema and absent audit are never accepted',()=>{
 const x=fixture();x.project_ref='vvcdiqcyhaloxesvpppc';
 assert.ok(assessR4OwnershipBoundary(x).blockers.includes('WRONG_PROJECT'));
 const y=fixture();y.metadata.scope='wrong';
 assert.equal(assessR4OwnershipBoundary(y).inventoryMatches,false);
 const z=fixture();delete z.metadata.owned_groups;
 assert.ok(assessR4OwnershipBoundary(z).blockers.includes('MISSING_OBJECT_GROUPS'));
});

test('ownership inventory requires the three provider Auth foreign keys explicitly',()=>{
 const missing=fixture(); delete missing.metadata.managed_foreign_keys;
 assert.ok(assessR4OwnershipBoundary(missing).blockers.includes('MISSING_MANAGED_FK_INVENTORY'));
 const omitted=fixture(); omitted.metadata.managed_foreign_keys.pop();
 const omittedResult=assessR4OwnershipBoundary(omitted);
 assert.ok(omittedResult.blockers.includes('MANAGED_FK_COUNT_DRIFT'));
 assert.ok(omittedResult.blockers.some(x=>x.startsWith('MISSING_MANAGED_FK:')));
 const changed=fixture(); changed.metadata.managed_foreign_keys[0].target_table='identities';
 assert.ok(assessR4OwnershipBoundary(changed).blockers.some(x=>x.startsWith('MANAGED_FK_DEFINITION_OR_TARGET_DRIFT:')));
 const invalid=fixture(); invalid.metadata.managed_foreign_keys[0].validated=false;
 assert.ok(assessR4OwnershipBoundary(invalid).blockers.some(x=>x.startsWith('MANAGED_FK_DEFINITION_OR_TARGET_DRIFT:')));
 const unexpected=fixture(); unexpected.metadata.managed_foreign_keys[0].constraint_name='unknown_fk';
 assert.ok(assessR4OwnershipBoundary(unexpected).blockers.includes('UNREVIEWED_MANAGED_FK'));
 const duplicate=fixture(); duplicate.metadata.managed_foreign_keys[1]={...duplicate.metadata.managed_foreign_keys[0]};
 assert.ok(assessR4OwnershipBoundary(duplicate).blockers.some(x=>x.startsWith('DUPLICATE_MANAGED_FK:')));
});
