import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

const reference={
  app_relations:{public:325,private:12},
  auth_user_count:7,
  storage_object_metadata_count:0,
  storage_bucket_count:1,
  migration_history_count:553,
  migration_latest_version:'20261116231000',
  app_cron_job_count:2,
  authenticated_security_definer_exposed_count:52,
  app_extension_members:0,
};
const requiredForeignKeys=[
  'powerhub_user_device_locks_user_id_fkey',
  'staff_password_reset_intents_auth_user_id_fkey',
  'users_auth_user_id_fkey',
];
export function assessStagingR4Inventory(snapshot){
  assert.ok(snapshot && typeof snapshot==='object');
  const blockers=[];
  if(snapshot.project_ref!=='iyuryuhaylhisjfcrwkz')
    blockers.push('UNEXPECTED_PROJECT_REF');
  if(snapshot.capture_mode!=='single-statement-read-only')
    blockers.push('UNATTESTED_READ_ONLY_SNAPSHOT');
  const m=snapshot.metadata;
  if(!m||typeof m!=='object') return {inventoryMatches:false,blockers:[...blockers,'MISSING_METADATA'],stagingInplaceGo:false};
  for(const [key,expected] of Object.entries(reference)){
    if(m[key]!==expected && typeof expected!=='object')
      blockers.push('SNAPSHOT_DRIFT:'+key);
  }
  const actualRelations=m.app_relations||{};
  for(const [schema,n] of Object.entries(reference.app_relations))
    if(actualRelations[schema]!==n) blockers.push('SNAPSHOT_DRIFT:app_relations.'+schema);
  if(Object.keys(actualRelations).some(schema=>!Object.hasOwn(reference.app_relations,schema)))
    blockers.push('UNREVIEWED_APP_SCHEMA');
  const fks=m.app_managed_foreign_keys;
  if(!Array.isArray(fks)) blockers.push('MISSING_MANAGED_FK_INVENTORY');
  else{
    const byName=new Map(fks.map(f=>[f.name,f]));
    if(byName.size!==requiredForeignKeys.length) blockers.push('UNREVIEWED_MANAGED_FK');
    for(const name of requiredForeignKeys){
      const fk=byName.get(name);
      if(!fk||fk.source_schema!=='public'||fk.referenced_schema!=='auth'||
        fk.referenced_relation!=='users')
        blockers.push('MANAGED_FK_DRIFT:'+name);
    }
  }
  if(!Array.isArray(m.auth_user_noninternal_triggers)||
      m.auth_user_noninternal_triggers.length!==0)
    blockers.push('AUTH_USER_TRIGGER_DRIFT');
  return {
    inventoryMatches:blockers.length===0,
    blockers,
    // R4 destructive execution needs separately approved object allowlist,
    // durable backups and test-data disposition, migration-epoch v2 proof,
    // frozen integrations, and explicit approval. Never grant it from counts.
    stagingInplaceGo:false
  };
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  assert.equal(process.argv.length,3,
    'Usage: node staging-preflight.mjs evidence.json (metadata-only, no secrets)');
  const r=assessStagingR4Inventory(JSON.parse(readFileSync(process.argv[2],'utf8')));
  for(const b of r.blockers) console.error('PR359_R4_INVENTORY_BLOCKER='+b);
  console.log('PR359_R4_SNAPSHOT_MATCHES='+r.inventoryMatches);
  console.log('PR359_R4_STAGING_INPLACE_GO=FALSE');
  if(!r.inventoryMatches) process.exitCode=2;
}
