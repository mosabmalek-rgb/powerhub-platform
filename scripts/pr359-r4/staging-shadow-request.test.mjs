import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateStagingRequest,REQUEST_PATH} from './staging-shadow-request.mjs';

const base=()=>JSON.parse(readFileSync(REQUEST_PATH,'utf8'));
test('default committed Staging shadow run request is disabled',()=>{
 assert.equal(base().requested,false);
 assert.throws(()=>validateStagingRequest(base()));
});
test('explicit allowed request cannot authorize rebaseline',()=>{
 const req=base();req.requested=true;req.approval_token='STAGING-SHADOW-TEST_REQUEST_001';
 const result=validateStagingRequest(req);
 assert.equal(result.requestValid,true);
 assert.equal(result.stagingInplaceGo,false);
 assert.equal(result.sourceProject,'iyuryuhaylhisjfcrwkz');
});
test('reject wrong project, weak token and tampered scope',()=>{
 const a=base();a.requested=true;a.approval_token='STAGING-SHADOW-TEST_REQUEST_001';
 for(const [key,value] of Object.entries({
  project_ref:'vvcdiqcyhaloxesvpppc',
  format:'UNTRUSTED_REQUEST',
  approval_token:'UNSET',
  purpose:'delete Staging'
 })){
  assert.throws(()=>validateStagingRequest({...a,[key]:value}));
 }
});
