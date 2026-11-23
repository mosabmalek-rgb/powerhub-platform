import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {auditOwnershipCandidates} from './audit-ownership-candidates.mjs';

const load=p=>JSON.parse(readFileSync(p,'utf8'));
const fixture=()=>[
 load('docs/security/pr359-r4-staging-object-register-20261120.json'),
 load('docs/security/pr359-r0-staging-relations-20261119.json'),
 load('docs/security/pr359-r0-staging-functions-20261119.json')
];
test('978 register candidates are cross-checked against original R0 sources, never authorized',()=>{
 const a=auditOwnershipCandidates(...fixture());
 assert.equal(a.summary.candidate_count,978);
 assert.equal(a.summary.unresolved_review_count,978);
 assert.equal(a.summary.app_owned_approved,false);
 assert.deepEqual(a.summary.destructive_allowlist,[]);
 assert.equal(a.summary.staging_inplace_go,false);
 assert.equal(a.summary.production_inplace_go,false);
 assert.equal(a.summary.pr359_merge_go,false);
 assert.deepEqual(a.summary.priority_counts,{
  P0_PUBLIC_SECURITY_DEFINER:296,
  P1_PRIVILEGED_FUNCTION:62,
  P2_RELATION_FULL_DDL_MISSING:337,
  P3_FUNCTION_REVIEW:283
 });
 assert.equal(a.reviewQueue.length,978);
 assert.equal(new Set(a.reviewQueue.map(x=>x.identity)).size,978);
 assert.match(a.summary.source_register_identity_sha256,/^[a-f0-9]{64}$/);
});
test('identity replacement, duplicates, omission and source mismatch fail closed',()=>{
 const a=fixture();a[0].objects[0].id='public.unknown()';
 assert.throws(()=>auditOwnershipCandidates(...a),/not present/);
 const b=fixture();b[0].objects[1].id=b[0].objects[0].id;
 assert.throws(()=>auditOwnershipCandidates(...b),/duplicate register identity/);
 const c=fixture();c[0].objects.pop();
 assert.throws(()=>auditOwnershipCandidates(...c),/candidate count/);
 const d=fixture();d[1].objects[0].acl_sha256='0'.repeat(64);
 assert.throws(()=>auditOwnershipCandidates(...d),/ACL hash mismatch/);
});
test('privilege, definition, owner, extension and class tampering fail closed',()=>{
 const variations=[
  p=>{p[0].objects.find(x=>x.kind==='function').definition_sha256='f'.repeat(64)},
  p=>{p[0].objects.find(x=>x.kind==='function').security_definer=
   !p[0].objects.find(x=>x.kind==='function').security_definer},
  p=>{p[0].objects[0].owner='service_role'},
  p=>{p[0].objects[0].extension='pgcrypto'},
  p=>{p[0].objects[0].classification='APP_OWNED'},
  p=>{p[0].objects[0].reviewed=true},
  p=>{p[0].decision.destructive_allowlist=['public.users']},
  p=>{p[2].objects[0].classification_reviewed=true},
  p=>{p[1].objects[0].kind='v'},
  p=>{p[0].objects[0].acl_sha256='0'.repeat(64)}
 ];
 for(const change of variations){
  const fresh=fixture();change(fresh);
  assert.throws(()=>auditOwnershipCandidates(...fresh));
 }
});
test('no missing live relation SHA is silently represented as approved',()=>{
 const a=fixture();
 const relation=a[0].objects.find(x=>x.kind==='relation');
 relation.definition_sha256='f'.repeat(64);
 assert.throws(()=>auditOwnershipCandidates(...a),/unreviewed relation full DDL/);
});
