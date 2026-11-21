import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {classifyFile,buildCrosswalk,validateSnapshot} from './pr359-full-ledger-crosswalk.mjs';
const sha=sql=>createHash('sha256').update(sql).digest('hex');
const file={filename:'20261117000000_example.sql',sha256:sha('select 1;\n')};
const row=(version='20261117000000',name='example',retained_sql_sha256=file.sha256)=>({version,name,retained_sql_sha256});
test('migration decision is source-hash and identity aware, always non-releasable',()=>{
 const cases=[
 [[row()],1,'EXACT_SQL_HISTORY_MATCH'],
 [[row(undefined,undefined,null)],1,'UNPROVEN_STORED_SQL'],
 [[row(undefined,undefined,sha('select 2;'))],1,'DIVERGENT_STORED_SQL'],
 [[row(undefined,'other')],1,'VERSION_NAME_CONFLICT'],
 [[row('20261116000000')],1,'SAME_NAME_DIFFERENT_VERSION'],
 [[row('20261116000000'),row('20261115000000')],1,'MULTIPLE_HISTORIC_VERSIONS'],
 [[],1,'NO_DIRECT_LEDGER_MATCH'],
 [[],2,'SOURCE_VERSION_COLLISION']
 ];
 for(const [rows,count,status] of cases){const v=classifyFile(file,rows,count);assert.equal(v.status,status);assert.equal(v.releasable,false);}
});
test('full inventory hashes exact SQL bytes without authorizing missing or legacy replay',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'pr359-full-crosswalk-'));
 try{
  const dir=path.join(root,'supabase/migrations');mkdirSync(dir,{recursive:true});
  writeFileSync(path.join(dir,file.filename),'select 1;\n');
  writeFileSync(path.join(dir,'20261117000001_new.sql'),'select 2;\n');
  writeFileSync(path.join(dir,'0060_legacy.sql'),'select 3;\n');
  const snapshot={schemaVersion:1,sourceBaselineCommit:'a'.repeat(40),shadowUpgrade:'NOT_TESTED',
   releaseDecision:'NO_GO_TEST',environments:{
    staging:{rows:[row(),row('20261117000001','new',null)],count:2,unavailable:1},
    production:{rows:[row(undefined,undefined,null)],count:1,unavailable:1}}};
  const result=buildCrosswalk(snapshot,{repositoryRoot:root});
  assert.equal(result.sourceFileCount,3);
  assert.equal(result.canonicalFileCount,2);
  assert.equal(result.noncanonicalFileCount,1);
  assert.equal(result.totals.staging.EXACT_SQL_HISTORY_MATCH,1);
  assert.equal(result.totals.staging.UNPROVEN_STORED_SQL,1);
  assert.equal(result.totals.production.UNPROVEN_STORED_SQL,1);
  assert.equal(result.totals.production.NO_DIRECT_LEDGER_MATCH,1);
  assert.equal(result.totals.staging.NONCANONICAL_SOURCE,1);
  assert.ok(result.records.every(r=>Object.values(r.environments).every(x=>!x.releasable)));
  assert.throws(()=>validateSnapshot({...snapshot,shadowUpgrade:'PASS'}),/not an approval/);
  writeFileSync(path.join(dir,file.filename),'select 9;\n');
  const drift=buildCrosswalk(snapshot,{repositoryRoot:root});
  assert.equal(drift.totals.staging.DIVERGENT_STORED_SQL,1);
 }finally{rmSync(root,{recursive:true,force:true});}
});
