import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assessR4IndexConstraintEvidence} from './index-constraint-evidence.mjs';
const read=(p)=>JSON.parse(readFileSync(p,'utf8'));
const fixture=()=>[
 read('docs/security/pr359-r0-staging-indexes-constraints-20261119.json'),
 read('docs/security/pr359-r4-staging-object-register-20261120.json'),
 read('docs/security/pr359-r4-live-index-constraint-check-20261120.json')
];
test('full historical index/constraint file is present, parsed and structurally reconciled',()=>{
 const r=assessR4IndexConstraintEvidence(...fixture());
 assert.equal(r.valid,true,JSON.stringify(r.errors.slice(0,6)));
 assert.deepEqual(r.counts,{INDEX:688,CONSTRAINT:1437,foreign_keys:561,invalid_indexes:0,unvalidated_constraints:0});
 assert.equal(r.sharedCount,3);
 assert.equal(r.liveDefinitionHashParity,false);
 assert.equal(r.dropAuthorized,false);
});
test('missing, invalid and duplicate objects fail closed',()=>{
 const [a,b,c]=fixture();a.objects.pop();
 assert.equal(assessR4IndexConstraintEvidence(a,b,c).valid,false);
 const [d,e,f]=fixture();d.objects.push({...d.objects[0]});
 assert.ok(assessR4IndexConstraintEvidence(d,e,f).errors.some(x=>x.startsWith('DUPLICATE_IDENTITY')));
 const [g,h,i]=fixture();g.objects[0].details.definition_sha256='fake';
 assert.ok(assessR4IndexConstraintEvidence(g,h,i).errors.some(x=>x.startsWith('INVALID_SHA256')));
});
test('never allow provider cross-schema FK to become an independent candidate',()=>{
 const [a,b,c]=fixture();
 const fk=a.objects.find(x=>x.category==='CONSTRAINT'&&x.details.references==='auth.users');
 fk.classification='APP_OWNED_CANDIDATE';
 assert.ok(assessR4IndexConstraintEvidence(a,b,c).errors.some(x=>x.startsWith('CLASSIFICATION_DRIFT')));
});
test('live metadata drift fails, without upgrading to a destructive permission',()=>{
 const [a,b,c]=fixture();c.metadata.indexes++;
 assert.ok(assessR4IndexConstraintEvidence(a,b,c).errors.includes('LIVE_COUNTS_DRIFT'));
 const [d,e,f]=fixture();e.decision.destructive_allowlist=['public.users'];
 assert.ok(assessR4IndexConstraintEvidence(d,e,f).errors.includes('UNAUTHORIZED_RELEASE_FLAG'));
});
