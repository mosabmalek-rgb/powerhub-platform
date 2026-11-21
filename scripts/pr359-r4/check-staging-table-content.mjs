import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {REFERENCE_PATH, EXPECTED_TABLES, expectedTableNames} from './check-staging-table-counts.mjs';

export function parseContentAttestation(lines,reference) {
  assert.equal(typeof lines,'string');
  const expected=expectedTableNames(reference);
  const records=lines.split(/\r?\n/).filter(Boolean);
  assert.equal(records.length,EXPECTED_TABLES,'incomplete table-content coverage');
  const out=new Map();
  for(const line of records) {
    const row=JSON.parse(line);
    assert.deepEqual(Object.keys(row).sort(),['content_sha256','rows','schema','table']);
    assert.ok(typeof row.schema==='string' && typeof row.table==='string');
    assert.ok(Number.isSafeInteger(row.rows) && row.rows>=0,'invalid row count');
    assert.match(row.content_sha256,/^[a-f0-9]{64}$/,'invalid SHA-256');
    const id=JSON.stringify([row.schema,row.table]);
    assert.ok(expected.has(id),'unreviewed or missing table');
    assert.ok(!out.has(id),'duplicate table identity');
    out.set(id,{rows:row.rows,content_sha256:row.content_sha256});
  }
  assert.equal(out.size,expected.size,'missing table');
  return out;
}

export function assessContentAttestation(before,after,reference) {
  const source=parseContentAttestation(before,reference);
  const target=parseContentAttestation(after,reference);
  let countDrift=0, contentDrift=0;
  for(const [id,first] of source) {
    const other=target.get(id);
    if(first.rows!==other.rows) countDrift++;
    if(first.content_sha256!==other.content_sha256) contentDrift++;
  }
  return {
    tableCount:source.size,
    rowCountsMatch:countDrift===0,
    contentHashesMatch:contentDrift===0,
    countDrift,
    contentDrift,
    // Cross-export MVCC atomicity is NOT established by comparing checksums.
    sameExportedSnapshotProven:false,
    stagingInplaceGo:false
  };
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.equal(process.argv.length,5,'Usage: check-staging-table-content.mjs --compare source.jsonl restored.jsonl');
  assert.equal(process.argv[2],'--compare');
  const reference=JSON.parse(readFileSync(REFERENCE_PATH,'utf8'));
  const first=readFileSync(process.argv[3],'utf8');
  const second=readFileSync(process.argv[4],'utf8');
  const result=assessContentAttestation(first,second,reference);
  console.log('PR359_STAGING_CONTENT_TABLES_CHECKED='+result.tableCount);
  console.log('PR359_STAGING_APP_CONTENT_SHA256_MATCH='+result.contentHashesMatch);
  console.log('PR359_STAGING_SINGLE_CROSS_EXPORT_SNAPSHOT_NOT_PROVEN=TRUE');
  console.log('PR359_STAGING_INPLACE_GO=FALSE');
  if(!result.rowCountsMatch || !result.contentHashesMatch){
    console.error('PR359_STAGING_CONTENT_ATTESTATION_DRIFT_COUNT='+result.contentDrift);
    console.error('PR359_STAGING_CONTENT_ATTESTATION_ROW_COUNT_DRIFT='+result.countDrift);
    process.exitCode=2;
  }
}
