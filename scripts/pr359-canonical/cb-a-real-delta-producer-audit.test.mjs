import assert from 'node:assert/strict';
import test from 'node:test';
import {auditRealDeltaProducerEvidence,loadPinnedProducerEvidence} from './cb-a-real-delta-producer-audit.mjs';
const fixture=()=>structuredClone(loadPinnedProducerEvidence());
test('real Delta static evidence requires scoped row-serialized cursor and three operational triggers',()=>{
 const report=auditRealDeltaProducerEvidence(fixture());
 assert.equal(report.inspected_functions,4);
 assert.equal(report.observed_direct_triggers,3);
 assert.equal(report.observed_row_serialized_cursor_allocation,true);
 assert.equal(report.observed_source_trigger_to_append_chain,true);
 assert.equal(report.observed_reset_required_retention,true);
 for(const key of [
  'real_commit_order_verified','real_producer_replay_and_rollback_verified',
  'all_writer_routes_verified','real_tenant_isolation_verified',
  'android_acceptance_verified','source_ownership_approved',
  'canonical_baseline_approved','staging_inplace_go','production_inplace_go',
  'pr359_merge_go'
 ])assert.equal(report[key],false,key);
 assert.deepEqual(report.destructive_allowlist,[]);
 assert.deepEqual(auditRealDeltaProducerEvidence(fixture()),report);
});
test('catalog privilege, trigger, cursor and retention drift must fail closed',()=>{
 const mutate=[
  x=>{x.functions[0].authenticated_execute=true;},
  x=>{x.functions[0].service_execute=false;},
  x=>{x.functions[1].security_definer=false;},
  x=>{x.functions[1].direct_triggers.pop();},
  x=>{x.functions[1].direct_triggers[0].definition=x.functions[1].direct_triggers[0].definition.replace('AFTER INSERT OR DELETE OR UPDATE','BEFORE INSERT');},
  x=>{x.functions[0].executable_ddl=x.functions[0].executable_ddl.replace('last_cursor+1','last_cursor+2');},
  x=>{x.functions[0].executable_ddl=x.functions[0].executable_ddl.replace('v_cursor,p_entity_id','0,p_entity_id');},
  x=>{x.functions[0].executable_ddl=x.functions[0].executable_ddl.replace('retained_from_cursor=greatest','retained_from_cursor=least');},
  x=>{x.functions[3].executable_ddl=x.functions[3].executable_ddl.replace('p_after_cursor<v_retained','p_after_cursor>v_retained');},
  x=>{x.canonical_baseline_approved=true;},
  x=>{x.destructive_allowlist.push('public.powerhub_sync_changes');},
  x=>{x.functions.push(structuredClone(x.functions[0]));}
 ];
 for(const change of mutate){const x=fixture();change(x);assert.throws(()=>auditRealDeltaProducerEvidence(x));}
});
