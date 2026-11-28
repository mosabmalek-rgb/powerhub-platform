import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ORDERED_FINANCE,renderShadowTransactions} from './render.mjs';
test('real financial source produces ordered ledger-bound transactions and post-SQL fault',()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'ph359-render-'));
 try {
  const rows=renderShadowTransactions({outputDir:dir});
  assert.equal(rows.length,4);
  assert.deepEqual(rows.map(r=>r.version),ORDERED_FINANCE.map(r=>r[0]));
  for(const r of rows){
   const s=readFileSync(path.join(dir,r.filename),'utf8');
   assert.match(s,/BEGIN ISOLATION LEVEL READ COMMITTED;/);
   assert.match(s,/POWERHUB_MIGRATION_VERSION_RACE/);
   assert.match(s,/INSERT INTO supabase_migrations.schema_migrations/);
   assert.match(s,/COMMIT;\s*$/);
  }
  const f=readFileSync(path.join(dir,'2-fault.sql'),'utf8');
  assert.ok(f.indexOf('PR359_DOCKER_SHADOW_EXPECTED_FAILURE')<f.indexOf('INSERT INTO supabase_migrations.schema_migrations'));
 } finally {rmSync(dir,{recursive:true,force:true});}
});
