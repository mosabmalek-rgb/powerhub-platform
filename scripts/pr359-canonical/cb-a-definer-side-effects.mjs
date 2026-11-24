import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {pinnedJson} from './audit-eleven-live-gaps.mjs';
import {loadCbBGapReviewInputs} from './cb-b-gap-review-bundle.mjs';
import {auditDefinerAttachments, loadDefinerAttachmentEvidence} from './cb-a-definer-attachments.mjs';

export const EVIDENCE_PATH='docs/security/pr359-cb-a-definer-side-effects-catalog-20261124.json';
export const EVIDENCE_BLOB_SHA='4a043e900d4475fb55e40a3a2489b62f6503d231';
const INDEXES = new Map([
 ['sites_code_key', ['sites', true, 'CREATE UNIQUE INDEX sites_code_key ON public.sites USING btree (code)']],
 ['sites_pkey', ['sites', true, 'CREATE UNIQUE INDEX sites_pkey ON public.sites USING btree (id)']],
 ['sites_tenant_id_id_unique_idx', ['sites', true, 'CREATE UNIQUE INDEX sites_tenant_id_id_unique_idx ON public.sites USING btree (tenant_id, id)']],
 ['sites_tenant_id_idx', ['sites', false, 'CREATE INDEX sites_tenant_id_idx ON public.sites USING btree (tenant_id)']],
 ['tenant_subscriptions_pkey', ['tenant_subscriptions', true, 'CREATE UNIQUE INDEX tenant_subscriptions_pkey ON public.tenant_subscriptions USING btree (id)']],
 ['tenant_subscriptions_tenant_id_key', ['tenant_subscriptions', true, 'CREATE UNIQUE INDEX tenant_subscriptions_tenant_id_key ON public.tenant_subscriptions USING btree (tenant_id)']]
]);
const EXPECTED_CALLEES = [
 'public.powerhub_append_fuel_maintenance_delta_sync_change',
 'public.powerhub_project_fuel_event_delta_row',
 'public.powerhub_project_maintenance_work_order_delta_row',
 'public.powerhub_project_maintenance_work_order_part_delta_row'
];

function exactWords(ddl, pattern, message) {
  assert.ok(pattern.test(ddl),message);
}
export function auditDefinerSideEffects(evidence, functionEvidence, inputs, priorCapture, serverCode) {
  // All prerequisite evidence must retain their existing fail-closed guards.
  auditDefinerAttachments(priorCapture, inputs, serverCode);
  assert.equal(evidence.format,'PR359_CB_A_SIDE_EFFECTS_CATALOG_REVIEW_V1');
  assert.equal(evidence.source_environment,'Staging');
  assert.equal(evidence.project_ref,'iyuryuhaylhisjfcrwkz');
  assert.equal(evidence.site_indexes.length,4);
  assert.equal(evidence.tenant_subscription_indexes.length,2);
  for (const key of ['app_owned_approved','source_ownership_approved','security_signoff_complete',
    'canonical_baseline_approved','executable_sql_approved','staging_inplace_go',
    'production_inplace_go','pr359_merge_go']) {
    if (Object.hasOwn(evidence,key)) assert.equal(evidence[key],false,key);
  }
  assert.equal(evidence.checks_approved,0);
  assert.deepEqual(evidence.destructive_allowlist,[]);
  const all=[...evidence.site_indexes,...evidence.tenant_subscription_indexes];
  const present=new Set();
  for(const idx of all) {
    assert.ok(!present.has(idx.name),'duplicate captured index');
    present.add(idx.name);
    const pin=INDEXES.get(idx.name);
    assert.ok(pin,'unreviewed index '+idx.name);
    assert.deepEqual([idx.relation,idx.unique,idx.definition],pin,'index definition drift: '+idx.name);
  }
  assert.deepEqual([...present].sort(),[...INDEXES.keys()].sort());
  const siteUnique=evidence.site_indexes.filter(x=>x.unique);
  assert.equal(siteUnique.length,3);
  assert.equal(evidence.tenant_subscription_indexes.filter(x=>x.unique).length,2);
  const emitter=evidence.downstream_function;
  assert.equal(emitter.identity,'powerhub_emit_fuel_maintenance_delta_sync_change(bigint,bigint,text,bigint)');
  assert.equal(emitter.security_definer,true);
  assert.equal(emitter.search_path,'search_path=pg_catalog, public, pg_temp');
  assert.equal(emitter.anon_execute,false);
  assert.equal(emitter.authenticated_execute,false);
  assert.equal(emitter.service_execute,true);
  assert.equal(emitter.body_source_fully_pinned,false);
  assert.equal(emitter.source_review_required,true);
  assert.deepEqual([...emitter.observed_calls].sort(),EXPECTED_CALLEES);
  assert.deepEqual([...emitter.observed_outcome_categories].sort(),['delete','upsert']);

  const own=functionEvidence.functions.find(x=>x.name==='powerhub_ensure_owner_main_site');
  const rename=functionEvidence.functions.find(x=>x.name==='powerhub_refresh_fuel_maintenance_delta_after_generator_name_up');
  const touch=functionEvidence.functions.find(x=>x.name==='powerhub_mobile_touch_session');
  assert.ok(own?.security_definer && rename?.security_definer && touch?.security_definer);
  const siteBody=own.executable_ddl;
  // Evidence of select-then-insert. Existing tenant+id uniqueness does NOT
  // protect one named main site per tenant; concurrent firing remains untested.
  exactWords(siteBody,/select id into v_site_id from public\.sites where tenant_id = new\.tenant_id/i,'missing scoped main-site selection');
  exactWords(siteBody,/if v_site_id is null then/i,'missing select/insert branch');
  exactWords(siteBody,/insert into public\.sites\s*\(tenant_id,\s*name,\s*code,\s*status\)/i,'missing site insert');
  exactWords(siteBody,/insert into public\.staff_profiles/i,'missing staff side effect');
  exactWords(siteBody,/on conflict do nothing/i,'missing staff duplicate handling');
  exactWords(siteBody,/return new;/i,'missing trigger NEW return');

  const fuelBody=rename.executable_ddl;
  // Limit is applied to the entire branch BEFORE generator_id is filtered.
  // This is a potential incompleteness risk, not an observed data loss event.
  const fuelOld='where e.tenant_id=NEW.tenant_id and e.site_id=NEW.site_id';
  const workOld='where w.tenant_id=NEW.tenant_id and w.site_id=NEW.site_id';
  assert.ok(fuelBody.includes(fuelOld) && fuelBody.includes(workOld));
  assert.match(fuelBody,/order by e\.occurred_at desc,e\.id desc limit 500[\s\S]*?\)\s*visible\s*where visible\.generator_id=NEW\.id/);
  assert.match(fuelBody,/order by coalesce\(w\.reported_at,w\.created_at\) desc,w\.id desc limit 200[\s\S]*?\)\s*visible\s*where visible\.generator_id=NEW\.id/);
  assert.match(fuelBody,/perform public\.powerhub_emit_fuel_maintenance_delta_sync_change\(NEW\.tenant_id,NEW\.site_id,'fuel_events',v_row\.id\)/);
  assert.match(fuelBody,/perform public\.powerhub_emit_fuel_maintenance_delta_sync_change\(NEW\.tenant_id,NEW\.site_id,'maintenance_work_orders',v_row\.id\)/);
  assert.match(touch.executable_ddl,/pg_advisory_xact_lock/);
  assert.match(touch.executable_ddl,/s\.user_id = p_user_id/);
  assert.match(touch.executable_ddl,/s\.tenant_id = p_tenant_id/);
  assert.match(touch.executable_ddl,/s\.revoked_at is null/);
  assert.match(touch.executable_ddl,/s\.expires_at > p_now/);

  const roots=inputs[4].objects;
  const required=[
    'public.sites#r','public.tenant_subscriptions#r',
    'public.staff_profiles#r','public.tenant_members#r',
    'public.generator_fuel_events#r','public.generator_maintenance_work_orders#r',
    emitter.identity
  ];
  for(const id of required) {
    const root=roots.find(x=>x.id===id || x.id===id.replace(/^public\./,''));
    assert.ok(root && !root.reviewed && root.classification==='APP_OWNED_CANDIDATE',
      'unreviewed/missing downstream root '+id);
  }
  return {
    format:'PR359_CB_A_DEFINER_SIDE_EFFECT_REVIEW_QUEUE_V1',
    evidence_git_blob_sha:EVIDENCE_BLOB_SHA,
    prerequisites_pinned:true,
    sites_index_count:4,
    tenant_subscription_index_count:2,
    downstream_security_definer_count:1,
    downstream_emitter_review_pending:true,
    main_site_select_then_insert_race_risk:'REQUIRES_CONCURRENCY_TEST',
    tenant_site_name_uniqueness_not_shown_in_captured_indexes:true,
    generator_fuel_branch_first_limit:500,
    generator_maintenance_branch_first_limit:200,
    generator_specific_delta_completeness_unverified:true,
    cross_tenant_privileged_side_effect_isolation_unverified:true,
    session_touch_runtime_caller_tracing_unverified:true,
    historical_create_lineage_complete:false,
    effective_security_review_complete:false,
    authorized_executable_sql:false,
    canonical_baseline_approved:false,
    clean_bootstrap_pass:false,
    staging_inplace_go:false,
    production_inplace_go:false,
    pr359_merge_go:false,
    destructive_allowlist:[]
  };
}
export function loadSideEffectEvidence() {
  return pinnedJson(readFileSync(EVIDENCE_PATH),EVIDENCE_BLOB_SHA);
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
 const args=process.argv.slice(2);
 assert.ok(args.length===0||(args.length===2&&args[0]==='--out'),
   'Usage: node cb-a-definer-side-effects.mjs [--out file]; no SQL apply');
 const inputs=loadCbBGapReviewInputs();
 const report=auditDefinerSideEffects(loadSideEffectEvidence(),inputs[0],inputs,
   loadDefinerAttachmentEvidence(),readFileSync('server/mobile-api.ts','utf8'));
 if(args.length)writeFileSync(args[1],JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({format:report.format,sites_indexes:report.sites_index_count,
   generator_delta_complete:!report.generator_specific_delta_completeness_unverified,
   authorized_sql:report.authorized_executable_sql}));
}