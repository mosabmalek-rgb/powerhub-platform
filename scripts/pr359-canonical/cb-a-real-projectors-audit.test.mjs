import assert from 'node:assert/strict';
import test from 'node:test';
import {auditProjectorEvidence,loadPinnedProjectors} from './cb-a-real-projectors-audit.mjs';
const fixture=()=>structuredClone(loadPinnedProjectors());
test('three pinned projectors require tenant/site joins, safe grants and explicit non-approval',()=>{
 const a=auditProjectorEvidence(fixture());
 assert.equal(a.pinned_projectors,3);
 assert.equal(a.scoped_joins_pinned,true);
 assert.equal(a.direct_execute_roles_restricted,true);
 for(const key of ['actual_projection_runtime_verified','real_source_row_integrity_verified',
 'android_reset_contract_verified','canonical_baseline_approved','staging_inplace_go',
 'production_inplace_go','pr359_merge_go']) assert.equal(a[key],false,key);
 assert.deepEqual(a,auditProjectorEvidence(fixture()));
});
test('scope and privilege drift fail closed',()=>{
 const changes=[
  x=>{x.functions[0].security_definer=false},
  x=>{x.functions[0].authenticated_execute=true},
  x=>{x.functions[1].service_execute=false},
  x=>{x.functions[0].executable_ddl=x.functions[0].executable_ddl.replace('g.tenant_id=e.tenant_id','g.tenant_id=999')},
  x=>{x.functions[1].executable_ddl=x.functions[1].executable_ddl.replace('s.tenant_id=w.tenant_id','s.tenant_id=999')},
  x=>{x.functions[2].executable_ddl=x.functions[2].executable_ddl.replace('o.site_id=p.site_id','o.site_id=999')},
  x=>{x.functions[2].executable_ddl=x.functions[2].executable_ddl.replace('and p.work_order_id=p_work_order_id','and p.work_order_id=999')},
  x=>{x.canonical_baseline_approved=true},
  x=>{x.destructive_allowlist.push('public.generator_fuel_events')},
  x=>{x.functions.pop()}
 ];
 for(const change of changes){const x=fixture();change(x);assert.throws(()=>auditProjectorEvidence(x));}
});
