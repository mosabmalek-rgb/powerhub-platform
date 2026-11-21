import test from 'node:test';
import assert from 'node:assert/strict';
import {assessStagingR4Inventory} from './staging-preflight.mjs';

const fixture=()=>({
 project_ref:'iyuryuhaylhisjfcrwkz',
 capture_mode:'single-statement-read-only',
 metadata:{
  app_relations:{public:325,private:12},
  app_extension_members:0,
  auth_user_count:7,
  storage_object_metadata_count:0,
  storage_bucket_count:1,
  migration_history_count:553,
  migration_latest_version:'20261116231000',
  app_cron_job_count:2,
  authenticated_security_definer_exposed_count:52,
  auth_user_noninternal_triggers:[],
  app_managed_foreign_keys:[
   {name:'powerhub_user_device_locks_user_id_fkey',source_schema:'public',referenced_schema:'auth',referenced_relation:'users'},
   {name:'staff_password_reset_intents_auth_user_id_fkey',source_schema:'public',referenced_schema:'auth',referenced_relation:'users'},
   {name:'users_auth_user_id_fkey',source_schema:'public',referenced_schema:'auth',referenced_relation:'users'}
  ]
 }});
test('matching inventory is NOT destructive staging approval',()=>{
 const r=assessStagingR4Inventory(fixture());
 assert.equal(r.inventoryMatches,true);
 assert.deepEqual(r.blockers,[]);
 assert.equal(r.stagingInplaceGo,false);
});
test('reject wrong environment and unaudited capture mode',()=>{
 const x=fixture();x.project_ref='vvcdiqcyhaloxesvpppc';
 assert.ok(assessStagingR4Inventory(x).blockers.includes('UNEXPECTED_PROJECT_REF'));
 const y=fixture();y.capture_mode='unverified';
 assert.ok(assessStagingR4Inventory(y).blockers.includes('UNATTESTED_READ_ONLY_SNAPSHOT'));
});
test('fail on changed Auth, storage, cron or migration history',()=>{
 for(const [key,value] of Object.entries({
  auth_user_count:8,storage_object_metadata_count:1,
  app_cron_job_count:3,migration_history_count:554,
  migration_latest_version:'99999999999999',
  authenticated_security_definer_exposed_count:53
 })){
  const f=fixture();f.metadata[key]=value;
  assert.ok(assessStagingR4Inventory(f).blockers.includes('SNAPSHOT_DRIFT:'+key),key);
 }
});
test('fail on managed auth FK, trigger and new application schema',()=>{
 const f=fixture();f.metadata.app_managed_foreign_keys.pop();
 assert.ok(assessStagingR4Inventory(f).blockers.some(s=>s.startsWith('MANAGED_FK')));
 const g=fixture();g.metadata.auth_user_noninternal_triggers=['unexpected'];
 assert.ok(assessStagingR4Inventory(g).blockers.includes('AUTH_USER_TRIGGER_DRIFT'));
 const h=fixture();h.metadata.app_relations.unreviewed=1;
 assert.ok(assessStagingR4Inventory(h).blockers.includes('UNREVIEWED_APP_SCHEMA'));
});
