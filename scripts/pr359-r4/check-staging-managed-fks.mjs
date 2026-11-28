import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// Read-only observations, not permission to drop anything. Provider Auth must
// survive and preserve all three cross-schema application references.
export const REQUIRED_EDGES=Object.freeze({
 powerhub_user_device_locks_user_id_fkey: 'powerhub_user_device_locks',
 staff_password_reset_intents_auth_user_id_fkey: 'staff_password_reset_intents',
 users_auth_user_id_fkey: 'users'
});
const columns=['name','source_schema','source_table','target_schema','target_table','definition_sha256','validated','deferrable','deferred'].sort();

export function parseManagedForeignKeys(text){
 assert.equal(typeof text,'string');
 const lines=text.split(/\r?\n/).filter(Boolean);
 assert.equal(lines.length,3,'managed FK count drift');
 const out=new Map();
 for(const line of lines){
  const row=JSON.parse(line);
  assert.deepEqual(Object.keys(row).sort(),columns,'unexpected FK fields');
  assert.ok(Object.hasOwn(REQUIRED_EDGES,row.name),'unreviewed managed FK');
  assert.ok(!out.has(row.name),'duplicate managed FK');
  assert.equal(row.source_schema,'public','unexpected source schema');
  assert.equal(row.source_table,REQUIRED_EDGES[row.name],'unexpected source table');
  assert.equal(row.target_schema,'auth','unexpected provider schema');
  assert.equal(row.target_table,'users','unexpected provider table');
  assert.match(row.definition_sha256,/^[a-f0-9]{64}$/,'invalid FK definition digest');
  assert.equal(row.validated,true,'FK is NOT VALID');
  assert.equal(row.deferrable,false,'FK deferrability drift');
  assert.equal(row.deferred,false,'FK initial deferral drift');
  out.set(row.name,row.definition_sha256);
 }
 assert.equal(out.size,3);
 return out;
}
export function assessManagedForeignKeyParity(source,restored){
 const a=parseManagedForeignKeys(source),b=parseManagedForeignKeys(restored);
 const changed=[...a.keys()].filter(name=>a.get(name)!==b.get(name));
 return {checked:a.size,definitionMatch:changed.length===0,changed,
  appOwnedApproved:false,providerDeleteAuthorized:false,stagingInplaceGo:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 assert.equal(process.argv.length,5,'Usage: check-staging-managed-fks.mjs --compare source.jsonl restored.jsonl');
 assert.equal(process.argv[2],'--compare');
 const x=assessManagedForeignKeyParity(readFileSync(process.argv[3],'utf8'),readFileSync(process.argv[4],'utf8'));
 console.log('PR359_STAGING_MANAGED_FK_EDGES_CHECKED='+x.checked);
 console.log('PR359_STAGING_MANAGED_FK_DEFINITION_MATCH='+x.definitionMatch);
 console.log('PR359_APP_OWNED_APPROVED=FALSE');
 console.log('PR359_STAGING_INPLACE_GO=FALSE');
 if(!x.definitionMatch){console.error('PR359_STAGING_MANAGED_FK_DRIFT='+x.changed.join(','));process.exitCode=2;}
}
