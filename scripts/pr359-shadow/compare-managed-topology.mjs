import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

const ident=/^[a-z_][a-z0-9_]*$/;
function relationMap(rows,origin){
  assert.ok(Array.isArray(rows)&&rows.length>0,origin+': invalid relation topology');
  const map=new Map();
  for(const r of rows){
    assert.ok(r&&ident.test(r.schema||'')&&ident.test(r.table||''),
      origin+': invalid relation identifier');
    assert.ok(['auth','storage','realtime'].includes(r.schema),origin+': unknown schema');
    assert.ok(['r','p'].includes(r.kind),origin+': invalid relation kind');
    assert.ok(typeof r.owner==='string'&&r.owner.length>0,origin+': missing owner');
    assert.ok(typeof r.is_partition==='boolean',origin+': missing partition flag');
    const key=r.schema+'.'+r.table;
    assert.ok(!map.has(key),origin+': duplicate relation');
    map.set(key,r);
  }
  return map;
}
export function isManagedDailyRealtimePartition(r){
  if(r.schema!=='realtime'||!r.is_partition||r.kind!=='r'||
     r.parent!=='realtime.messages'||r.owner!=='supabase_realtime_admin')return false;
  const match=/^FOR VALUES FROM \('(\d{4}-\d{2}-\d{2}) 00:00:00'\) TO \('(\d{4}-\d{2}-\d{2}) 00:00:00'\)$/.exec(r.partition_bound||'');
  if(!match)return false;
  const a=Date.parse(match[1]+'T00:00:00Z'),b=Date.parse(match[2]+'T00:00:00Z');
  return Number.isFinite(a)&&Number.isFinite(b)&&b-a===86400000;
}
export function compareProviderTopology(source,local){
  const a=relationMap(source,'source'),b=relationMap(local,'local');
  const absent=[],extra=[],sharedDrift=[];
  for(const [k,r] of a){
    const other=b.get(k);
    if(!other){absent.push(k);continue;}
    for(const field of ['kind','owner','is_partition','parent']){
      if((r[field]??null)!==(other[field]??null)){
        sharedDrift.push(k+':'+field);break;
      }
    }
  }
  for(const [k,r] of b)if(!a.has(k))extra.push(r);
  const dynamic=extra.filter(isManagedDailyRealtimePartition);
  const otherExtra=extra.filter(r=>!isManagedDailyRealtimePartition(r));
  absent.sort();sharedDrift.sort();
  dynamic.sort((x,y)=>x.table.localeCompare(y.table));
  otherExtra.sort((x,y)=>(x.schema+'.'+x.table).localeCompare(y.schema+'.'+y.table));
  return {sourceRelations:a.size,localRelations:b.size,absent,sharedDrift,dynamic,otherExtra,
    exact:absent.length===0&&extra.length===0&&sharedDrift.length===0};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  assert.equal(process.argv.length,4,
    'Usage: compare-managed-topology.mjs source-topology.json local-relations.json');
  const reference=JSON.parse(readFileSync(process.argv[2],'utf8'));
  assert.equal(reference.format,'PR359 R0 managed relation topology reference v1');
  assert.equal(reference.project_ref,'vvcdiqcyhaloxesvpppc');
  const local=JSON.parse(readFileSync(process.argv[3],'utf8').trim());
  const r=compareProviderTopology(reference.relations,local);
  console.log('PR359_LOCAL_MANAGED_TOPOLOGY sourceRelations='+r.sourceRelations+
    ' localRelations='+r.localRelations+' missing='+r.absent.length+
    ' sharedDrift='+r.sharedDrift.length+' dailyRealtimePartitions='+r.dynamic.length+
    ' otherExtraRelations='+r.otherExtra.length);
  for(const rel of r.dynamic.slice(0,14))
    console.log('PR359_LOCAL_MANAGED_DAILY_PARTITION: realtime.'+rel.table);
  for(const rel of r.otherExtra.slice(0,14))
    console.log('PR359_LOCAL_MANAGED_NONPARTITION_EXTRA: '+rel.schema+'.'+rel.table);
  console.log('PR359_LOCAL_MANAGED_TOPOLOGY_PARITY='+(r.exact?'EXACT_METADATA_ONLY':'NOT_EXACT'));
  console.log('PR359_FULL_RESTORE_ACCEPTANCE=NOT_GRANTED');
}
