import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

// R4 live read-only Staging baseline (2026-11-20).
// 561 validated, MATCH SIMPLE FKs (455 single-column, 106 composite).
// This protects against unreviewed constraints being dropped from an audit.
export const EXPECTED_STAGING_APP_FKS=561;
const fields=['match','name','operator_ok','schema','table','validated','violations'];

export function parseAllFkIntegrity(value,expectedCount=EXPECTED_STAGING_APP_FKS){
 assert.equal(typeof value,'string');
 assert.ok(Number.isSafeInteger(expectedCount)&&expectedCount>0);
 const lines=value.split(/\r?\n/).filter(Boolean);
 assert.equal(lines.length,expectedCount,'R4 application FK count drift');
 const out=new Map();
 for(const line of lines){
  const row=JSON.parse(line);
  assert.deepEqual(Object.keys(row).sort(),fields,'unexpected FK audit fields');
  assert.ok(['public','private','powerhub_private'].includes(row.schema),'unreviewed FK schema');
  assert.ok(typeof row.table==='string'&&row.table.length>0);
  assert.ok(typeof row.name==='string'&&row.name.length>0);
  assert.equal(row.validated,true,'non-validated FK');
  assert.equal(row.match,'s','unsupported non-simple FK match semantics');
  assert.equal(row.operator_ok,true,'FK uses unreviewed comparison operator');
  assert.ok(Number.isSafeInteger(row.violations)&&row.violations>=0,'invalid FK violation count');
  const key=JSON.stringify([row.schema,row.table,row.name]);
  assert.ok(!out.has(key),'duplicate FK audit identity');
  out.set(key,row.violations);
 }
 assert.equal(out.size,expectedCount);
 return out;
}

export function assessAllFkIntegrity(source,restored,expectedCount=EXPECTED_STAGING_APP_FKS){
 const a=parseAllFkIntegrity(source,expectedCount);
 const b=parseAllFkIntegrity(restored,expectedCount);
 const missing=[...a.keys()].filter(key=>!b.has(key));
 const extra=[...b.keys()].filter(key=>!a.has(key));
 const drift=[...a.keys()].filter(key=>b.has(key)&&a.get(key)!==b.get(key));
 const sourceViolations=[...a.values()].reduce((sum,n)=>sum+n,0);
 const restoredViolations=[...b.values()].reduce((sum,n)=>sum+n,0);
 return {
  checked:expectedCount,
  clean:missing.length===0&&extra.length===0&&drift.length===0&&sourceViolations===0&&restoredViolations===0,
  missing,extra,drift,sourceViolations,restoredViolations,
  stagingInplaceGo:false,appOwnedApproved:false
 };
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 assert.equal(process.argv.length,5,'Usage: check-staging-all-fk-integrity.mjs --compare source.jsonl restored.jsonl');
 assert.equal(process.argv[2],'--compare');
 const a=assessAllFkIntegrity(readFileSync(process.argv[3],'utf8'),readFileSync(process.argv[4],'utf8'));
 console.log('PR359_STAGING_APP_FK_CONSTRAINTS_CHECKED='+a.checked);
 console.log('PR359_STAGING_APP_FK_INTEGRITY='+a.clean);
 console.log('PR359_STAGING_INPLACE_GO=FALSE');
 if(!a.clean){console.error('PR359_STAGING_APP_FK_INTEGRITY_DRIFT_OR_ORPHANS');process.exitCode=2;}
}
