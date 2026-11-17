import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const VALID_STATUSES = new Set(['UNPROVEN', 'DIVERGENT', 'EXACT_APPLIED', 'EQUIVALENT_PROVEN']);
const SOURCE_PATH = /^supabase\/migrations\/(\d{14})_([a-z0-9_]+)\.sql$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };

export function validateMigrationEvidence(snapshot, { repositoryRoot = process.cwd() } = {}) {
  assert(snapshot && snapshot.schemaVersion === 1, 'Invalid evidence schema version');
  assert(HEX40.test(snapshot.sourceHead ?? ''), 'Snapshot must pin an exact source commit');
  assert(snapshot.summary && Array.isArray(snapshot.records), 'Evidence records and summary required');
  const seen = new Set();
  const counts = { staging: 0, production: 0, stagingPreNov: 0, stagingNov: 0 };
  const resolved = [];
  for (const row of snapshot.records) {
    assert(row && ['staging', 'production'].includes(row.environment), 'Unknown evidence environment');
    assert(VALID_STATUSES.has(row.status), 'Unknown migration evidence status');
    const match = SOURCE_PATH.exec(row.sourcePath ?? '');
    assert(match && match[1] === row.ledgerVersion && match[2] === row.ledgerName,
      'Source path does not match ledger identity');
    const key = row.environment + ':' + row.ledgerVersion;
    assert(!seen.has(key), 'Duplicate ledger version in evidence');
    seen.add(key);
    const source = readFileSync(path.join(repositoryRoot, row.sourcePath));
    const calculatedSha256 = sha256(source);
    if (row.sourceSha256 != null) {
      assert(row.sourceSha256 === calculatedSha256, 'Source SHA-256 changed: ' + row.sourcePath);
    }
    assert(row.retainedSqlSha256 === null, 'This snapshot is limited to unavailable SQL payloads');
    if (row.status === 'EXACT_APPLIED') throw new Error('Absent historical SQL cannot be EXACT_APPLIED');
    if (row.status === 'EQUIVALENT_PROVEN') {
      const p = row.equivalenceEvidence;
      assert(p && HEX64.test(p.catalogReportSha256 ?? '') && HEX64.test(p.behaviorReportSha256 ?? '') &&
        typeof p.reviewReference === 'string' && p.reviewReference.trim(), 'Equivalence needs independent evidence');
    }
    counts[row.environment]++;
    if (row.environment === 'staging') {
      if (row.ledgerVersion >= '20261101000000') counts.stagingNov++;
      else counts.stagingPreNov++;
    }
    resolved.push({ ...row, sourceSha256: calculatedSha256 });
  }
  assert(counts.staging === snapshot.summary.stagingUnavailableSql, 'Staging snapshot count mismatch');
  assert(counts.production === snapshot.summary.productionUnavailableSql, 'Production snapshot count mismatch');
  assert(counts.stagingPreNov === snapshot.summary.stagingPreNovemberUnavailable, 'Older cohort count mismatch');
  assert(counts.stagingNov === snapshot.summary.stagingSinceNovemberUnavailable, 'November cohort count mismatch');
  return { counts, records: resolved, blockers: resolved.filter(r => r.status !== 'EXACT_APPLIED' && r.status !== 'EQUIVALENT_PROVEN') };
}

export function assertPhase1ReleaseReady(snapshot, result) {
  assert(result.blockers.length === 0, 'Migration reconciliation blocked by ' + result.blockers.length + ' unproven/divergent ledger rows');
  assert(snapshot.shadowUpgrade?.status === 'PASS', 'Production-derived Shadow upgrade has not passed');
  const shadow = snapshot.shadowUpgrade;
  assert(HEX64.test(shadow.restoredBaselineReportSha256 ?? '') && HEX64.test(shadow.upgradeReportSha256 ?? '') &&
    HEX64.test(shadow.repeatReportSha256 ?? '') && HEX64.test(shadow.failureRecoveryReportSha256 ?? ''),
    'Missing independent Shadow upgrade/repeat/recovery reports');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const inputPath = args.filter((a, i) => i !== outIndex + 1 && a !== '--out')
    .find(a => a.endsWith('.json') && !a.startsWith('--')) ??
    'docs/security/pr359-phase1-migration-ledger-payload-evidence-20261117.json';
  const snapshot = JSON.parse(readFileSync(inputPath, 'utf8'));
  const report = validateMigrationEvidence(snapshot);
  if (outIndex >= 0) {
    assert(args[outIndex + 1], '--out requires a file path');
    writeFileSync(args[outIndex + 1], JSON.stringify({ sourceHead: snapshot.sourceHead,
      counts: report.counts, blockers: report.blockers.length, records: report.records }, null, 2) + '\n');
  }
  console.log('Migration evidence inventory checked:', report.records.length,
    'source hashes;', report.counts.staging, 'Staging,', report.counts.production, 'Production;',
    report.blockers.length, 'historical payload cases still require independent proof.');
  if (args.includes('--require-phase1-pass')) assertPhase1ReleaseReady(snapshot, report);
}
