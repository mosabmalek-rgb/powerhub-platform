import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {buildCbBGapReviewBundle, loadCbBGapReviewInputs} from './cb-b-gap-review-bundle.mjs';

// Scans ONLY explicitly schema-qualified identifiers in SHA-verified live
// function bodies. Evidence for manual CB-A review; not an SQL parser,
// dependency proof, security signoff, executable baseline or migration.
const EXPECTED = Object.freeze({
  p6_assert_subscription_guard: [
    'public.p6_subscription_access_status', 'public.tenants'
  ],
  p6_subscription_access_status: [
    'public.tenant_subscriptions'
  ],
  powerhub_ensure_owner_main_site: [
    'public.sites', 'public.staff_profiles', 'public.tenant_members'
  ],
  powerhub_financial_period_cash_flow_raw: [
    'public.account_transactions'
  ],
  powerhub_mobile_touch_session: [
    'public.mobile_api_sessions'
  ],
  powerhub_refresh_fuel_maintenance_delta_after_generator_name_up: [
    'public.generator_fuel_events', 'public.generator_maintenance_work_orders',
    'public.powerhub_emit_fuel_maintenance_delta_sync_change'
  ]
});

function bodyOf(ddl) {
  const chunks = ddl.split('$function$');
  assert.equal(chunks.length, 3, 'unexpected dollar quote delimiter');
  assert.ok(chunks[0].includes('CREATE OR REPLACE FUNCTION public.'));
  return chunks[1];
}

export function explicitSqlReferences(ddl) {
  const body = bodyOf(ddl);
  // This is deliberately a conservative *lexical* scan, including possible
  // mentions in comments/strings. Never claim the list is an executed call graph.
  const mentions = [...body.matchAll(/\b(public|private)\.([a-z_][a-z0-9_]*)\b/gi)]
    .map(m => m[1].toLowerCase() + '.' + m[2].toLowerCase());
  return [...new Set(mentions)].sort();
}

export function buildFunctionDependencyEvidence(...args) {
  const [functions, _tables, _historicFns, _historicRels, register, roots] = args;
  const queue = buildCbBGapReviewBundle(...args);
  assert.equal(queue.canonical_baseline_approved, false);
  const byId = new Map();
  for (const root of register.objects) {
    assert.ok(!byId.has(root.id), 'duplicate root: ' + root.id);
    byId.set(root.id, root);
  }
  const deps = new Map();
  for (const dep of roots.entries) {
    assert.ok(!deps.has(dep.identity), 'duplicate dependency: ' + dep.identity);
    deps.set(dep.identity, dep);
  }
  assert.equal(deps.size, 978);
  assert.equal(byId.size, 978);
  const calls = [];
  for (const fn of functions.functions) {
    assert.ok(Object.hasOwn(EXPECTED, fn.name), 'unknown reviewed function');
    const references = explicitSqlReferences(fn.executable_ddl);
    assert.deepEqual(references, [...EXPECTED[fn.name]].sort(),
      'pinned direct SQL name evidence changed: ' + fn.name);
    const caller = queue.records.find(x => x.kind === 'function' &&
      x.identity.startsWith(fn.name + '('));
    assert.ok(caller && caller.exact_catalog_definition_sha256 === fn.sha256);
    const edges = [];
    for (const qualified of references) {
      const [schema, name] = qualified.split('.');
      const r = register.objects.filter(obj =>
        (obj.kind === 'function' && obj.schema === schema &&
          obj.id.startsWith(name + '(')) ||
        (obj.kind === 'relation' && obj.id.startsWith(qualified + '#'))
      );
      assert.equal(r.length, 1,
        'missing or ambiguous registered dependency ' + fn.name + ' -> ' + qualified);
      const root = r[0];
      assert.equal(root.reviewed, false);
      assert.equal(root.classification, 'APP_OWNED_CANDIDATE');
      assert.ok(deps.has(root.id), 'missing catalog dependency digest ' + root.id);
      edges.push({
        lexical_target: qualified,
        registered_target_identity: root.id,
        target_kind: root.kind,
        target_reviewed: false,
        static_reference_only: true
      });
    }
    const body = bodyOf(fn.executable_ddl);
    calls.push({
      function_identity: caller.identity,
      definition_sha256: fn.sha256,
      security_definer: fn.security_definer,
      configured_search_path: fn.config,
      direct_schema_qualified_lexical_mentions: edges,
      contains_test_tenant_marker: body.includes('__p6-test-tenant-a__'),
      contains_update_statement: /\bUPDATE\s+public\./i.test(body),
      contains_insert_statement: /\bINSERT\s+INTO\s+public\./i.test(body),
      contains_explicit_advisory_lock: /\bpg_advisory_xact_lock\s*\(/i.test(body),
      contains_dynamic_execute_lexeme: /\bEXECUTE\b/i.test(body),
      // pg_depend misses many PL/pgSQL run-time references. This is not
      // exhaustive caller discovery or a grant/RLS proof.
      executable_dependency_graph_approved: false,
      security_and_tenant_isolation_approved: false,
      function_review_approved: false
    });
  }
  calls.sort((a,b) => a.function_identity.localeCompare(b.function_identity, 'en'));
  assert.equal(calls.length, 6);
  assert.equal(calls.filter(x => x.security_definer).length, 3);
  assert.equal(calls.reduce((n,x) => n+x.direct_schema_qualified_lexical_mentions.length,0), 11);
  assert.equal(calls.filter(x => x.contains_test_tenant_marker).length,1);
  assert.equal(calls.filter(x => x.contains_explicit_advisory_lock).length,1);
  const targets = calls.flatMap(x => x.direct_schema_qualified_lexical_mentions);
  assert.equal(targets.filter(x => x.target_kind === 'relation').length,9);
  assert.equal(targets.filter(x => x.target_kind === 'function').length,2);
  return {
    format: 'PR359_CB_A_SIX_FUNCTION_REFERENCE_CANDIDATES_V1',
    source: 'PINNED_LIVE_FUNCTION_BODY_AND_R4_ROOT_REGISTER',
    warning: 'Qualified lexical references are candidates only, NOT an executed SQL or trigger call graph.',
    functions_scanned:6,
    direct_qualified_mentions:11,
    relation_mentions:9,
    function_mentions:2,
    security_definer_functions:3,
    captured_test_fixture_function_count:1,
    references:calls,
    missing_historical_create_lineage:6,
    full_runtime_caller_review_complete:false,
    function_security_signoff_complete:false,
    app_owned_approved:false,
    executable_canonical_sql_approved:false,
    clean_bootstrap_pass:false,
    staging_inplace_go:false,
    production_inplace_go:false,
    pr359_merge_go:false,
    destructive_allowlist:[]
  };
}

if (process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const params = process.argv.slice(2);
  assert.ok(params.length === 0 || (params.length === 2 && params[0] === '--out'),
    'Usage: node cb-a-function-references.mjs [--out local-output.json]');
  const report = buildFunctionDependencyEvidence(...loadCbBGapReviewInputs());
  if (params.length) writeFileSync(params[1], JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({
    format:report.format, functions:report.functions_scanned,
    edges:report.direct_qualified_mentions,
    security_definers:report.security_definer_functions,
    approved:report.executable_canonical_sql_approved
  }));
}
