import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {expectedTableNames,REFERENCE_PATH} from './check-staging-table-counts.mjs';
import {parseContentAttestation,assessContentAttestation} from './check-staging-table-content.mjs';

const ref=()=>JSON.parse(readFileSync(REFERENCE_PATH,'utf8'));
const fixture=()=>[...expectedTableNames(ref())].map((id,i)=>{
 const [schema,table]=JSON.parse(id);
 return JSON.stringify({schema,table,rows:i%7,content_sha256:'a'.repeat(64)});
}).join('\n')+'\n';

test('content attestation is read-only and includes canonicalized row SHA-256',()=>{
 const sql=readFileSync('scripts/pr359-r4/staging-table-content.sql','utf8');
 assert.match(sql,/REPEATABLE READ READ ONLY/);
 assert.match(sql,/SET LOCAL TIME ZONE 'UTC'/);
 assert.match(sql,/extensions\.digest\(to_jsonb\(t\)::text/);
 assert.match(sql,/ORDER BY encode\(extensions\.digest/);
 assert.match(sql,/\\gexec/);
 assert.doesNotMatch(sql,/\b(?:DROP|DELETE|UPDATE|INSERT|TRUNCATE|ALTER)\s+(?:TABLE|INTO|FROM|SCHEMA)\b/i);
});
test('complete equal content sets pass but cannot certify shared export snapshot',()=>{
 const s=fixture(),r=assessContentAttestation(s,s,ref());
 assert.equal(r.tableCount,183);
 assert.equal(r.rowCountsMatch,true);
 assert.equal(r.contentHashesMatch,true);
 assert.equal(r.sameExportedSnapshotProven,false);
 assert.equal(r.stagingInplaceGo,false);
});
test('same-count changed row content is detected',()=>{
 const s=fixture(),lines=s.trim().split('\n');
 const first=JSON.parse(lines[0]);
 first.content_sha256='b'.repeat(64);
 lines[0]=JSON.stringify(first);
 const r=assessContentAttestation(s,lines.join('\n')+'\n',ref());
 assert.equal(r.rowCountsMatch,true);
 assert.equal(r.contentHashesMatch,false);
 assert.equal(r.contentDrift,1);
});
test('missing, duplicated, unknown, bad SHA or bad row count is rejected',()=>{
 const lines=fixture().trim().split('\n');
 assert.throws(()=>parseContentAttestation(lines.slice(1).join('\n'),ref()));
 const dup=[...lines];dup[0]=dup[1];
 assert.throws(()=>parseContentAttestation(dup.join('\n'),ref()));
 const unknown=[...lines];unknown[0]=JSON.stringify({...JSON.parse(unknown[0]),schema:'auth'});
 assert.throws(()=>parseContentAttestation(unknown.join('\n'),ref()));
 const invalidHash=[...lines];invalidHash[0]=JSON.stringify({...JSON.parse(invalidHash[0]),content_sha256:'f'});
 assert.throws(()=>parseContentAttestation(invalidHash.join('\n'),ref()));
 const invalidRows=[...lines];invalidRows[0]=JSON.stringify({...JSON.parse(invalidRows[0]),rows:-1});
 assert.throws(()=>parseContentAttestation(invalidRows.join('\n'),ref()));
});
test('Staging workflow checks before export, after export and each restore only',()=>{
 const shell=readFileSync('scripts/pr359-shadow/run.sh','utf8');
 const stages=['staging-source-content-before-export','staging-source-content-after-export','staging-restored-table-content'];
 for(const stage of stages)assert.ok(shell.includes('SHADOW_STAGE='+stage));
 assert.equal((shell.match(/SHADOW_STAGE=staging-restored-table-content/g)||[]).length,1);
 assert.equal((shell.match(/scripts\/pr359-r4\/staging-table-content\.sql/g)||[]).length,3);
 assert.ok(shell.indexOf('SHADOW_STAGE=staging-source-content-before-export')<shell.indexOf('dump roles.sql'));
 assert.ok(shell.indexOf('SHADOW_STAGE=staging-source-content-after-export')<shell.indexOf('unset PGOPTIONS PGSSLMODE SHADOW_SOURCE_DB_URL'));
 assert.ok(shell.includes('PR359_STAGING_INPLACE_GO=FALSE'));
});
