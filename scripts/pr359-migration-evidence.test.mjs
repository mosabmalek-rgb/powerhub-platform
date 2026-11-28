import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateMigrationEvidence, assertPhase1ReleaseReady } from './pr359-migration-evidence.mjs';

test('unavailable SQL never grants proof, and a source edit invalidates a pinned SHA', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pr359-evidence-'));
  const source = 'supabase/migrations/20261110000000_synthetic.sql';
  try {
    mkdirSync(path.join(root, 'supabase/migrations'), { recursive: true });
    writeFileSync(path.join(root, source), 'select 1;\n');
    const sha = createHash('sha256').update('select 1;\n').digest('hex');
    const row = { environment: 'staging', ledgerVersion: '20261110000000', ledgerName: 'synthetic',
      sourcePath: source, sourceSha256: sha, retainedSqlSha256: null, status: 'UNPROVEN' };
    const snapshot = { schemaVersion: 1, sourceHead: 'a'.repeat(40),
      summary: { stagingUnavailableSql: 1, productionUnavailableSql: 0,
        stagingPreNovemberUnavailable: 0, stagingSinceNovemberUnavailable: 1 },
      records: [row], shadowUpgrade: { status: 'NOT_TESTED' } };
    const report = validateMigrationEvidence(snapshot, { repositoryRoot: root });
    assert.equal(report.blockers.length, 1);
    assert.throws(() => assertPhase1ReleaseReady(snapshot, report), /unproven\/divergent/);
    assert.throws(() => validateMigrationEvidence({ ...snapshot,
      records: [{ ...row, status: 'EXACT_APPLIED' }] }, { repositoryRoot: root }), /cannot be EXACT_APPLIED/);
    assert.throws(() => validateMigrationEvidence({ ...snapshot,
      records: [{ ...row, status: 'EQUIVALENT_PROVEN' }] }, { repositoryRoot: root }), /independent evidence/);
    assert.throws(() => validateMigrationEvidence({ ...snapshot,
      records: [{ ...row, sourceSha256: '0'.repeat(64) }] }, { repositoryRoot: root }), /SHA-256 changed/);
    assert.throws(() => validateMigrationEvidence({ ...snapshot,
      records: [row, row] }, { repositoryRoot: root }), /Duplicate ledger version/);
    assert.throws(() => validateMigrationEvidence({ ...snapshot,
      records: [{ ...row, sourcePath: '../secret.sql' }] }, { repositoryRoot: root }), /Source path/);
    writeFileSync(path.join(root, source), 'select 2;\n');
    assert.throws(() => validateMigrationEvidence(snapshot, { repositoryRoot: root }), /SHA-256 changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
