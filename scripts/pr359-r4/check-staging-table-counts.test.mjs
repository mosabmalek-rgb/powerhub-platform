import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
 expectedTableNames,parseTableCounts,assessStagingTableCounts,EXPECTED_TABLES,REFERENCE_PATH
} from './check-staging-table-counts.mjs';

const reference=()=>JSON.parse(readFileSync(REFERENCE_PATH,'utf8'));
const fixture=()=>[...expectedTableNames(reference())].map((id,i)=>{
 const [schema,table]=JSON.parse(id); return JSON.stringify({schema,table,rows:i%7});
}).join('\n')+'\n';
test('the source R0 inventory enumerates exactly 183 application tables',()=>{
 assert.equal(expectedTableNames(reference()).size,EXPECTED_TABLES);
 const s=readFileSync('scripts/pr359-r4/staging-table-counts.sql','utf8');
 assert.match(s,/BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;/);
 assert.match(s,/format\(/);
 assert.match(s,/%I\.%I/);
 assert.match(s,/\\gexec/);
 assert.match(s,/AND NOT c\.relispartition/);
 assert.doesNotMatch(s,/\b(DROP|DELETE|UPDATE|INSERT|TRUNCATE|ALTER)\s+(?:TABLE|INTO|FROM|SCHEMA)\b/i);
});
test('valid snapshots compare equal but cannot grant R4 approval',()=>{
 const v=fixture();
 const result=assessStagingTableCounts(v,v,reference());
 assert.equal(result.countMatch,true);
 assert.equal(result.tableCount,183);
 assert.equal(result.stagingInplaceGo,false);
 assert.equal(result.rowContentIntegrityVerified,false);
 assert.equal(result.atomicCrossDatabaseSnapshot,false);
});
test('single-table count drift fails even when the total overall count is unchanged',()=>{
 const lines=fixture().trim().split('\n'),a=JSON.parse(lines[0]),b=JSON.parse(lines[1]);
 const before=a.rows+b.rows;
 a.rows++;b.rows=before-a.rows;
 lines[0]=JSON.stringify(a);lines[1]=JSON.stringify(b);
 const result=assessStagingTableCounts(fixture(),lines.join('\n')+'\n',reference());
 assert.equal(result.countMatch,false);
 assert.equal(result.mismatchCount,2);
});
test('duplicate, omitted, unknown and invalid table entries are rejected',()=>{
 const source=fixture().trim().split('\n');
 assert.throws(()=>parseTableCounts(source.slice(1).join('\n'),reference()));
 const dup=[...source];dup[0]=dup[1];
 assert.throws(()=>parseTableCounts(dup.join('\n'),reference()));
 const extra=[...source];extra[0]=JSON.stringify({schema:'auth',table:'users',rows:0});
 assert.throws(()=>parseTableCounts(extra.join('\n'),reference()));
 const invalid=[...source];invalid[0]=JSON.stringify({...JSON.parse(invalid[0]),rows:-1});
 assert.throws(()=>parseTableCounts(invalid.join('\n'),reference()));
});
test('read-only SQL and checks run only inside explicit Staging restore mode',()=>{
 const shell=readFileSync('scripts/pr359-shadow/run.sh','utf8');
 assert.match(shell,/SHADOW_STAGE=staging-source-all-table-counts/);
 assert.match(shell,/SHADOW_STAGE=staging-source-post-export-table-counts/);
 assert.match(shell,/SHADOW_STAGE=staging-restored-table-counts/);
 assert.match(shell,/scripts\/pr359-r4\/staging-table-counts\.sql/);
 assert.match(shell,/scripts\/pr359-r4\/check-staging-table-counts\.mjs --compare/);
 const sourceStage=shell.indexOf('SHADOW_STAGE=staging-source-all-table-counts');
 const sourceUnset=shell.indexOf('unset PGOPTIONS PGSSLMODE SHADOW_SOURCE_DB_URL');
 assert.ok(sourceStage>0&&sourceStage<sourceUnset);
 assert.equal((shell.match(/SHADOW_STAGE=staging-restored-table-counts/g)||[]).length,1);
});
