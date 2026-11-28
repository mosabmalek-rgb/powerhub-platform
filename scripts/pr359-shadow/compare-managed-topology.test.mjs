import test from 'node:test';
import assert from 'node:assert/strict';
import {isManagedDailyRealtimePartition,compareProviderTopology} from './compare-managed-topology.mjs';
const base=[
 {schema:'auth',table:'users',kind:'r',owner:'supabase_auth_admin',is_partition:false,parent:null,partition_bound:null},
 {schema:'storage',table:'objects',kind:'r',owner:'supabase_storage_admin',is_partition:false,parent:null,partition_bound:null},
 {schema:'realtime',table:'messages',kind:'p',owner:'supabase_realtime_admin',is_partition:false,parent:null,partition_bound:null}
];
const daily={schema:'realtime',table:'messages_2026_11_19',kind:'r',
 owner:'supabase_realtime_admin',is_partition:true,parent:'realtime.messages',
 partition_bound:"FOR VALUES FROM ('2026-11-19 00:00:00') TO ('2026-11-20 00:00:00')"};
test('exact managed provider tables pass as strict topology match',()=>{
 const x=compareProviderTopology(base,structuredClone(base));
 assert.equal(x.exact,true);
 assert.deepEqual(x.otherExtra,[]);
});
test('valid attached one-day realtime partition remains informational, never exact parity',()=>{
 assert.equal(isManagedDailyRealtimePartition(daily),true);
 const x=compareProviderTopology(base,[...structuredClone(base),daily]);
 assert.equal(x.exact,false);
 assert.equal(x.dynamic.length,1);
 assert.equal(x.otherExtra.length,0);
});
test('unattached or wrong-owner partitions and normal Storage extras remain blocking',()=>{
 const extra=[
  {...daily,parent:'realtime.other',table:'messages_invalid'},
  {...daily,owner:'postgres',table:'messages_wrong_owner'},
  {...daily,table:'messages_bad_bound',partition_bound:"FOR VALUES FROM ('2026-11-19 00:00:00') TO ('2026-11-22 00:00:00')"},
  {schema:'storage',table:'vector_indexes',kind:'r',owner:'supabase_storage_admin',is_partition:false,parent:null,partition_bound:null}
 ];
 const x=compareProviderTopology(base,[...structuredClone(base),...extra]);
 assert.equal(x.dynamic.length,0);
 assert.equal(x.otherExtra.length,4);
 assert.equal(x.exact,false);
});
test('missing provider table, altered owner and duplicated object fail closed',()=>{
 const changed=structuredClone(base);
 changed[0].owner='postgres';
 const x=compareProviderTopology(base,changed.slice(0,2));
 assert.deepEqual(x.absent,['realtime.messages']);
 assert.deepEqual(x.sharedDrift,['auth.users:owner']);
 assert.throws(()=>compareProviderTopology(base,[...base,base[0]]),/duplicate relation/);
});
