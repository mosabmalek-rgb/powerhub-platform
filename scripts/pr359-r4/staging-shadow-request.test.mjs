import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateStagingRequest,REQUEST_PATH,STAGING_BRANCH_REF} from './staging-shadow-request.mjs';
const approvedParent='a'.repeat(40);
const reviewedHead='b'.repeat(40);
const context=()=>({
 ref:STAGING_BRANCH_REF,headSha:reviewedHead,
 approvedHeadSha:reviewedHead,parentCount:1,parentSha:approvedParent,
 changedFiles:[REQUEST_PATH]
});

const base=()=>JSON.parse(readFileSync(REQUEST_PATH,'utf8'));
test('default committed Staging shadow run request is disabled',()=>{
 assert.equal(base().requested,false);
 assert.throws(()=>validateStagingRequest(base(),context()));
});
test('explicit allowed request cannot authorize rebaseline',()=>{
 const req=base();req.requested=true;req.approval_token='STAGING-SHADOW-TEST_REQUEST_001';
 req.approved_parent_sha=approvedParent;
 const result=validateStagingRequest(req,context());
 assert.equal(result.requestValid,true);
 assert.equal(result.stagingInplaceGo,false);
 assert.equal(result.sourceProject,'iyuryuhaylhisjfcrwkz');
});
test('reject wrong project, weak token and tampered scope',()=>{
 const a=base();a.requested=true;a.approval_token='STAGING-SHADOW-TEST_REQUEST_001';
 a.approved_parent_sha=approvedParent;
 for(const [key,value] of Object.entries({
  project_ref:'vvcdiqcyhaloxesvpppc',
  format:'UNTRUSTED_REQUEST',
  approval_token:'UNSET',
  approved_parent_sha:'UNSET',
  purpose:'delete Staging'
 })){
  assert.throws(()=>validateStagingRequest({...a,[key]:value},context()));
 }
});

test('request is pinned to the reviewed parent, exact SHA and request-only commit',()=>{
 const a=base(); a.requested=true;
 a.approval_token='STAGING-SHADOW-TEST_REQUEST_001';
 a.approved_parent_sha=approvedParent;
 for(const broken of [
  {parentSha:'c'.repeat(40)},
  {approvedHeadSha:'c'.repeat(40)},
  {ref:'refs/heads/main'},
  {parentCount:2},
  {changedFiles:[REQUEST_PATH,'scripts/pr359-shadow/run.sh']},
  {changedFiles:[]}
 ]) assert.throws(()=>validateStagingRequest(a,{...context(),...broken}));
 assert.equal(validateStagingRequest(a,context()).stagingInplaceGo,false);
});
