import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {REQUEST_PATH,currentGitRequestContext,validateStagingRequest} from './staging-shadow-request.mjs';

// Classify without opening a protected Environment or receiving source secrets.
// Inactive requests must be validly disabled; an active request must pass the
// ORIGINAL strict Git topology/parent SHA/branch/purpose validation.
export function classifyStagingRequest(request,context){
 assert.ok(request&&typeof request==='object'&&!Array.isArray(request),'request JSON object required');
 assert.equal(request.format,'PR359_STAGING_SHADOW_MANUAL_REQUEST_V1');
 assert.equal(request.project_ref,'iyuryuhaylhisjfcrwkz','never target Production');
 assert.equal(request.purpose,
  'two isolated read-only source logical exports and Staging legacy-ledger restorations');
 assert.equal(typeof request.requested,'boolean','requested must be boolean');
 assert.equal(Object.hasOwn(request,'approval_token'),false,
   'legacy approval_token field is unsupported');
 if(request.requested===false){
   assert.equal(request.approved_parent_sha,'UNSET','inactive request parent must be unset');
   return {requested:false,restoreExecuted:false,stagingInplaceGo:false};
 }
 const accepted=validateStagingRequest(request,context);
 assert.equal(accepted.requestValid,true);
 assert.equal(accepted.stagingInplaceGo,false);
 return {requested:true,restoreExecuted:false,stagingInplaceGo:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 assert.equal(process.argv.length,2,'No CLI credentials or URL accepted');
 const data=JSON.parse(readFileSync(REQUEST_PATH,'utf8'));
 const result=classifyStagingRequest(data,currentGitRequestContext());
 // Only a literal boolean is written to GITHUB_OUTPUT; no source values.
 console.log('requested='+result.requested);
 if(result.requested){
   console.error('PR359_STAGING_REQUEST_VALIDATED_PENDING_PROTECTED_ENVIRONMENT');
 }else{
   console.error('PR359_STAGING_REQUEST_DISABLED_RESTORE_SKIPPED');
 }
 console.error('PR359_STAGING_INPLACE_GO=FALSE');
}
