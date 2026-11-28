import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assessRootDependencies,checkPinnedSnapshot} from './verify-root-dependency-digests.mjs';
const dir='docs/security/';
const read=x=>JSON.parse(readFileSync(dir+x,'utf8'));
const evidence=()=>[
 read('pr359-r4-staging-root-dependency-digests-20261123.json'),
 read('pr359-r4-staging-object-register-20261120.json'),
 read('pr359-r0-staging-functions-20261119.json'),
 read('pr359-r0-staging-relations-20261119.json')
];
test('immutable source snapshot and full 978-root coverage remain non-authorizing',()=>{
 const raw=readFileSync(dir+'pr359-r4-staging-root-dependency-digests-20261123.json','utf8');
 assert.equal(checkPinnedSnapshot(raw).root_count,978);
 assert.throws(()=>checkPinnedSnapshot(raw+' '),/unreviewed source snapshot/);
 const r=assessRootDependencies(...evidence());
 assert.equal(r.incoming,6746);assert.equal(r.outgoing,1688);
 assert.equal(r.separate_managed_policy_subobject_edges_expected,48);
 assert.equal(r.ownership_signed,false);
 assert.equal(r.app_owned_approved,false);
 assert.equal(r.staging_inplace_go,false);
 assert.equal(r.full_executable_canonical_baseline_ready,false);
});
test('unknown, missing or duplicate root fails closed',()=>{
 for(const mutate of [
  a=>a[0].entries[0].identity='public.unreviewed#r',
  a=>a[0].entries[1].identity=a[0].entries[0].identity,
  a=>a[0].entries.pop(),
  a=>a[0].unique_root_count=977,
  a=>a[1].objects[0].reviewed=true
 ]){
  const x=evidence();mutate(x);assert.throws(()=>assessRootDependencies(...x));
 }
});
test('changed dependency counts, direction and digests require new review',()=>{
 for(const mutate of [
  a=>a[0].incoming_edge_count++,
  a=>a[0].entries[0].incoming_edges++,
  a=>a[0].entries[0].managed_incoming=1,
  a=>a[0].entries[0].outgoing_sha256='invalid',
  a=>a[0].managed_outgoing_count=1,
  a=>a[0].unidentified_incoming_count=1,
  a=>a[0].application_ownership_approved=true,
  a=>a[0].destructive_allowlist=['public.users'],
  a=>a[0].capture_mode='no-snapshot',
 ]){
  const x=evidence();mutate(x);assert.throws(()=>assessRootDependencies(...x));
 }
});

test('rejects nonzero per-root managed and unidentified counts even when they fit the edge counts',()=>{
 for(const key of ['managed_incoming','managed_outgoing','unidentified_incoming','unidentified_outgoing']){
  const x=evidence();
  const direction=key.endsWith('incoming')?'incoming':'outgoing';
  const entry=x[0].entries.find(row=>row[direction+'_edges']>0);
  assert.ok(entry);
  entry[key]=1;
  assert.throws(()=>assessRootDependencies(...x),/dependency subtotal mismatch/);
 }
});
