import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';

const runner=readFileSync('scripts/pr359-shadow/run.sh','utf8');
const marker='SHADOW_STAGE=staging-roles-after-export';
const position=runner.indexOf(marker);
assert.ok(position>=0,'source role drift guard must exist');
const start=runner.lastIndexOf('if [[ "$mode" == staging-restore ]]; then',position);
const end=runner.indexOf('\nfi\n',position)+4;
assert.ok(start>=0 && end>position,'source role drift guard must be independently executable');
const gate=runner.slice(start,end);

function exercise(before,after){
 const dir=mkdtempSync(join(tmpdir(),'pr359-roles-'));
 try{
  mkdirSync(join(dir,'dump'),{mode:0o700});
  writeFileSync(join(dir,'dump','roles.sql'),before,{mode:0o600});
  const code=[
   'set -euo pipefail',
   'mode=staging-restore',
   'work='+JSON.stringify(dir),
   'dump(){ [[ "$1" == roles-after.sql && "$2" == --role-only ]] || exit 87; printf "%s" "$ROLE_AFTER" > "$work/dump/roles-after.sql"; }',
   gate
  ].join('\n');
  const proc=spawnSync('bash',['-c',code],{
   encoding:'utf8',timeout:10000,env:{...process.env,ROLE_AFTER:after}});
  return {status:proc.status,stdout:proc.stdout,stderr:proc.stderr,error:proc.error};
 }finally{rmSync(dir,{recursive:true,force:true});}
}
test('identical role-only exports are accepted for isolated Staging',()=>{
 const r=exercise('CREATE ROLE example;\n','CREATE ROLE example;\n');
 assert.equal(r.status,0,r.stderr || String(r.error));
 assert.match(r.stdout,/PR359_STAGING_ROLE_REEXPORT_PARITY_PASS/);
});
test('equal-length change in role privileges is rejected even if counts match',()=>{
 const r=exercise('ALTER ROLE local_user NOLOGIN;\n','ALTER ROLE local_user LOGIN  ;\n');
 assert.equal(r.status,1,r.stderr||String(r.error));
 assert.match(r.stderr,/PR359_STAGING_ROLE_METADATA_DRIFT_DURING_EXPORT/);
});
test('missing or empty second export fails closed',()=>{
 const r=exercise('CREATE ROLE example;\n','');
 assert.equal(r.status,1,r.stderr);
});
test('production retains its independent, original exporter',()=>{
 assert.match(runner,/dump roles.sql --role-only/);
 assert.match(runner,/dump schema.sql/);
 assert.match(runner,/dump data.sql --data-only --use-copy/);
 assert.match(runner,/dump history-schema.sql --schema supabase_migrations/);
 assert.match(runner,/PR359_STAGING_INPLACE_GO=FALSE/);
});
