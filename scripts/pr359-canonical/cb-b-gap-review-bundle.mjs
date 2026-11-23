import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {auditEleven, pinnedJson} from './audit-eleven-live-gaps.mjs';

// This is a reproducible REVIEW QUEUE, not a SQL generator or a hosted change.
// Captured catalog SQL is forensic evidence; never promote it automatically.
const FN_PATH = 'docs/security/pr359-cb-a-six-function-live-evidence-20261123.json';
const TABLE_PATH = 'docs/security/pr359-cb-a-five-table-live-evidence-20261123.json';
const FN_BLOB = 'a4f3a62680874cef47149f4d908fca0ef05da354';
const TABLE_BLOB = 'df0b1d008e881a31a9bf779317109e8ccc79097b';
const FN_NAMES = [
  'p6_assert_subscription_guard',
  'p6_subscription_access_status',
  'powerhub_ensure_owner_main_site',
  'powerhub_financial_period_cash_flow_raw',
  'powerhub_mobile_touch_session',
  'powerhub_refresh_fuel_maintenance_delta_after_generator_name_up'
];
const TABLE_NAMES = [
  'emergency_requests',
  'payment_documentation_requests',
  'sms_dispatch_queue',
  'tenant_feature_entitlements',
  'tweet_sms_report_snapshots'
];
const SHA256 = /^[a-f0-9]{64}$/;
function unique(values, name) {
  const m = new Map();
  for (const row of values) {
    const key = row[name];
    assert.equal(typeof key, 'string');
    assert.ok(!m.has(key), 'duplicate ' + name + ': ' + key);
    m.set(key, row);
  }
  return m;
}
const sha256 = s => createHash('sha256').update(s, 'utf8').digest('hex');

export function buildCbBGapReviewBundle(fEvidence, tEvidence, historicalFns, historicalRelations, register, dependencyEvidence) {
  // A previously tested CB-A attestation is required before CB-B preparation.
  const attestation = auditEleven(fEvidence, tEvidence, historicalFns, historicalRelations, register);
  assert.equal(attestation.remaining_object_reviews, 978);
  assert.equal(attestation.canonical_baseline_approved, false);
  assert.equal(dependencyEvidence.root_count, 978);
  assert.equal(dependencyEvidence.entries.length, 978);
  assert.equal(dependencyEvidence.application_ownership_approved, false);
  assert.deepEqual(dependencyEvidence.destructive_allowlist, []);
  const roots = unique(register.objects, 'id');
  const dependencies = unique(dependencyEvidence.entries, 'identity');
  const fns = unique(fEvidence.functions, 'name');
  const tables = unique(tEvidence.tables, 'table_name');
  assert.deepEqual([...fns.keys()].sort(), [...FN_NAMES].sort());
  assert.deepEqual([...tables.keys()].sort(), [...TABLE_NAMES].sort());
  const makeDependency = id => {
    const r = roots.get(id), d = dependencies.get(id);
    assert.ok(r && d, 'missing canonical root/dependency: ' + id);
    assert.equal(r.reviewed, false, 'not an approved review: ' + id);
    assert.equal(r.classification, 'APP_OWNED_CANDIDATE');
    assert.equal(d.kind, r.kind);
    assert.match(d.incoming_sha256, SHA256);
    assert.match(d.outgoing_sha256, SHA256);
    assert.equal(d.unidentified_incoming, 0);
    assert.equal(d.unidentified_outgoing, 0);
    return {
      incoming_edges: d.incoming_edges,
      outgoing_edges: d.outgoing_edges,
      incoming_pg_depend_sha256: d.incoming_sha256,
      outgoing_pg_depend_sha256: d.outgoing_sha256,
      // pg_depend root digests are not a complete SQL dependency graph.
      caveat: 'ROOT_DIGEST_ONLY_NOT_DYNAMIC_SQL_OR_TRIGGER_CALL_GRAPH'
    };
  };
  const records = [];
  for (const name of FN_NAMES) {
    const fn = fns.get(name);
    assert.equal(fn.owner, 'postgres');
    assert.match(fn.sha256, SHA256);
    assert.equal(sha256(fn.executable_ddl), fn.sha256, 'function body drift: ' + name);
    assert.ok(!fn.anon_execute && !fn.authenticated_execute && fn.service_execute);
    const ids = [...roots.values()].filter(r => r.kind === 'function' && r.id.startsWith(name + '('));
    assert.equal(ids.length, 1, 'ambiguous or absent signature: ' + name);
    const id = ids[0].id;
    assert.equal(ids[0].definition_sha256, fn.sha256);
    assert.equal(ids[0].security_definer, fn.security_definer);
    records.push({
      identity: id,
      kind: 'function',
      evidence: 'READ_ONLY_LIVE_PG_GET_FUNCTIONDEF',
      exact_catalog_definition_sha256: fn.sha256,
      identity_arguments: fn.identity_args,
      security_definer: fn.security_definer,
      catalog_search_path: fn.config,
      dependency_evidence: makeDependency(id),
      blockers: [
        'HISTORICAL_CREATE_LINEAGE_UNRESOLVED',
        'SOURCE_DESIGN_AND_EXECUTABLE_SQL_NOT_APPROVED',
        'FUNCTION_BODY_AND_DYNAMIC_CALLERS_NOT_REVIEWED',
        'EXECUTE_GRANTS_AND_TENANT_ISOLATION_NOT_APPROVED',
        ...(fn.security_definer ? ['SECURITY_DEFINER_REQUIRES_INDEPENDENT_SIGNOFF'] : [])
      ],
      ddl_selected_for_execution: false,
      app_owned_approved: false
    });
  }
  for (const name of TABLE_NAMES) {
    const tbl = tables.get(name);
    assert.equal(tbl.schema_name, 'public');
    const id = 'public.' + name + '#r';
    assert.equal(roots.get(id)?.definition_sha256, null,
      'catalog structure must not be promoted as full executable DDL');
    assert.equal(tbl.rls, true);
    assert.equal(tbl.policies.length, 0);
    assert.ok(!tbl.anon_select && !tbl.authenticated_select && tbl.service_select);
    records.push({
      identity: id,
      kind: 'table',
      evidence: 'READ_ONLY_PG_CATALOG_STRUCTURE_NOT_FULL_DDL',
      catalog_shape: {
        columns: tbl.columns.length,
        constraints: tbl.constraints.length,
        indexes: tbl.indexes.length,
        triggers: tbl.triggers.length,
        direct_rls_policies: tbl.policies.length,
        rls_enabled: tbl.rls
      },
      dependency_evidence: makeDependency(id),
      blockers: [
        'HISTORICAL_CREATE_LINEAGE_UNRESOLVED',
        'COMPLETE_TABLE_DDL_AND_DEPENDENCY_ORDER_UNREVIEWED',
        'TRIGGERS_FKS_IDENTITY_AND_GRANTS_REQUIRE_REVIEW',
        'RLS_AND_EFFECTIVE_SERVICE_ROUTE_ISOLATION_NOT_APPROVED',
        'PROVIDER_MANAGED_DEPENDENCIES_NOT_APPROVED'
      ],
      ddl_selected_for_execution: false,
      app_owned_approved: false
    });
  }
  assert.equal(records.length, 11);
  assert.equal(records.filter(r => r.security_definer === true).length, 3);
  records.sort((a,b) => a.identity.localeCompare(b.identity, 'en'));
  return {
    format: 'PR359_CB_B_EVIDENCE_HANDOFF_V1',
    stage: 'CB_B_PREPARATION_NOT_EXECUTABLE',
    evidence: {
      function_source_blob_sha1: FN_BLOB,
      table_source_blob_sha1: TABLE_BLOB,
      object_count: 978,
      full_review_pending: 978,
      historical_migrations_to_replay: 0
    },
    gap_count: records.length,
    function_gap_count: 6,
    table_gap_count: 5,
    security_definer_review_count: 3,
    root_dependency_digests_are_incomplete_call_graphs: true,
    records,
    // No production command or SQL script is emitted by this utility.
    executable_sql_approved: false,
    clean_supabase_bootstrap_pass: false,
    app_owned_approved: false,
    canonical_baseline_approved: false,
    migration_epoch_v2_approved: false,
    destructive_allowlist: [],
    staging_inplace_go: false,
    production_inplace_go: false,
    pr359_merge_go: false
  };
}

export function loadCbBGapReviewInputs() {
  const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
  return [
    pinnedJson(readFileSync(FN_PATH), FN_BLOB),
    pinnedJson(readFileSync(TABLE_PATH), TABLE_BLOB),
    readJson('docs/security/pr359-r0-staging-functions-20261119.json'),
    readJson('docs/security/pr359-r0-staging-relations-20261119.json'),
    readJson('docs/security/pr359-r4-staging-object-register-20261120.json'),
    readJson('docs/security/pr359-r4-staging-root-dependency-digests-20261123.json')
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--out'),
    'Usage: node cb-b-gap-review-bundle.mjs [--out path]; NEVER --apply/--approve');
  const result = buildCbBGapReviewBundle(...loadCbBGapReviewInputs());
  if (args.length) writeFileSync(args[1], JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({
    format: result.format, gap_count: result.gap_count,
    security_definer_review_count: result.security_definer_review_count,
    executable_sql_approved: result.executable_sql_approved,
    canonical_baseline_approved: result.canonical_baseline_approved
  }));
}
