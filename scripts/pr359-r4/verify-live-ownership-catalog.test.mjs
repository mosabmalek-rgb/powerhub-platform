import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {verifyLiveOwnershipCatalog} from './verify-live-ownership-catalog.mjs';
const read=p=>JSON.parse(readFileSync('docs/security/'+p,'utf8'));
const fixture=()=>[
 read('pr359-r4-staging-live-ownership-fingerprints-20261123.json'),
 read('pr359-r4-staging-object-register-20261120.json'),
 read('pr359-r0-staging-functions-20261119.json'),
 read('pr359-r0-staging-relations-20261119.json')
];
test('live 978-object catalog matches R0 and never becomes an owner allowlist',()=>{
 const x=verifyLiveOwnershipCatalog(...fixture());
 assert.equal(x.object_count,978);
 assert.equal(x.functions,641);
 assert.equal(x.relations,337);
 assert.equal(x.relation_catalog_structure_sha256_captured,337);
 assert.equal(x.full_relation_executable_ddl_verified,false);
 assert.equal(x.app_owned_approved,false);
 assert.deepEqual(x.destructive_allowlist,[]);
});
test('fail closed on function definition, ACL and effective privilege mutations',()=>{
 const cases=[
  a=>a[0].objects.find(x=>x.kind==='function').definition_sha256='f'.repeat(64),
  a=>a[0].objects.find(x=>x.kind==='function').authenticated_execute=
     !a[0].objects.find(x=>x.kind==='function').authenticated_execute,
  a=>a[0].objects.find(x=>x.kind==='function').acl_sha256='a'.repeat(64),
  a=>a[0].objects.find(x=>x.kind==='function').security_definer=false,
  a=>a[0].objects.find(x=>x.kind==='function').owner='service_role'
 ];
 for(const alter of cases){const a=fixture();alter(a);assert.throws(()=>verifyLiveOwnershipCatalog(...a));}
});
test('fail closed on incomplete relation catalog, false full-DDL, and RLS drift',()=>{
 const cases=[
  a=>a[0].objects.find(x=>x.kind==='relation').catalog_structure_sha256='a',
  a=>a[0].objects.find(x=>x.kind==='relation').catalog_structure_not_full_ddl=false,
  a=>a[0].objects.find(x=>x.kind==='relation').rls=
    !a[0].objects.find(x=>x.kind==='relation').rls,
  a=>a[0].objects.find(x=>x.kind==='relation').relkind='v',
  a=>a[0].objects.pop(),
  a=>a[0].unique_identity_count=977,
  a=>a[0].capture_mode='unknown'
 ];
 for(const alter of cases){const a=fixture();alter(a);assert.throws(()=>verifyLiveOwnershipCatalog(...a));}
});
test('live attestation never authorizes nonempty deletion or signed classification',()=>{
 const a=fixture();a[1].decision.destructive_allowlist=['public.users'];
 assert.throws(()=>verifyLiveOwnershipCatalog(...a));
 const b=fixture();b[1].objects[0].reviewed=true;
 assert.throws(()=>verifyLiveOwnershipCatalog(...b));
 const c=fixture();c[1].decision.app_owned_signed=true;
 assert.throws(()=>verifyLiveOwnershipCatalog(...c));
});
