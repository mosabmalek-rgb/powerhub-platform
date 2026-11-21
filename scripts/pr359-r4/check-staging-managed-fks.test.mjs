import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {REQUIRED_EDGES,parseManagedForeignKeys,assessManagedForeignKeyParity} from './check-staging-managed-fks.mjs';
const fixture=()=>Object.entries(REQUIRED_EDGES).map(([name,source_table])=>JSON.stringify({
 name,source_schema:'public',source_table,target_schema:'auth',target_table:'users',
 definition_sha256:'a'.repeat(64),validated:true,deferrable:false,deferred:false
})).join('\n')+'\n';
test('three exact Auth cross-schema dependencies preserved, no destructive approval',()=>{
 const f=fixture();
 const r=assessManagedForeignKeyParity(f,f);
 assert.equal(parseManagedForeignKeys(f).size,3);
 assert.equal(r.checked,3);
 assert.equal(r.definitionMatch,true);
 assert.equal(r.appOwnedApproved,false);
 assert.equal(r.providerDeleteAuthorized,false);
 assert.equal(r.stagingInplaceGo,false);
});
test('equal count but altered FK definition is rejected',()=>{
 const src=fixture(),rows=src.trim().split('\n');
 rows[0]=JSON.stringify({...JSON.parse(rows[0]),definition_sha256:'b'.repeat(64)});
 const result=assessManagedForeignKeyParity(src,rows.join('\n')+'\n');
 assert.equal(result.definitionMatch,false);
 assert.equal(result.changed.length,1);
});
test('missing, duplicated, invalid or dangerous provider FKs fail closed',()=>{
 const rows=fixture().trim().split('\n');
 assert.throws(()=>parseManagedForeignKeys(rows.slice(1).join('\n')));
 const duplicate=[...rows];duplicate[0]=duplicate[1];assert.throws(()=>parseManagedForeignKeys(duplicate.join('\n')));
 const wrong=[...rows];wrong[1]=JSON.stringify({...JSON.parse(wrong[1]),target_schema:'public'});assert.throws(()=>parseManagedForeignKeys(wrong.join('\n')));
 const notValid=[...rows];notValid[2]=JSON.stringify({...JSON.parse(notValid[2]),validated:false});assert.throws(()=>parseManagedForeignKeys(notValid.join('\n')));
 const badHash=[...rows];badHash[1]=JSON.stringify({...JSON.parse(badHash[1]),definition_sha256:'not-sha'});assert.throws(()=>parseManagedForeignKeys(badHash.join('\n')));
});
test('read-only source SQL lists FKs to managed namespaces without user values',()=>{
 const q=readFileSync('scripts/pr359-r4/staging-managed-fks.sql','utf8');
 for(const s of ['REPEATABLE READ READ ONLY','pg_constraint','pg_get_constraintdef','extensions.digest','rn.nspname IN'])assert.ok(q.includes(s),s);
 assert.doesNotMatch(q,/\b(DROP|DELETE|UPDATE|INSERT|TRUNCATE|ALTER)\s+(?:TABLE|INTO|FROM|SCHEMA)\b/i);
});
test('captured in shared snapshot, verified pre-data and after each independent restore',()=>{
 const exporter=readFileSync('scripts/pr359-r4/staging-atomic-export.sh','utf8');
 const runner=readFileSync('scripts/pr359-shadow/run.sh','utf8');
 for(const stage of ['staging-managed-fks-source.jsonl','staging-managed-fks-after-export.jsonl'])
  assert.ok(exporter.includes(stage),stage);
 for(const stage of ['staging-managed-fks-pre-data.jsonl','staging-managed-fks-restored.jsonl'])
  assert.ok(runner.includes(stage),stage);
 assert.ok(exporter.includes('check-staging-managed-fks.mjs --compare'));
 assert.ok(runner.includes('check-staging-managed-fks.mjs --compare'));
 assert.ok(runner.includes('PR359_STAGING_INPLACE_GO=FALSE'));
});
