import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildReviewMatrix} from './pr359-historical-review-matrix.mjs';

const reports=JSON.parse(readFileSync('docs/security/pr359-migration-history-crosswalk-20261108.json','utf8'));
const live=JSON.parse(readFileSync('docs/security/pr359-phase1-live-ledger-snapshot-20261117.json','utf8'));

test('every historical mismatch group is present, source-pinned and non-releasable',()=>{
 const report=buildReviewMatrix(reports,live);
 assert.equal(report.groupsCount,28);
 assert.equal(report.priorities.P0+report.priorities.P1,28);
 assert.ok(report.distinctSources>=28);
 assert.match(report.releaseDecision,/^NO_GO_/);
 assert.equal(report.shadowUpgrade,'NOT_TESTED');
 assert.ok(report.groups.every(g=>g.status.directReplayAllowed===false));
 assert.ok(report.groups.every(g=>g.status.historicalExecutionProof==='NOT_ACCEPTED_FOR_RELEASE'));
 assert.ok(report.groups.some(g=>g.status.sourceContractStatus==='SOURCE_CONTRACT_DRIFT'));
 assert.ok(report.groups.some(g=>g.status.sourceContractStatus==='CURRENT_POLICY_DRIFT'));
});

test('historical archive tamper and missing/changed live ledger fingerprint abort review',()=>{
 const tampered=structuredClone(reports);
 tampered.records[0].staging_rows[0].stored_sql_sha256='0'.repeat(64);
 assert.throws(()=>buildReviewMatrix(tampered,live),/Archived SQL hash/);
 const altered=structuredClone(live);
 const version=reports.records[0].staging_rows[0].version;
 altered.environments.staging.rows.find(r=>r.version===version).retained_sql_sha256=null;
 assert.throws(()=>buildReviewMatrix(reports,altered),/Archived SQL hash/);
 const changed=structuredClone(reports);
 changed.records[0].source_files[0].sha256='0'.repeat(64);
 assert.throws(()=>buildReviewMatrix(changed,live),/Historical source hash/);
});

test('a new group must trigger explicit new baseline review rather than silently drop it',()=>{
 const changed=structuredClone(reports);
 changed.records.pop();
 assert.throws(()=>buildReviewMatrix(changed,live),/Expected 28 reviewed/);
});
