import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {pinnedJson} from './audit-eleven-live-gaps.mjs';
import {buildFunctionDependencyEvidence} from './cb-a-function-references.mjs';
import {loadCbBGapReviewInputs} from './cb-b-gap-review-bundle.mjs';

// Read-only captured evidence; not an execution plan, authorization approval,
// trigger firing test or live RPC acceptance.
export const EVIDENCE_PATH =
  'docs/security/pr359-cb-a-definer-trigger-live-evidence-20261123.json';
export const EVIDENCE_GIT_BLOB_SHA =
  '96faae9291f938d3f4ac739603e4d962a533c168';
export const MOBILE_API_BLOB_SHA =
  'b1dc71a6be81565298236c6239c56911f5c95e71';

const expected = {
  'powerhub_ensure_owner_main_site()': {
    search_path: 'search_path=public, pg_temp',
    trigger: 'trg_powerhub_owner_subscription_main_site',
    relation: 'tenant_subscriptions',
    definition: 'CREATE TRIGGER trg_powerhub_owner_subscription_main_site AFTER INSERT ON tenant_subscriptions FOR EACH ROW EXECUTE FUNCTION powerhub_ensure_owner_main_site()'
  },
  'powerhub_mobile_touch_session(bigint,bigint,bigint,timestamp with time zone)': {
    search_path: 'search_path=""', trigger: null,relation: null,definition: null
  },
  'powerhub_refresh_fuel_maintenance_delta_after_generator_name_up()': {
    search_path: 'search_path=pg_catalog, public, pg_temp',
    trigger: 'powerhub_delta_fuel_maintenance_generator_name',
    relation: 'generators',
    definition: 'CREATE TRIGGER powerhub_delta_fuel_maintenance_generator_name AFTER UPDATE OF name ON generators FOR EACH ROW EXECUTE FUNCTION powerhub_refresh_fuel_maintenance_delta_after_generator_name_up()'
  }
};
const gitBlob = data => {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data,'utf8');
  return createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
};

export function auditDefinerAttachments(capture,inputs,serverCode) {
  assert.equal(capture.format,'PR359_CB_A_THREE_DEFINER_ATTACHMENTS_STAGING_CATALOG_V1');
  assert.equal(capture.project_ref,'iyuryuhaylhisjfcrwkz');
  assert.equal(capture.capture_mode,'read-only pg_catalog SELECT');
  assert.equal(capture.entries.length,3);
  assert.equal(capture.schema_object_approvals,0);
  assert.equal(capture.complete_runtime_graph_approved,false);
  assert.equal(capture.canonical_baseline_approved,false);
  assert.equal(capture.executable_sql_approved,false);
  assert.equal(capture.staging_inplace_go,false);
  assert.equal(capture.production_inplace_go,false);
  assert.equal(capture.pr359_merge_go,false);
  assert.deepEqual(capture.destructive_allowlist,[]);
  assert.equal(gitBlob(serverCode),MOBILE_API_BLOB_SHA,
    'mobile-api.ts code drift: refresh independent review, do not infer no RPC');
  const catalog=buildFunctionDependencyEvidence(...inputs);
  const registered=new Map(catalog.references.map(x=>[x.function_identity,x]));
  assert.equal(registered.size,6);
  const byId=new Map();
  for(const entry of capture.entries) {
    assert.equal(Object.hasOwn(expected,entry.function_identity),true,'unrecognized function');
    assert.ok(!byId.has(entry.function_identity),'duplicate definer identity');
    byId.set(entry.function_identity,entry);
    assert.equal(entry.security_definer,true,'security definer drift');
    assert.equal(entry.anon_execute,false,'anon EXECUTE privilege drift');
    assert.equal(entry.authenticated_execute,false,'authenticated EXECUTE privilege drift');
    assert.equal(entry.service_execute,true,'service_role EXECUTE privilege drift');
    const e=expected[entry.function_identity];
    assert.equal(entry.configured_search_path,e.search_path,'search_path drift');
    assert.equal(entry.trigger_name,e.trigger,'trigger name drift');
    assert.equal(entry.trigger_relation,e.relation,'trigger relation drift');
    assert.equal(entry.trigger_definition,e.definition,'trigger definition drift');
    if(e.trigger===null) {
      assert.equal(entry.trigger_enabled,null,'unexpected direct trigger binding');
    } else {
      assert.equal(entry.trigger_enabled,'O','trigger disabled or different state');
    }
    const root=registered.get(entry.function_identity);
    assert.ok(root,'function not present in pinned catalog');
    assert.equal(root.security_definer,true);
    assert.deepEqual(root.configured_search_path,[e.search_path]);
  }
  assert.equal(byId.size,3);
  const mainSite=byId.get('powerhub_ensure_owner_main_site()');
  const mobile=byId.get('powerhub_mobile_touch_session(bigint,bigint,bigint,timestamp with time zone)');
  const fuel=byId.get('powerhub_refresh_fuel_maintenance_delta_after_generator_name_up()');
  assert.ok(mainSite && mobile && fuel);
  // A scoped conditional UPDATE exists in this pinned TypeScript source;
  // absence of a direct RPC name in this one file does NOT prove the function
  // is unused from another route, trigger, dynamic SQL or external system.
  assert.match(serverCode,/\.from\("mobile_api_sessions"\)/);
  assert.match(serverCode,/\.eq\("user_id", userId\)/);
  assert.match(serverCode,/\.eq\("tenant_id", payload.tenantId\)/);
  assert.match(serverCode,/\.is\("revoked_at", null\)/);
  assert.match(serverCode,/\.gt\("expires_at", touchedAt\)/);
  assert.ok(!serverCode.includes('.rpc("powerhub_mobile_touch_session"'),
    'mobile session call changed: review RPC and permissions');
  assert.equal(catalog.references.find(x=>x.function_identity===mobile.function_identity)
    .contains_explicit_advisory_lock,true);
  return {
    format:'PR359_CB_A_DEFINER_TRIGGER_ATTACHMENT_AUDIT_V1',
    source_project_ref:capture.project_ref,
    evidence_git_blob_sha:EVIDENCE_GIT_BLOB_SHA,
    inspected_mobile_api_git_blob_sha:MOBILE_API_BLOB_SHA,
    exact_security_definers:3,
    attached_direct_triggers:2,
    zero_trigger_function_count:1,
    direct_trigger_bindings:[
      {function_identity:mainSite.function_identity,relation:mainSite.trigger_relation,
        trigger_name:mainSite.trigger_name,trigger_definition:mainSite.trigger_definition},
      {function_identity:fuel.function_identity,relation:fuel.trigger_relation,
        trigger_name:fuel.trigger_name,trigger_definition:fuel.trigger_definition}
    ],
    mobile_session_function_identity:mobile.function_identity,
    mobile_api_scoped_direct_update_in_pinned_code:true,
    mobile_api_direct_touch_rpc_literal_in_pinned_code:false,
    // Crucial: these two booleans may NOT be misconstrued as an executed
    // caller trace, cross-repo dependency proof or a production assessment.
    full_runtime_call_graph_verified:false,
    trigger_runtime_firing_verified:false,
    tenant_and_site_authorization_verified:false,
    security_definer_signoff_complete:false,
    source_ownership_approved:false,
    executable_canonical_sql_approved:false,
    clean_bootstrap_pass:false,
    staging_inplace_go:false,
    production_inplace_go:false,
    pr359_merge_go:false,
    destructive_allowlist:[]
  };
}

export function loadDefinerAttachmentEvidence() {
  return pinnedJson(readFileSync(EVIDENCE_PATH),EVIDENCE_GIT_BLOB_SHA);
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const args=process.argv.slice(2);
  assert.ok(args.length===0||(args.length===2&&args[0]==='--out'),
    'Usage: node cb-a-definer-attachments.mjs [--out path]; never --apply');
  const report=auditDefinerAttachments(loadDefinerAttachmentEvidence(),
    loadCbBGapReviewInputs(),readFileSync('server/mobile-api.ts','utf8'));
  if(args.length)writeFileSync(args[1],JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({format:report.format,definers:report.exact_security_definers,
    direct_triggers:report.attached_direct_triggers,approval:report.security_definer_signoff_complete}));
}
