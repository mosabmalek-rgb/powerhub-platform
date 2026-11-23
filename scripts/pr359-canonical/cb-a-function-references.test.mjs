import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFunctionDependencyEvidence, explicitSqlReferences
} from './cb-a-function-references.mjs';
import {loadCbBGapReviewInputs} from './cb-b-gap-review-bundle.mjs';

const fixture = () => structuredClone(loadCbBGapReviewInputs());

test('six pinned functions have eleven catalog-qualified references, with no approval', () => {
  const a = buildFunctionDependencyEvidence(...fixture());
  const b = buildFunctionDependencyEvidence(...fixture());
  assert.deepEqual(a,b);
  assert.equal(a.functions_scanned,6);
  assert.equal(a.direct_qualified_mentions,11);
  assert.equal(a.relation_mentions,9);
  assert.equal(a.function_mentions,2);
  assert.equal(a.security_definer_functions,3);
  assert.equal(a.captured_test_fixture_function_count,1);
  assert.equal(a.full_runtime_caller_review_complete,false);
  assert.equal(a.function_security_signoff_complete,false);
  assert.equal(a.app_owned_approved,false);
  assert.equal(a.executable_canonical_sql_approved,false);
  assert.equal(a.clean_bootstrap_pass,false);
  assert.equal(a.staging_inplace_go,false);
  assert.equal(a.production_inplace_go,false);
  assert.equal(a.pr359_merge_go,false);
  assert.deepEqual(a.destructive_allowlist,[]);
  const mobile=a.references.find(x=>x.function_identity.startsWith('powerhub_mobile_touch_session('));
  assert.ok(mobile.security_definer);
  assert.ok(mobile.contains_explicit_advisory_lock);
  assert.ok(mobile.contains_update_statement);
  const owner=a.references.find(x=>x.function_identity.startsWith('powerhub_ensure_owner_main_site('));
  assert.ok(owner.contains_insert_statement);
  assert.equal(a.references.filter(x=>x.contains_dynamic_execute_lexeme).length,0);
});

test('source changes, missing catalog roots, ambiguous signatures fail closed',()=>{
  const mutations=[
    x=>{x[0].functions[0].executable_ddl=x[0].functions[0].executable_ddl.replace('public.tenants','public.unreviewed_object')},
    x=>{x[0].functions[0].executable_ddl+='\n'},
    x=>{x[4].objects=x[4].objects.filter(o=>o.id!=='public.mobile_api_sessions#r')},
    x=>{x[4].objects.find(o=>o.id==='public.mobile_api_sessions#r').reviewed=true},
    x=>{x[5].entries=x[5].entries.filter(o=>o.identity!=='public.mobile_api_sessions#r')},
    x=>{x[0].functions[4].security_definer=false}
  ];
  for(const mutate of mutations) {
    const x=fixture();mutate(x);
    assert.throws(()=>buildFunctionDependencyEvidence(...x));
  }
});

test('qualified name scan is intentionally lexical not executable call attribution',()=>{
  const sample=`CREATE OR REPLACE FUNCTION public.fake()
RETURNS int LANGUAGE sql AS $function$
-- public.in_a_comment
SELECT 1 /* public.in_comment_too */;
$function$`;
  assert.deepEqual(explicitSqlReferences(sample),['public.in_a_comment','public.in_comment_too']);
  assert.throws(()=>explicitSqlReferences('CREATE FUNCTION broken'));
});
