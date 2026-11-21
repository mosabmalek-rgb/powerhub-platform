import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseAllFkIntegrity,assessAllFkIntegrity,EXPECTED_STAGING_APP_FKS} from './check-staging-all-fk-integrity.mjs';
const names=['alpha','beta','gamma'];
const fixture=()=>names.map(name=>JSON.stringify({schema:'public',table:'tenant',name,validated:true,match:'s',operator_ok:true,violations:0})).join('\n')+'\n';
test('strict source/restore parity over every observed foreign key',()=>{
 assert.equal(EXPECTED_STAGING_APP_FKS,561);
 const r=assessAllFkIntegrity(fixture(),fixture(),3);
 assert.equal(r.checked,3);assert.equal(r.clean,true);assert.equal(r.appOwnedApproved,false);
 assert.equal(r.stagingInplaceGo,false);
});
test('equal nonzero violation counts still fail even when source and restore match',()=>{
 const rows=fixture().trim().split('\n');
 rows[1]=JSON.stringify({...JSON.parse(rows[1]),violations:2});
 const bad=rows.join('\n')+'\n';
 assert.equal(assessAllFkIntegrity(bad,bad,3).clean,false);
 assert.equal(assessAllFkIntegrity(fixture(),bad,3).clean,false);
});
test('missing, duplicate, unexpected, altered and unsafe constraint cases fail closed',()=>{
 const rows=fixture().trim().split('\n');
 assert.throws(()=>parseAllFkIntegrity(rows.slice(1).join('\n'),3));
 const dup=[...rows];dup[0]=dup[1];assert.throws(()=>parseAllFkIntegrity(dup.join('\n'),3));
 const unknown=[...rows];unknown[0]=JSON.stringify({...JSON.parse(rows[0]),schema:'auth'});
 assert.throws(()=>parseAllFkIntegrity(unknown.join('\n'),3));
 const flags=[['validated',false],['match','f'],['operator_ok',false],['violations',-1],['violations',0.3],['violations','0']];
 for(const [key,value] of flags){
  const bad=[...rows];bad[0]=JSON.stringify({...JSON.parse(rows[0]),[key]:value});
  assert.throws(()=>parseAllFkIntegrity(bad.join('\n'),3));
 }
 const changed=[...rows];changed[0]=JSON.stringify({...JSON.parse(rows[0]),name:'different'});
 const r=assessAllFkIntegrity(fixture(),changed.join('\n'),3);
 assert.equal(r.clean,false);assert.equal(r.missing.length,1);assert.equal(r.extra.length,1);
});
test('read-only PostgreSQL catalog generator is wired to exported snapshot and both restores',()=>{
 const sql=readFileSync('scripts/pr359-r4/staging-all-fk-integrity.sql','utf8');
 const exp=readFileSync('scripts/pr359-r4/staging-atomic-export.sh','utf8');
 const runner=readFileSync('scripts/pr359-shadow/run.sh','utf8');
 for(const fragment of ['REPEATABLE READ READ ONLY','co.conpfeqop','co.confmatchtype','NOT EXISTS','\\gexec','s.%I IS NOT NULL'])
  assert.ok(sql.includes(fragment),fragment);
 assert.doesNotMatch(sql,/\b(?:DROP|DELETE|UPDATE|INSERT|TRUNCATE|ALTER)\s+(?:TABLE|INTO|FROM|SCHEMA)\b/i);
 for(const file of ['staging-all-fks-source.jsonl','staging-all-fks-after-export.jsonl'])assert.ok(exp.includes(file));
 assert.ok(runner.includes('staging-all-fks-restored.jsonl'));
 assert.ok(runner.includes('check-staging-all-fk-integrity.mjs --compare'));
 assert.ok(runner.indexOf('SHADOW_STAGE=restore-data')<runner.indexOf('SHADOW_STAGE=staging-restored-all-app-fks'));
 assert.ok(runner.includes('PR359_STAGING_INPLACE_GO=FALSE'));
});
