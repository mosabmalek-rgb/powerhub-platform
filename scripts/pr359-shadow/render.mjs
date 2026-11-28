import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {buildSupabaseMigrationTransaction} from '../supabase-migration-transaction.mjs';
export const ORDERED_FINANCE=Object.freeze([
 ['20261103131052','powerhub_subscriber_credit_ledger'],
 ['20261103131104','powerhub_subscriber_liability_and_cash_allocation'],
 ['20261103131125','powerhub_statement_operating_collection_summary'],
 ['20261103145232','powerhub_legacy_unlinked_payments_to_subscriber_credit']
]);
export function renderShadowTransactions({root=process.cwd(),outputDir,faultIndex=2}) {
 assert.ok(outputDir&&path.isAbsolute(outputDir),'Output directory must be absolute');
 assert.equal(faultIndex,2,'Only vetted fault boundary 2');
 mkdirSync(outputDir,{recursive:true,mode:0o700});
 const results=[];
 for(let i=0;i<ORDERED_FINANCE.length;i++){
  const [version,name]=ORDERED_FINANCE[i];
  const source=path.join(root,'supabase/migrations',`${version}_${name}.sql`);
  const sql=readFileSync(source,'utf8');
  assert.ok(sql.trim()&&!sql.split('\n').some(x=>x.trimStart().startsWith('\\')),'Meta-command/empty SQL blocked');
  assert.ok(!/^\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\s*;/im.test(sql),'Nested transactions blocked');
  assert.ok(!/\b(?:CREATE|DROP)\s+INDEX\s+CONCURRENTLY\b|^\s*VACUUM\b/im.test(sql),'Nontransactional SQL blocked');
  const filename=`${i+1}-apply.sql`;
  writeFileSync(path.join(outputDir,filename),buildSupabaseMigrationTransaction({version,name,sql}),{mode:0o600});
  results.push({version,name,filename});
  if(i+1===faultIndex) {
   const withFault=sql+"\nDO $pr359_shadow_failure$ BEGIN RAISE EXCEPTION 'PR359_DOCKER_SHADOW_EXPECTED_FAILURE'; END $pr359_shadow_failure$;\n";
   writeFileSync(path.join(outputDir,'2-fault.sql'),buildSupabaseMigrationTransaction({version,name,sql:withFault}),{mode:0o600});
  }
 }
 return results;
}
if(process.argv[1]&&process.argv[1].endsWith('/render.mjs')){
 const rows=renderShadowTransactions({outputDir:process.argv[2]});
 console.log('PR359_SHADOW_SQL_RENDER_PASS: '+rows.length+' transactions and one expected fault');
}
