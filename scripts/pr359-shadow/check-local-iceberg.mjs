import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

const migrations=['iceberg-catalog-flag-on-buckets','iceberg-table-metadata','iceberg-catalog-ids'];
const iceberg=['iceberg_namespaces','iceberg_tables'];
export function inspectLocalIceberg(input){
  assert.equal(input?.scope,'PR359_LOCAL_ICEBERG_ONLY');
  assert.ok(Array.isArray(input.migration_names)&&Array.isArray(input.relations));
  const errors=[];
  for(const name of migrations)
    if(!input.migration_names.includes(name)) errors.push('MISSING_MIGRATION:'+name);
  const m=new Map();
  for(const r of input.relations){
    assert.ok(r.schema==='storage'&&['buckets_analytics',...iceberg].includes(r.name),
      'unknown provider catalog object');
    if(m.has(r.name)) errors.push('DUPLICATE:'+r.name);
    m.set(r.name,r);
  }
  const parent=m.get('buckets_analytics');
  if(!parent||parent.owner!=='supabase_storage_admin'||parent.rls_enabled!==true)
    errors.push('ANALYTICS_PARENT_DRIFT');
  const found=iceberg.filter(n=>m.has(n));
  if(found.length===1) errors.push('PARTIAL_ICEBERG_CATALOG');
  if(found.length===2){
    for(const name of iceberg){
      const r=m.get(name);
      if(r.kind!=='r'||r.owner!=='supabase_storage_admin'||r.rls_enabled!==true||
         r.policy_count!==0||r.anon_writes!==false||r.authenticated_writes!==false||
         !Array.isArray(r.outgoing_fks)||!Array.isArray(r.incoming_fks))
        errors.push('ICEBERG_ACL_RLS_OWNER_DRIFT:'+name);
      if(Array.isArray(r.incoming_fks) &&
        r.incoming_fks.some(k=>!iceberg.map(n=>'storage.'+n).includes(k)))
        errors.push('UNKNOWN_INBOUND_FK:'+name);
    }
    const a=m.get('iceberg_namespaces').outgoing_fks||[];
    const b=m.get('iceberg_tables').outgoing_fks||[];
    if(a.length!==1||a[0]!=='storage.buckets_analytics'||
       !b.includes('storage.buckets_analytics')||
       !b.includes('storage.iceberg_namespaces')||b.length!==2)
      errors.push('ICEBERG_FK_TOPOLOGY_DRIFT');
  }
  return {kind:found.length===2?'GUARDED_EXTRA_ICEBERG_TABLES':'NO_EXTRA_ICEBERG_TABLES',
    errors,restoreAccepted:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  assert.equal(process.argv.length,3);
  const result=inspectLocalIceberg(JSON.parse(readFileSync(process.argv[2],'utf8').trim()));
  console.log('PR359_LOCAL_ICEBERG_PROVENANCE='+result.kind);
  for(const err of result.errors) console.error('PR359_ICEBERG_BLOCKER='+err);
  console.log('PR359_ICEBERG_RESTORE_ACCEPTED=FALSE');
  if(result.errors.length) process.exitCode=1;
}
