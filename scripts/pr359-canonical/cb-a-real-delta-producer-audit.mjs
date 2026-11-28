import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

export const EVIDENCE_PATH='docs/security/pr359-cb-a-live-delta-producer-evidence-20261124.json';
export const PINNED_GIT_BLOB='f851a32e73ce652729e418d570973d1967e8934e';
const signatures=[
 'powerhub_append_fuel_maintenance_delta_sync_change(bigint,bigint,text,text,text,jsonb)',
 'powerhub_capture_fuel_maintenance_delta_sync_change()',
 'powerhub_emit_fuel_maintenance_delta_sync_change(bigint,bigint,text,bigint)',
 'powerhub_pull_fuel_maintenance_sync_delta(bigint,bigint,text,bigint,bigint,integer)'
];
const triggerNames=[
 'powerhub_delta_fuel_events_operational',
 'powerhub_delta_maintenance_work_order_parts_operational',
 'powerhub_delta_maintenance_work_orders_operational'
];
const triggerRelations=[
 'generator_fuel_events','generator_maintenance_work_order_parts',
 'generator_maintenance_work_orders'
];
function blobSha(b){return createHash('sha1').update(Buffer.from('blob '+b.length+'\0')).update(b).digest('hex');}
export function loadPinnedProducerEvidence(){
 const bytes=readFileSync(EVIDENCE_PATH);
 assert.equal(blobSha(bytes),PINNED_GIT_BLOB,'Staging source evidence blob drift');
 return JSON.parse(bytes.toString('utf8'));
}
function requirePattern(text,pattern,description){assert.match(text,pattern,description);}
export function auditRealDeltaProducerEvidence(evidence){
 assert.equal(evidence.format,'PR359_CB_A_LIVE_DELTA_PRODUCER_ATTESTATION_V1');
 assert.equal(evidence.project_ref,'iyuryuhaylhisjfcrwkz');
 assert.equal(evidence.source,'READ_ONLY_PG_CATALOG_SELECT');
 assert.equal(evidence.functions.length,4);
 for(const key of ['real_runtime_end_to_end_verified','full_producer_closure_verified',
  'app_owned_approved','canonical_baseline_approved','executable_sql_approved',
  'staging_inplace_go','production_inplace_go','pr359_merge_go']){
  assert.equal(evidence[key],false,'unauthorized evidence approval: '+key);
 }
 assert.deepEqual(evidence.destructive_allowlist,[]);
 const map=new Map(evidence.functions.map(f=>[f.identity,f]));
 assert.equal(map.size,4,'duplicate function signature');
 assert.deepEqual([...map.keys()].sort(),[...signatures].sort());
 for(const [signature,f] of map){
  assert.equal(f.security_definer,true,signature);
  assert.equal(f.configured_search_path,'search_path=pg_catalog, public, pg_temp');
  assert.equal(f.anon_execute,false);
  assert.equal(f.authenticated_execute,false);
  assert.equal(f.service_execute,true);
  assert.ok(f.executable_ddl.startsWith('CREATE OR REPLACE FUNCTION public.'+signature.split('(')[0]+'('));
 }
 const append=map.get(signatures[0]).executable_ddl;
 const capture=map.get(signatures[1]).executable_ddl;
 const emit=map.get(signatures[2]).executable_ddl;
 const pull=map.get(signatures[3]).executable_ddl;
 requirePattern(append,/insert into public\.powerhub_sync_scope_state\(tenant_id,site_id,entity_type,last_cursor,retained_from_cursor,updated_at\)/,'missing per-scope state');
 requirePattern(append,/on conflict\(tenant_id,site_id,entity_type\) do update\s+set last_cursor=public\.powerhub_sync_scope_state\.last_cursor\+1/,'missing row-serialized cursor increment');
 requirePattern(append,/returning last_cursor into v_cursor/,'missing shared cursor allocation');
 requirePattern(append,/insert into public\.powerhub_sync_changes\(tenant_id,site_id,entity_type,cursor,entity_id,change_type,row_data,changed_at\)/,'missing same-function journal write');
 requirePattern(append,/values\(p_tenant_id,p_site_id,p_entity_type,v_cursor,p_entity_id,p_change_type,p_row_data,clock_timestamp\(\)\)/,'wrong journal cursor binding');
 requirePattern(append,/if v_cursor>10000 and mod\(v_cursor,500\)=0/,'retention threshold drift');
 requirePattern(append,/retained_from_cursor=greatest\(s\.retained_from_cursor,v_cutoff\)/,'retention floor drift');
 const triggers=map.get(signatures[1]).direct_triggers;
 assert.equal(triggers.length,3,'unexpected direct trigger count');
 assert.deepEqual(triggers.map(t=>t.name).sort(),[...triggerNames].sort());
 assert.deepEqual(triggers.map(t=>t.relation).sort(),[...triggerRelations].sort());
 for(const t of triggers){
  assert.match(t.definition,/AFTER INSERT OR DELETE OR UPDATE/);
  assert.match(t.definition,/FOR EACH ROW EXECUTE FUNCTION powerhub_capture_fuel_maintenance_delta_sync_change\(\)/);
 }
 for(const s of ['OLD.tenant_id,OLD.site_id','NEW.tenant_id,NEW.site_id',
  "'delete',null","public.powerhub_append_fuel_maintenance_delta_sync_change",
  'public.powerhub_emit_fuel_maintenance_delta_sync_change']){
  assert.ok(capture.includes(s),'capture source changed: '+s);
 }
 requirePattern(emit,/public\.powerhub_append_fuel_maintenance_delta_sync_change\(/,'emit bypasses pinned append');
 requirePattern(pull,/c\.cursor>p_after_cursor and c\.cursor<=v_target/,'pull cursor bounds drift');
 requirePattern(pull,/p_after_cursor<v_retained/,'retention reset test missing');
 requirePattern(pull,/from public\.powerhub_sync_changes c/,'pull change log source missing');
 for(const signature of [signatures[0],signatures[2],signatures[3]]){
  assert.deepEqual(map.get(signature).direct_triggers,[],'unexpected direct trigger');
 }
 return {
  format:'PR359_CB_A_LIVE_DELTA_PRODUCER_STATIC_AUDIT_V1',
  evidence_blob_sha:PINNED_GIT_BLOB,
  inspected_functions:4,
  observed_direct_triggers:3,
  observed_row_serialized_cursor_allocation:true,
  observed_source_trigger_to_append_chain:true,
  observed_reset_required_retention:true,
  // This is based on function body and key shape, not actual transaction
  // interleaving on the production schema or a complete caller inventory.
  real_commit_order_verified:false,
  real_producer_replay_and_rollback_verified:false,
  all_writer_routes_verified:false,
  real_tenant_isolation_verified:false,
  android_acceptance_verified:false,
  source_ownership_approved:false,
  canonical_baseline_approved:false,
  staging_inplace_go:false,production_inplace_go:false,pr359_merge_go:false,
  destructive_allowlist:[]
 };
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const args=process.argv.slice(2);
 assert.ok(args.length===0||(args.length===2&&args[0]==='--out'),
  'Usage: node cb-a-real-delta-producer-audit.mjs [--out local-report.json]');
 const report=auditRealDeltaProducerEvidence(loadPinnedProducerEvidence());
 if(args.length)writeFileSync(args[1],JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({format:report.format,functions:report.inspected_functions,triggers:report.observed_direct_triggers,real_runtime_approved:report.real_commit_order_verified}));
}