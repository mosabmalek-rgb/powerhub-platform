import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

// Exact Staging FK source/target identities, attested separately by the
// definition/validation/deferrability guard. No DML or repair is permitted.
export const REQUIRED_CONSTRAINTS=Object.freeze([
 'powerhub_user_device_locks_user_id_fkey',
 'staff_password_reset_intents_auth_user_id_fkey',
 'users_auth_user_id_fkey'
]);

export function parseManagedFkOrphans(jsonLines){
 assert.equal(typeof jsonLines,'string','expected JSON Lines input');
 const lines=jsonLines.split(/\r?\n/).filter(Boolean);
 assert.equal(lines.length,REQUIRED_CONSTRAINTS.length,'incomplete orphan audit');
 const result=new Map();
 for(const line of lines){
  const row=JSON.parse(line);
  assert.deepEqual(Object.keys(row).sort(),['constraint','orphans'],'invalid orphan report fields');
  assert.ok(REQUIRED_CONSTRAINTS.includes(row.constraint),'unknown managed FK');
  assert.ok(!result.has(row.constraint),'duplicate managed FK');
  assert.ok(Number.isSafeInteger(row.orphans)&&row.orphans>=0,'invalid orphan count');
  result.set(row.constraint,row.orphans);
 }
 assert.equal(result.size,REQUIRED_CONSTRAINTS.length,'missing managed FK');
 return result;
}

export function assessManagedFkRowIntegrity(source,restored){
 const a=parseManagedFkOrphans(source), b=parseManagedFkOrphans(restored);
 const sourceOrphans=[...a.values()].reduce((x,y)=>x+y,0);
 const restoreOrphans=[...b.values()].reduce((x,y)=>x+y,0);
 const changed=REQUIRED_CONSTRAINTS.filter(name=>a.get(name)!==b.get(name));
 return {
  checked:REQUIRED_CONSTRAINTS.length,
  clean:sourceOrphans===0 && restoreOrphans===0 && changed.length===0,
  sourceOrphans,restoreOrphans,changed,
  providerDeleteAuthorized:false,stagingInplaceGo:false
 };
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 assert.equal(process.argv.length,5,
  'Usage: check-staging-managed-fk-orphans.mjs --compare source.jsonl restored.jsonl');
 assert.equal(process.argv[2],'--compare');
 const r=assessManagedFkRowIntegrity(readFileSync(process.argv[3],'utf8'),readFileSync(process.argv[4],'utf8'));
 console.log('PR359_STAGING_AUTH_FK_ORPHAN_EDGES_CHECKED='+r.checked);
 console.log('PR359_STAGING_AUTH_FK_ROW_INTEGRITY='+r.clean);
 console.log('PR359_STAGING_INPLACE_GO=FALSE');
 if(!r.clean){
  console.error('PR359_STAGING_AUTH_FK_ORPHAN_COUNT_DRIFT_OR_NONZERO');
  process.exitCode=2;
 }
}
