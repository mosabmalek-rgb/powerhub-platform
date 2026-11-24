import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

export const PATH='docs/security/pr359-cb-a-real-delta-projectors-20261124.json';
export const PINNED_GIT_BLOB_SHA='3102f6b3c59af9054c4d53643ac2a9988058cab7';
const expected=[
 'powerhub_project_fuel_event_delta_row(bigint,bigint,bigint)',
 'powerhub_project_maintenance_work_order_delta_row(bigint,bigint,bigint)',
 'powerhub_project_maintenance_work_order_part_delta_row(bigint,bigint,bigint,bigint)'
];
const gitBlob=x=>createHash('sha1').update(Buffer.from('blob '+x.length+'\0')).update(x).digest('hex');
export function loadPinnedProjectors(){
 const bytes=readFileSync(PATH);
 assert.equal(gitBlob(bytes),PINNED_GIT_BLOB_SHA,'unreviewed projector evidence drift');
 return JSON.parse(bytes.toString('utf8'));
}
export function auditProjectorEvidence(evidence){
 assert.equal(evidence.format,'PR359_CB_A_REAL_DELTA_PROJECTORS_CATALOG_V1');
 assert.equal(evidence.source_environment,'Staging');
 assert.equal(evidence.project_ref,'iyuryuhaylhisjfcrwkz');
 assert.equal(evidence.source,'READ_ONLY_PG_CATALOG_SELECT');
 assert.equal(evidence.functions.length,3);
 const byId=new Map(evidence.functions.map(x=>[x.identity,x]));
 assert.equal(byId.size,3);
 assert.deepEqual([...byId.keys()].sort(),[...expected].sort());
 for(const key of ['real_projector_runtime_verified','complete_caller_closure_verified','android_reset_contract_verified',
 'canonical_baseline_approved','executable_sql_approved','staging_inplace_go','production_inplace_go','pr359_merge_go']){
  assert.equal(evidence[key],false,'unexpected signoff '+key);
 }
 assert.deepEqual(evidence.destructive_allowlist,[]);
 for(const id of expected){
  const row=byId.get(id);
  assert.equal(row.security_definer,true);
  assert.equal(row.configured_search_path,'search_path=pg_catalog, public, pg_temp');
  assert.equal(row.anon_execute,false);
  assert.equal(row.authenticated_execute,false);
  assert.equal(row.service_execute,true);
  assert.ok(row.executable_ddl.startsWith('CREATE OR REPLACE FUNCTION public.'+id.split('(')[0]+'('));
  assert.match(row.executable_ddl,/where (?:e|w|p)\.tenant_id=p_tenant_id and (?:e|w|p)\.site_id=p_site_id/i);
 }
 const fuel=byId.get(expected[0]).executable_ddl;
 const maintenance=byId.get(expected[1]).executable_ddl;
 const parts=byId.get(expected[2]).executable_ddl;
 for(const [name,body] of [['fuel',fuel],['maintenance',maintenance],['parts',parts]]){
  assert.match(body,/jsonb_build_object\(/i,name);
 }
 assert.match(fuel,/join public\.generators g on g\.tenant_id=e\.tenant_id and g\.site_id=e\.site_id and g\.id=e\.generator_id/);
 assert.match(fuel,/join public\.inventory_items i on i\.tenant_id=e\.tenant_id and i\.id=e\.fuel_item_id/);
 assert.match(fuel,/join public\.inventory_warehouses sw on sw\.tenant_id=e\.tenant_id and sw\.site_id=e\.site_id and sw\.id=e\.source_warehouse_id/);
 assert.match(fuel,/join public\.inventory_warehouses dw on dw\.tenant_id=e\.tenant_id and dw\.site_id=e\.site_id and dw\.id=e\.destination_warehouse_id/);
 assert.match(maintenance,/join public\.generators g on g\.tenant_id=w\.tenant_id and g\.site_id=w\.site_id and g\.id=w\.generator_id/);
 assert.match(maintenance,/left join public\.suppliers s on s\.tenant_id=w\.tenant_id and s\.id=w\.assigned_supplier_id/);
 assert.match(parts,/join public\.generator_maintenance_work_orders o\s+on o\.tenant_id=p\.tenant_id and o\.site_id=p\.site_id and o\.id=p\.work_order_id/);
 assert.match(parts,/join public\.inventory_items i on i\.tenant_id=p\.tenant_id and i\.id=p\.item_id/);
 assert.match(parts,/join public\.inventory_warehouses w on w\.tenant_id=p\.tenant_id and w\.site_id=p\.site_id and w\.id=p\.warehouse_id/);
 assert.match(parts,/and p\.work_order_id=p_work_order_id and p\.id=p_part_id/);
 return {
  format:'PR359_CB_A_PROJECTORS_STATIC_AUDIT_V1',
  evidence_git_blob_sha:PINNED_GIT_BLOB_SHA,
  pinned_projectors:3,
  scoped_joins_pinned:true,
  direct_execute_roles_restricted:true,
  actual_projection_runtime_verified:false,
  real_source_row_integrity_verified:false,
  android_reset_contract_verified:false,
  canonical_baseline_approved:false,
  staging_inplace_go:false,production_inplace_go:false,pr359_merge_go:false
 };
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const args=process.argv.slice(2);
 assert.ok(args.length===0||(args.length===2&&args[0]==='--out'),
  'Usage: cb-a-real-projectors-audit.mjs [--out temp.json]');
 const report=auditProjectorEvidence(loadPinnedProjectors());
 if(args.length)writeFileSync(args[1],JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify(report));
}
