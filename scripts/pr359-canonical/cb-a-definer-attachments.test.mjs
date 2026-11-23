import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {auditDefinerAttachments,loadDefinerAttachmentEvidence,
  MOBILE_API_BLOB_SHA} from './cb-a-definer-attachments.mjs';
import {loadCbBGapReviewInputs} from './cb-b-gap-review-bundle.mjs';

const fixture=()=>[
  structuredClone(loadDefinerAttachmentEvidence()),
  structuredClone(loadCbBGapReviewInputs()),
  readFileSync('server/mobile-api.ts','utf8')
];

test('three current definer privileges and two direct trigger bindings are attested, not approved',()=>{
  const [e,args,source]=fixture();
  const report=auditDefinerAttachments(e,args,source);
  assert.equal(report.exact_security_definers,3);
  assert.equal(report.attached_direct_triggers,2);
  assert.equal(report.zero_trigger_function_count,1);
  assert.equal(report.inspected_mobile_api_git_blob_sha,MOBILE_API_BLOB_SHA);
  assert.equal(report.mobile_api_scoped_direct_update_in_pinned_code,true);
  assert.equal(report.mobile_api_direct_touch_rpc_literal_in_pinned_code,false);
  assert.equal(report.full_runtime_call_graph_verified,false);
  assert.equal(report.trigger_runtime_firing_verified,false);
  assert.equal(report.security_definer_signoff_complete,false);
  assert.equal(report.source_ownership_approved,false);
  assert.equal(report.executable_canonical_sql_approved,false);
  assert.equal(report.clean_bootstrap_pass,false);
  assert.equal(report.staging_inplace_go,false);
  assert.equal(report.production_inplace_go,false);
  assert.equal(report.pr359_merge_go,false);
  assert.deepEqual(report.destructive_allowlist,[]);
  assert.deepEqual(auditDefinerAttachments(e,args,source),report);
});

test('privileges, trigger table/function/enablement and path drift fail closed',()=>{
  const mutate=[
    x=>{x[0].entries[0].authenticated_execute=true},
    x=>{x[0].entries[1].anon_execute=true},
    x=>{x[0].entries[2].service_execute=false},
    x=>{x[0].entries[0].trigger_name='unknown_trigger'},
    x=>{x[0].entries[2].trigger_relation='tenants'},
    x=>{x[0].entries[0].trigger_enabled='D'},
    x=>{x[0].entries[2].trigger_definition+=' unexpected'},
    x=>{x[0].entries[1].trigger_name='unexpected'},
    x=>{x[0].entries[1].configured_search_path='search_path=public'},
    x=>{x[0].entries.pop()},
    x=>{x[0].entries.push(structuredClone(x[0].entries[0]))},
    x=>{x[0].canonical_baseline_approved=true},
    x=>{x[0].destructive_allowlist.push('public.tenants')},
    x=>{x[1][0].functions[2].security_definer=false},
    x=>{x[1][4].objects.find(y=>y.id==='powerhub_ensure_owner_main_site()').reviewed=true}
  ];
  for(const change of mutate){const x=fixture();change(x);
    assert.throws(()=>auditDefinerAttachments(...x));
  }
});
test('a changed server call path is not accepted as unchanged evidence',()=>{
  const x=fixture();
  x[2]=x[2].replace('.eq("tenant_id", payload.tenantId)',
    '.eq("tenant_id", 123)');
  assert.throws(()=>auditDefinerAttachments(...x),/code drift/);
  x[2]=readFileSync('server/mobile-api.ts','utf8')+'\n';
  assert.throws(()=>auditDefinerAttachments(...x),/code drift/);
});
