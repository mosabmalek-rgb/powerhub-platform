import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {auditDefinerSideEffects,loadSideEffectEvidence} from './cb-a-definer-side-effects.mjs';
import {loadCbBGapReviewInputs} from './cb-b-gap-review-bundle.mjs';
import {loadDefinerAttachmentEvidence} from './cb-a-definer-attachments.mjs';

function fixture() {
 const input=structuredClone(loadCbBGapReviewInputs());
 return [
   structuredClone(loadSideEffectEvidence()),input[0],input,
   structuredClone(loadDefinerAttachmentEvidence()),
   readFileSync('server/mobile-api.ts','utf8')
 ];
}
test('pinned indexes and privileged side effects become explicit blockers, not approved SQL',()=>{
 const a=auditDefinerSideEffects(...fixture());
 const b=auditDefinerSideEffects(...fixture());
 assert.deepEqual(a,b);
 assert.equal(a.sites_index_count,4);
 assert.equal(a.tenant_subscription_index_count,2);
 assert.equal(a.downstream_security_definer_count,1);
 assert.equal(a.main_site_select_then_insert_race_risk,'REQUIRES_CONCURRENCY_TEST');
 assert.equal(a.tenant_site_name_uniqueness_not_shown_in_captured_indexes,true);
 assert.equal(a.generator_fuel_branch_first_limit,500);
 assert.equal(a.generator_maintenance_branch_first_limit,200);
 assert.equal(a.generator_specific_delta_completeness_unverified,true);
 for(const key of ['historical_create_lineage_complete','effective_security_review_complete',
   'authorized_executable_sql','canonical_baseline_approved','clean_bootstrap_pass',
   'staging_inplace_go','production_inplace_go','pr359_merge_go']) {
   assert.equal(a[key],false,key);
 }
 assert.deepEqual(a.destructive_allowlist,[]);
});
test('index drift and privilege changes fail closed',()=>{
 const changes=[
  x=>{x[0].site_indexes[0].unique=false},
  x=>{x[0].site_indexes[0].definition+=' changed'},
  x=>{x[0].site_indexes.pop()},
  x=>{x[0].site_indexes.push(structuredClone(x[0].site_indexes[0]))},
  x=>{x[0].tenant_subscription_indexes[1].definition='CREATE INDEX wrong'},
  x=>{x[0].downstream_function.security_definer=false},
  x=>{x[0].downstream_function.authenticated_execute=true},
  x=>{x[0].downstream_function.source_review_required=false},
  x=>{x[0].downstream_function.observed_calls.pop()},
  x=>{x[0].destructive_allowlist.push('public.sites')},
  x=>{x[0].canonical_baseline_approved=true},
  x=>{x[0].source_ownership_approved=true},
  x=>{x[2][0].functions.find(f=>f.name==='powerhub_ensure_owner_main_site').executable_ddl+='-- changed'},
  x=>{x[2][4].objects.find(r=>r.id==='public.sites#r').reviewed=true}
 ];
 for(const change of changes){const x=fixture();change(x);
   assert.throws(()=>auditDefinerSideEffects(...x));
 }
});
test('generator name refresh order, limits and tenant scope are guarded as evidence',()=>{
 const x=fixture();
 const f=x[2][0].functions.find(f=>f.name==='powerhub_refresh_fuel_maintenance_delta_after_generator_name_up');
 f.executable_ddl=f.executable_ddl.replace('limit 500','limit 5000');
 assert.throws(()=>auditDefinerSideEffects(...x));
});
