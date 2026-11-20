import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

export const REQUEST_PATH='docs/security/pr359-r4-staging-shadow-run-request.json';
export function validateStagingRequest(value){
 assert.equal(value?.format,'PR359_STAGING_SHADOW_MANUAL_REQUEST_V1');
 assert.equal(value?.project_ref,'iyuryuhaylhisjfcrwkz');
 assert.equal(value?.purpose,'two isolated read-only source logical exports and Staging legacy-ledger restorations');
 assert.equal(value?.requested,true,'Staging shadow execution must be explicitly requested');
 assert.ok(typeof value.approval_token==='string' &&
    /^STAGING-SHADOW-[A-Z0-9_-]{10,64}$/.test(value.approval_token),
    'Staging shadow approval token must be supplied by an authorized reviewer');
 // Request never confers in-place authorization, even when enabled.
 return {requestValid:true,stagingInplaceGo:false,sourceProject:value.project_ref};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 assert.equal(process.argv.length,2,'No runtime URL/credentials accepted');
 const result=validateStagingRequest(JSON.parse(readFileSync(REQUEST_PATH,'utf8')));
 assert.equal(process.env.SHADOW_SOURCE_KIND,'staging');
 assert.equal(process.env.SHADOW_CONFIRM_STAGING_TEST_DATA,'YES_STAGING_TEST_DATA');
 console.log('PR359_STAGING_SHADOW_EXPLICIT_REQUEST_PASS');
 console.log('PR359_STAGING_INPLACE_GO=FALSE');
}
