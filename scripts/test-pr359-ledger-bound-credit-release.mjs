import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {buildSupabaseMigrationTransaction} from './supabase-migration-transaction.mjs';
import {classifySupabaseMigrationHistory,parseSupabaseMigrationHistoryRows} from './supabase-migration-target.mjs';

// Hard isolation boundary; NEVER connect this test to Staging/Production.
assert.equal(process.env.PGHOST,'127.0.0.1');
assert.equal(process.env.PGPORT,'5432');
assert.equal(process.env.PGUSER,'postgres');
assert.ok(process.env.PGPASSWORD);
assert.equal(process.env.SUPABASE_DB_URL,undefined);
assert.equal(process.env.SUPABASE_PROJECT_REF,undefined);
const version='20261103145232',name='powerhub_legacy_unlinked_payments_to_subscriber_credit';
const sql=readFileSync('supabase/migrations/'+version+'_'+name+'.sql','utf8');
const expectedHash=createHash('sha256').update(Buffer.from(sql,'utf8')).digest('hex');
const fixture=readFileSync('supabase/tests/pr359_full_legacy_backfill_setup.sql','utf8');
const verify=readFileSync('supabase/tests/pr359_full_legacy_backfill_assert.sql','utf8');
const rollback=readFileSync('supabase/tests/pr359_full_legacy_backfill_rollback_assert.sql','utf8');
const dbs=['pr359_release_ledger_success','pr359_release_ledger_failure','pr359_release_ledger_race'];
const env={...process.env,PGSSLMODE:'disable',PGCONNECT_TIMEOUT:'10'};
const args=db=>['-X','-w','-v','ON_ERROR_STOP=1','-At','-h','127.0.0.1','-p','5432','-U','postgres','-d',db];
function psql(db,query){
 const r=spawnSync('psql',args(db),{input:query,encoding:'utf8',env,maxBuffer:4*1024*1024});
 if(r.error)throw r.error;
 return {status:r.status,stdout:r.stdout||'',stderr:r.stderr||''};
}
function ok(db,query,label){
 const result=psql(db,query);
 assert.equal(result.status,0,label+': '+result.stderr.slice(-900));
 return result.stdout.trim();
}
function asyncPsql(db,query){
 return new Promise((resolve,reject)=>{
  const child=spawn('psql',args(db),{env,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.on('data',b=>{stdout+=b.toString()});
  child.stderr.on('data',b=>{stderr+=b.toString()});
  child.on('error',reject);
  child.stdin.on('error',e=>{if(e.code!=='EPIPE')reject(e)});
  child.on('close',status=>resolve({status,stdout,stderr}));
  child.stdin.end(query);
 });
}
const ledgerDDL='\nCREATE SCHEMA supabase_migrations;\n'+
 'CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY,name text NOT NULL,statements text[]);\n';
for(const db of dbs){
 const r=spawnSync('createdb',['-h','127.0.0.1','-p','5432','-U','postgres',db],
  {encoding:'utf8',env});
 assert.equal(r.status,0,'createdb failed: '+db+' '+(r.stderr||'').slice(-400));
 ok(db,fixture+ledgerDDL,'fixture setup');
}
const historySQL="SELECT version || '|' || name || '|' || CASE WHEN statements IS NULL OR cardinality(statements)=0 THEN 'unavailable' ELSE encode(sha256(convert_to(array_to_string(statements,chr(10)),'UTF8')),'hex') END FROM supabase_migrations.schema_migrations ORDER BY version;";
const history=db=>parseSupabaseMigrationHistoryRows(ok(db,historySQL,'read ledger'));
const proof=db=>ok(db,verify,'financial ledger and audit integrity');
const tx=buildSupabaseMigrationTransaction({version,name,sql});

// Exact SQL, actual release transaction and exact retained SQL bytes.
ok(dbs[0],tx,'initial release');proof(dbs[0]);
assert.deepEqual(history(dbs[0]),[{version,name,contentSha:expectedHash}]);
assert.equal(classifySupabaseMigrationHistory({version,name,contentSha:expectedHash,records:history(dbs[0])}),'already-applied');
const duplicate=psql(dbs[0],tx);
assert.notEqual(duplicate.status,0,'Second direct release should fail closed');
assert.match(duplicate.stderr,/POWERHUB_MIGRATION_VERSION_RACE/);
proof(dbs[0]);assert.equal(history(dbs[0]).length,1);

// An error after the complete original SQL but before the ledger insert must
// roll back its financial effects, audit logs and migration history together.
const faultSql=sql+"\nDO $pr359_fault$ BEGIN RAISE EXCEPTION 'PR359_FORCED_LEDGER_BOUND_ROLLBACK'; END $pr359_fault$;\n";
const badTx=buildSupabaseMigrationTransaction({version,name,sql:faultSql});
const fault=psql(dbs[1],badTx);
assert.notEqual(fault.status,0,'Controlled failure unexpectedly succeeded');
assert.match(fault.stderr,/PR359_FORCED_LEDGER_BOUND_ROLLBACK/);
assert.equal(history(dbs[1]).length,0);
ok(dbs[1],rollback,'rollback preserved original cash and audit');
assert.equal(classifySupabaseMigrationHistory({version,name,contentSha:expectedHash,records:history(dbs[1])}),'not-applied');
ok(dbs[1],tx,'release after recovery');proof(dbs[1]);
assert.deepEqual(history(dbs[1]),[{version,name,contentSha:expectedHash}]);

// Real advisory lock: exactly one of two independent connections may commit.
const results=await Promise.all([asyncPsql(dbs[2],tx),asyncPsql(dbs[2],tx)]);
assert.equal(results.filter(r=>r.status===0).length,1,'Concurrent release must have one successful writer');
const rejected=results.find(r=>r.status!==0);
assert.match(rejected?.stderr||'',/POWERHUB_MIGRATION_VERSION_RACE/);
proof(dbs[2]);assert.deepEqual(history(dbs[2]),[{version,name,contentSha:expectedHash}]);
console.log('PR359_LEDGER_BOUND_CREDIT_RELEASE_PASS: actual builder, retained SHA, retry denial, rollback, recovery and 2-session race');
