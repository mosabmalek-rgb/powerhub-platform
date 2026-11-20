import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assessR4ObjectRegister} from './object-register.mjs';
const fixture=()=>JSON.parse(readFileSync('docs/security/pr359-r4-staging-object-register-20261120.json','utf8'));
test('978 R0 identities may be audited but not destroyed',()=>{
 const r=assessR4ObjectRegister(fixture());
 assert.equal(r.observed,true,JSON.stringify(r.blockers.slice(0,6)));
 assert.equal(r.unresolvedClassification,978);
 assert.equal(r.dropAuthorized,false);assert.equal(r.stagingInplaceGo,false);
});
test('duplicate or missing identity is fail closed',()=>{
 const d=fixture();d.objects[1].id=d.objects[0].id;
 assert.equal(assessR4ObjectRegister(d).observed,false);
 const m=fixture();m.objects.pop();
 assert.ok(assessR4ObjectRegister(m).blockers.includes('OBJECT_COUNT_DRIFT'));
});
test('provider object, missing hash and unreviewed index evidence block',()=>{
 const a=fixture();a.objects[0].owner='supabase_admin';
 assert.ok(assessR4ObjectRegister(a).blockers.some(e=>e.startsWith('PROVIDER_OR_OWNER')));
 const b=fixture();b.objects.find(x=>x.kind==='function').definition_sha256=null;
 assert.ok(assessR4ObjectRegister(b).blockers.some(e=>e.startsWith('FUNCTION_SHA')));
 const c=fixture();c.source_evidence[2].parseable=true;
 assert.ok(assessR4ObjectRegister(c).blockers.includes('UNREVIEWED_INDEX_CONSTRAINT_EVIDENCE'));
});
test('cannot smuggle authorization via candidate classification or drop list',()=>{
 const a=fixture();a.decision.destructive_allowlist=['public.users'];
 assert.ok(assessR4ObjectRegister(a).blockers.includes('UNAUTHORIZED_GO_OR_DROP_LIST'));
 const b=fixture();b.objects[0].reviewed=true;
 assert.ok(assessR4ObjectRegister(b).blockers.some(e=>e.startsWith('UNATTESTED_CLASSIFICATION')));
});
