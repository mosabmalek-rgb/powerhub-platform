import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {REQUIRED_CONSTRAINTS,parseManagedFkOrphans,assessManagedFkRowIntegrity} from './check-staging-managed-fk-orphans.mjs';

const fixture=()=>REQUIRED_CONSTRAINTS.map(constraint=>JSON.stringify({constraint,orphans:0})).join('\n')+'\n';
test('zero orphans across all three authenticated provider references, no in-place approval',()=>{
 const a=fixture();
 const r=assessManagedFkRowIntegrity(a,a);
 assert.equal(r.checked,3);
 assert.equal(r.clean,true);
 assert.equal(r.sourceOrphans,0);
 assert.equal(r.restoreOrphans,0);
 assert.equal(r.providerDeleteAuthorized,false);
 assert.equal(r.stagingInplaceGo,false);
});
test('even equal source and restored orphan counts cannot pass',()=>{
 const rows=fixture().trim().split('\n');
 rows[0]=JSON.stringify({...JSON.parse(rows[0]),orphans:1});
 const corrupt=rows.join('\n')+'\n';
 assert.equal(assessManagedFkRowIntegrity(corrupt,corrupt).clean,false);
 assert.equal(assessManagedFkRowIntegrity(fixture(),corrupt).clean,false);
});
test('missing, extra, duplicated, nonnumeric and negative results fail closed',()=>{
 const rows=fixture().trim().split('\n');
 assert.throws(()=>parseManagedFkOrphans(rows.slice(1).join('\n')));
 const dupe=[...rows];dupe[0]=dupe[1];assert.throws(()=>parseManagedFkOrphans(dupe.join('\n')));
 const unknown=[...rows];unknown[0]=JSON.stringify({constraint:'unknown',orphans:0});
 assert.throws(()=>parseManagedFkOrphans(unknown.join('\n')));
 for(const bad of [-1,1.5,'0',Number.MAX_SAFE_INTEGER+1]){
  const values=[...rows];values[0]=JSON.stringify({...JSON.parse(values[0]),orphans:bad});
  assert.throws(()=>parseManagedFkOrphans(values.join('\n')));
 }
});
test('exact SQL and isolated restore pipeline retain read-only integrity gates',()=>{
 const sql=readFileSync('scripts/pr359-r4/staging-managed-fk-orphans.sql','utf8');
 const exporter=readFileSync('scripts/pr359-r4/staging-atomic-export.sh','utf8');
 const runner=readFileSync('scripts/pr359-shadow/run.sh','utf8');
 assert.match(sql,/BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;/);
 assert.match(sql,/NOT EXISTS \(SELECT 1 FROM auth\.users/);
 for(const name of REQUIRED_CONSTRAINTS)assert.ok(sql.includes(name),name);
 assert.doesNotMatch(sql,/\b(?:DROP|DELETE|UPDATE|INSERT|TRUNCATE|ALTER)\s+(?:TABLE|INTO|FROM|SCHEMA)\b/i);
 assert.ok(exporter.includes('staging-managed-fk-orphans-source.jsonl'));
 assert.ok(exporter.includes('staging-managed-fk-orphans-after-export.jsonl'));
 assert.ok(runner.includes('staging-managed-fk-orphans-restored.jsonl'));
 assert.ok(runner.includes('check-staging-managed-fk-orphans.mjs --compare'));
 assert.ok(runner.indexOf('SHADOW_STAGE=restore-data')<runner.indexOf('SHADOW_STAGE=staging-restored-managed-fk-orphans'));
 assert.ok(runner.includes('PR359_STAGING_INPLACE_GO=FALSE'));
});
