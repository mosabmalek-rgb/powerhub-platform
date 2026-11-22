import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

export const REQUEST_PATH='docs/security/pr359-r4-staging-shadow-run-request.json';
export const STAGING_BRANCH_REF='refs/heads/feat/auth-local-first-single-pr';
const shaPattern=/^[a-f0-9]{40}$/;

export function validateStagingRequest(value,context){
 // JSON request is not a credential or an authorization by itself.
 // The GitHub protected environment must still approve the run.
 assert.ok(context&&typeof context==='object','git run context required');
 assert.equal(context.ref,STAGING_BRANCH_REF,'only the approved PR branch is eligible');
 assert.ok(shaPattern.test(context.headSha||''),'invalid checked-out HEAD SHA');
 assert.equal(context.approvedHeadSha,context.headSha,'GitHub SHA mismatch');
 assert.equal(context.parentCount,1,'request commit must have exactly one parent');
 assert.ok(shaPattern.test(context.parentSha||''),'invalid request parent SHA');
 assert.deepEqual(context.changedFiles,[REQUEST_PATH],
  'request activation commit must change only the approved run-request file');

 assert.equal(value?.format,'PR359_STAGING_SHADOW_MANUAL_REQUEST_V1');
 assert.equal(value?.project_ref,'iyuryuhaylhisjfcrwkz');
 assert.equal(value?.purpose,'two isolated read-only source logical exports and Staging legacy-ledger restorations');
 assert.equal(value?.requested,true,'Staging shadow execution must be explicitly requested');
 // A separate reviewer-issued text token is not a security approval.
 // Real authorization is the explicit request-only commit, reviewed parent,
 // repo opt-in, and GitHub protected Environment with its native approval.
 assert.equal(Object.hasOwn(value,'approval_token'),false,
   'legacy approval_token field is unsupported; use GitHub Environment approval');
 assert.ok(shaPattern.test(value.approved_parent_sha||''),'missing pinned reviewed parent SHA');
 assert.equal(value.approved_parent_sha,context.parentSha,
  'the request must identify the exact reviewed preceding commit');
 // Request never confers in-place authorization, even when enabled.
 return {requestValid:true,stagingInplaceGo:false,sourceProject:value.project_ref};
}
function gitValue(args) {
 return execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
}
export function currentGitRequestContext(env=process.env) {
 const parents=gitValue(['rev-list','--parents','-n','1','HEAD']).split(/\s+/);
 const changed=gitValue(['diff-tree','--no-commit-id','--name-only','-r','HEAD'])
  .split(/\r?\n/).filter(Boolean);
 return {
  ref:env.GITHUB_REF,headSha:gitValue(['rev-parse','HEAD']),
  parentSha:parents[1],parentCount:parents.length-1,
  changedFiles:changed,approvedHeadSha:env.SHADOW_APPROVED_HEAD
 };
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 assert.equal(process.argv.length,2,'No runtime URL/credentials accepted');
 const result=validateStagingRequest(
  JSON.parse(readFileSync(REQUEST_PATH,'utf8')),currentGitRequestContext());
 assert.equal(process.env.SHADOW_SOURCE_KIND,'staging');
 assert.equal(process.env.SHADOW_CONFIRM_STAGING_TEST_DATA,'YES_STAGING_TEST_DATA');
 console.log('PR359_STAGING_SHADOW_EXPLICIT_REQUEST_PASS');
 console.log('PR359_STAGING_INPLACE_GO=FALSE');
}
