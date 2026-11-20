import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

export const REFERENCE_PATH='docs/security/pr359-r0-staging-relations-20261119.json';
export const EXPECTED_TABLES=183;
export function expectedTableNames(reference){
 assert.equal(reference?.format,'R0 relations inventory v1');
 assert.equal(reference.project_ref,'iyuryuhaylhisjfcrwkz');
 const refs=reference.objects.filter(x=>x.kind==='r'||x.kind==='p');
 assert.equal(refs.length,EXPECTED_TABLES);
 const seen=new Set();
 for(const x of refs){
   assert.ok(['public','private','powerhub_private'].includes(x.schema));
   const id=JSON.stringify([x.schema,x.name]);
   assert.ok(!seen.has(id),'duplicate expected table');
   seen.add(id);
 }
 return seen;
}
export function parseTableCounts(jsonLines,reference){
 assert.equal(typeof jsonLines,'string');
 const expected=expectedTableNames(reference);
 const out=new Map();
 const lines=jsonLines.split(/\r?\n/).filter(Boolean);
 assert.equal(lines.length,EXPECTED_TABLES,'unexpected count of table entries');
 for(const line of lines){
   const r=JSON.parse(line);
   assert.deepEqual(Object.keys(r).sort(),['rows','schema','table']);
   assert.ok(typeof r.schema==='string'&&typeof r.table==='string');
   assert.ok(Number.isSafeInteger(r.rows)&&r.rows>=0,'invalid row count');
   const id=JSON.stringify([r.schema,r.table]);
   assert.ok(expected.has(id),'unreviewed or missing table identity');
   assert.ok(!out.has(id),'duplicate table');
   out.set(id,r.rows);
 }
 assert.equal(out.size,expected.size);
 return out;
}
export function assessStagingTableCounts(before,after,reference){
 const first=parseTableCounts(before,reference);
 const second=parseTableCounts(after,reference);
 const mismatches=[];
 for(const [id,n] of first){
   if(second.get(id)!==n) mismatches.push(id);
 }
 return {
   exactTableSet:true,
   countMatch:mismatches.length===0,
   mismatchCount:mismatches.length,
   tableCount:first.size,
   // Counts alone do not prove equality of individual row contents.
   rowContentIntegrityVerified:false,
   atomicCrossDatabaseSnapshot:false,
   stagingInplaceGo:false,
 };
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 assert.equal(process.argv.length,5,'Usage: check-staging-table-counts.mjs --compare before.jsonl after.jsonl');
 assert.equal(process.argv[2],'--compare');
 const before=readFileSync(process.argv[3],'utf8'),after=readFileSync(process.argv[4],'utf8');
 const reference=JSON.parse(readFileSync(REFERENCE_PATH,'utf8'));
 const result=assessStagingTableCounts(before,after,reference);
 console.log('PR359_STAGING_APP_TABLE_COUNTS_MATCH='+result.countMatch);
 console.log('PR359_STAGING_TABLES_CHECKED='+result.tableCount);
 console.log('PR359_STAGING_APP_ROW_CONTENT_PARITY_NOT_PROVEN=TRUE');
 console.log('PR359_STAGING_INPLACE_GO=FALSE');
 if(!result.countMatch) {
   console.error('PR359_STAGING_APP_TABLE_COUNT_DRIFT_COUNT='+result.mismatchCount);
   process.exitCode=2;
 }
}
