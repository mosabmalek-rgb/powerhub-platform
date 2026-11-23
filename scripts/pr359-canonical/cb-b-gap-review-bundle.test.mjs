import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCbBGapReviewBundle, loadCbBGapReviewInputs
} from './cb-b-gap-review-bundle.mjs';

const input = () => structuredClone(loadCbBGapReviewInputs());

test('Eleven source gaps generate a deterministic, non-executable CB-B review bundle', () => {
  const actual = buildCbBGapReviewBundle(...input());
  const again = buildCbBGapReviewBundle(...input());
  assert.deepEqual(actual, again);
  assert.equal(actual.stage, 'CB_B_PREPARATION_NOT_EXECUTABLE');
  assert.equal(actual.gap_count, 11);
  assert.equal(actual.function_gap_count, 6);
  assert.equal(actual.table_gap_count, 5);
  assert.equal(actual.security_definer_review_count, 3);
  assert.equal(actual.records.length, 11);
  assert.equal(new Set(actual.records.map(x => x.identity)).size, 11);
  for (const record of actual.records) {
    assert.equal(record.app_owned_approved, false);
    assert.equal(record.ddl_selected_for_execution, false);
    assert.ok(record.blockers.length >= 4);
    assert.ok(record.dependency_evidence);
  }
  assert.equal(actual.executable_sql_approved, false);
  assert.equal(actual.app_owned_approved, false);
  assert.equal(actual.canonical_baseline_approved, false);
  assert.equal(actual.migration_epoch_v2_approved, false);
  assert.equal(actual.staging_inplace_go, false);
  assert.equal(actual.production_inplace_go, false);
  assert.equal(actual.pr359_merge_go, false);
  assert.deepEqual(actual.destructive_allowlist, []);
  assert.equal(actual.evidence.full_review_pending, 978);
  assert.equal(actual.evidence.historical_migrations_to_replay, 0);
});

test('Altered catalog function identity, source or privilege fails closed', () => {
  const changes = [
    a => { a[0].functions[0].sha256 = '0'.repeat(64); },
    a => { a[0].functions[0].executable_ddl += '\n-- tampered'; },
    a => { a[0].functions[0].authenticated_execute = true; },
    a => { a[0].functions[2].security_definer = false; },
    a => { a[0].functions.pop(); },
    a => { a[0].functions.push(structuredClone(a[0].functions[0])); },
    a => { a[4].objects.find(x => x.id === 'p6_assert_subscription_guard()').reviewed = true; }
  ];
  for (const change of changes) {
    const a = input(); change(a);
    assert.throws(() => buildCbBGapReviewBundle(...a));
  }
});

test('Modified table security, catalog shape and missing roots fail closed', () => {
  const changes = [
    a => { a[1].tables[0].rls = false; },
    a => { a[1].tables[0].anon_select = true; },
    a => { a[1].tables[0].columns[0].type = 'text'; },
    a => { a[1].tables[0].triggers.push({definition: 'CREATE TRIGGER fake'}); },
    a => { a[5].entries.pop(); },
    a => { a[5].destructive_allowlist = ['public.emergency_requests']; },
    a => { a[5].application_ownership_approved = true; },
    a => { a[5].entries.find(x => x.identity === 'public.emergency_requests#r').incoming_sha256 = 'invalid'; }
  ];
  for (const change of changes) {
    const a = input(); change(a);
    assert.throws(() => buildCbBGapReviewBundle(...a));
  }
});
