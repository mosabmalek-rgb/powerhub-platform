import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
export const REQUIRED_MANAGED_TABLES=Object.freeze([
 ['auth','identities'],['auth','users'],['storage','buckets'],['storage','objects']
]);
const expected=new Set(REQUIRED_MANAGED_TABLES.map(x=>JSON.stringify(x)));
export function parseManagedDataFingerprint(contents){
 assert.equal(typeof contents,'string');
 const lines=contents.split(/\r?\n/).filter(Boolean);
 assert.equal(lines.length,expected.size,'managed table fingerprint coverage incomplete');
 const found=new Map();
 for(const line of lines){
  const x=JSON.parse(line);
  assert.deepEqual(Object.keys(x).sort(),['content_sha256','rows','schema','table']);
  const key=JSON.stringify([x.schema,x.table]);
  assert.ok(expected.has(key),'unreviewed managed table');
  assert.ok(!found.has(key),'duplicate managed table');
  assert.ok(Number.isSafeInteger(x.rows)&&x.rows>=0,'invalid row count');
  assert.match(x.content_sha256,/^[a-f0-9]{64}$/,'invalid fingerprint');
  found.set(key,{rows:x.rows,sha:x.content_sha256});
 }
 assert.equal(found.size,expected.size);
 return found;
}
export function assessManagedDataParity(a,b){
 const source=parseManagedDataFingerprint(a),target=parseManagedDataFingerprint(b);
 let countDrift=0,hashDrift=0;
 for(const [id,s] of source){
  const t=target.get(id);
  if(s.rows!==t.rows) countDrift++;
  if(s.sha!==t.sha) hashDrift++;
 }
 return {tableCount:source.size,rowCountsMatch:countDrift===0,
  contentMatch:hashDrift===0,countDrift,hashDrift,
  storageObjectBytesProven:false,roleSnapshotProven:false,stagingInplaceGo:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 assert.equal(process.argv.length,5,'Usage: check-staging-managed-data.mjs --compare before.jsonl after.jsonl');
 assert.equal(process.argv[2],'--compare');
 const r=assessManagedDataParity(readFileSync(process.argv[3],'utf8'),readFileSync(process.argv[4],'utf8'));
 console.log('PR359_STAGING_MANAGED_TABLES_CHECKED='+r.tableCount);
 console.log('PR359_STAGING_MANAGED_ROW_COUNTS_MATCH='+r.rowCountsMatch);
 console.log('PR359_STAGING_MANAGED_CONTENT_SHA256_MATCH='+r.contentMatch);
 console.log('PR359_STAGING_STORAGE_BLOB_BYTES_NOT_PROVEN=TRUE');
 console.log('PR359_STAGING_INPLACE_GO=FALSE');
 if(!r.rowCountsMatch||!r.contentMatch){
  console.error('PR359_STAGING_MANAGED_COUNT_DRIFT='+r.countDrift);
  console.error('PR359_STAGING_MANAGED_HASH_DRIFT='+r.hashDrift);
  process.exitCode=2;
 }
}
