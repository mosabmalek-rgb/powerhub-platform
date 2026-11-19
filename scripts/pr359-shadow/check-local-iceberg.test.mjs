import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectLocalIceberg} from './check-local-iceberg.mjs';
const base=()=>({scope:'PR359_LOCAL_ICEBERG_ONLY',
 migration_names:['iceberg-catalog-flag-on-buckets','iceberg-table-metadata','iceberg-catalog-ids'],
 relations:[
 {schema:'storage',name:'buckets_analytics',kind:'r',owner:'supabase_storage_admin',rls_enabled:true},
 {schema:'storage',name:'iceberg_namespaces',kind:'r',owner:'supabase_storage_admin',rls_enabled:true,
  policy_count:0,anon_writes:false,authenticated_writes:false,
  outgoing_fks:['storage.buckets_analytics'],incoming_fks:['storage.iceberg_tables']},
 {schema:'storage',name:'iceberg_tables',kind:'r',owner:'supabase_storage_admin',rls_enabled:true,
  policy_count:0,anon_writes:false,authenticated_writes:false,
  outgoing_fks:['storage.buckets_analytics','storage.iceberg_namespaces'],incoming_fks:[]}
 ]});
test('extra Iceberg tables do not ever grant restore acceptance',()=>{
 const r=inspectLocalIceberg(base());assert.deepEqual(r.errors,[]);
 assert.equal(r.kind,'GUARDED_EXTRA_ICEBERG_TABLES');assert.equal(r.restoreAccepted,false);
});
test('no Iceberg tables on older CLI is not accepted either',()=>{
 const x=base();x.relations=x.relations.slice(0,1);
 assert.equal(inspectLocalIceberg(x).kind,'NO_EXTRA_ICEBERG_TABLES');
 assert.equal(inspectLocalIceberg(x).restoreAccepted,false);
});
test('fail on absent migration, partial table, unauthorized write, absent RLS',()=>{
 const x=base();x.migration_names.pop();
 assert.ok(inspectLocalIceberg(x).errors.some(e=>e.startsWith('MISSING_MIGRATION')));
 const y=base();y.relations.pop();
 assert.ok(inspectLocalIceberg(y).errors.includes('PARTIAL_ICEBERG_CATALOG'));
 const z=base();z.relations[2].authenticated_writes=true;
 assert.ok(inspectLocalIceberg(z).errors.some(e=>e.startsWith('ICEBERG_ACL')));
 const w=base();w.relations[1].rls_enabled=false;
 assert.ok(inspectLocalIceberg(w).errors.some(e=>e.startsWith('ICEBERG_ACL')));
});
test('foreign dependency and altered FK are unknown structural drift',()=>{
 const x=base();x.relations[1].incoming_fks=['public.payments'];
 assert.ok(inspectLocalIceberg(x).errors.includes('UNKNOWN_INBOUND_FK:iceberg_namespaces'));
 const y=base();y.relations[2].outgoing_fks=[];
 assert.ok(inspectLocalIceberg(y).errors.includes('ICEBERG_FK_TOPOLOGY_DRIFT'));
});
