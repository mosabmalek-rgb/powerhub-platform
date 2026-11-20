import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,readFileSync as read,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const source=readFileSync('scripts/pr359-r4/staging-atomic-export.sh','utf8');
const start=source.indexOf('dump_data(){');
const end=source.indexOf('\ndump_schema schema.sql',start);
assert.ok(start>=0 && end>start,'dump_data function definition must be isolated');
const fn=source.slice(start,end);

function exercise(behavior){
 const dir=mkdtempSync(join(tmpdir(),'pr359-dump-fault-'));
 try {
   const code=[
     'set -euo pipefail',
     'dumpdir='+JSON.stringify(dir),
     'pgdump(){ '+behavior+'; }',
     fn,
     'dump_data synthetic.sql'
   ].join('\n');
   const r=spawnSync('bash',['-c',code],{encoding:'utf8',timeout:10000});
   let contents='';
   try{contents=read(join(dir,'synthetic.sql'),'utf8');}catch{}
   return {status:r.status,stdout:r.stdout,stderr:r.stderr,contents,error:r.error};
 }finally{rmSync(dir,{recursive:true,force:true})}
}

test('nonzero pg_dump exit is a hard failure even if a header was written',()=>{
 const r=exercise('printf "PARTIAL_DATA\\n"; return 71');
 assert.equal(r.status,1,r.stderr);
 assert.match(r.stderr,/PR359_STAGING_ATOMIC_DATA_DUMP_FAILED=synthetic.sql/);
 assert.match(r.contents,/SET session_replication_role/);
 assert.doesNotMatch(r.contents,/RESET ALL/);
});
test('success writes complete data with session reset',()=>{
 const r=exercise('printf "INSERT INTO synthetic VALUES (1);\\n"');
 assert.equal(r.status,0,r.stderr);
 assert.match(r.contents,/SET session_replication_role/);
 assert.match(r.contents,/INSERT INTO synthetic VALUES \(1\)/);
 assert.match(r.contents,/RESET ALL/);
});
test('transformed pg_dump failure cannot be hidden by successful sed',()=>{
 const r=exercise('printf "already printed"; return 27');
 assert.notEqual(r.status,0);
 assert.doesNotMatch(r.contents,/RESET ALL/);
});
