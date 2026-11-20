import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {validateStagingRequest,currentGitRequestContext,REQUEST_PATH,STAGING_BRANCH_REF} from './staging-shadow-request.mjs';
const approvedParent='a'.repeat(40);
const reviewedHead='b'.repeat(40);
const context=()=>({
 ref:STAGING_BRANCH_REF,headSha:reviewedHead,
 approvedHeadSha:reviewedHead,parentCount:1,parentSha:approvedParent,
 changedFiles:[REQUEST_PATH]
});

const base=()=>JSON.parse(readFileSync(REQUEST_PATH,'utf8'));
test('committed request is either disabled or a strictly scoped reviewed activation',()=>{
 const req=base();
 // The protected request is intentionally true for a one-file activation
 // commit. Smoke tests must verify BOTH legal states rather than demanding
 // false on the activation commit. The real Git topology is separately enforced
 // by the protected workflow and tested in the temporary Git fixture below.
 const inactive={...req,requested:false,approval_token:'UNSET',approved_parent_sha:'UNSET'};
 assert.throws(()=>validateStagingRequest(inactive,context()),
   'disabled requests must never authorize a restore');
 if(req.requested===false){
  assert.equal(req.approval_token,'UNSET');
  assert.equal(req.approved_parent_sha,'UNSET');
 }else{
  assert.equal(req.requested,true,'request must be an explicit boolean');
  assert.match(req.approved_parent_sha,/^[a-f0-9]{40}$/);
  assert.match(req.approval_token,/^STAGING-SHADOW-[A-Z0-9_-]{10,64}$/);
  const pinned={...context(),parentSha:req.approved_parent_sha};
  const accepted=validateStagingRequest(req,pinned);
  assert.equal(accepted.requestValid,true);
  assert.equal(accepted.stagingInplaceGo,false);
  assert.throws(()=>validateStagingRequest(req,{...pinned,parentSha:'c'.repeat(40)}),
    'wrong reviewed parent must fail');
  assert.throws(()=>validateStagingRequest(req,{...pinned,changedFiles:[REQUEST_PATH,'scripts/pr359-shadow/run.sh']}),
    'activation with code changes must fail');
 }
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

test('actual Git commit topology and changed-files parser isolates a request-only commit',()=>{
 const request=base(); // Capture source fixture before entering the temp Git repository.
 const root=mkdtempSync(join(tmpdir(),'pr359-r4-request-git-'));
 const original=process.cwd();
 try{
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',
   stdio:['ignore','pipe','pipe']}).trim();
  git('init','-q');
  git('config','user.email','r4-test@example.invalid');
  git('config','user.name','R4 Test');
  mkdirSync(join(root,'docs/security'),{recursive:true});
  writeFileSync(join(root,'README.md'),'parent\n');
  git('add','README.md');git('commit','-qm','reviewed parent');
  const parent=git('rev-parse','HEAD');
  writeFileSync(join(root,REQUEST_PATH),'requested=true\n');
  git('add',REQUEST_PATH);git('commit','-qm','reviewed activation request');
  const head=git('rev-parse','HEAD');
  process.chdir(root);
  const ctx=currentGitRequestContext({
   GITHUB_REF:STAGING_BRANCH_REF,SHADOW_APPROVED_HEAD:head
  });
  assert.equal(ctx.parentSha,parent);
  assert.equal(ctx.parentCount,1);
  assert.deepEqual(ctx.changedFiles,[REQUEST_PATH]);
  request.requested=true;
  request.approval_token='STAGING-SHADOW-TEST_REQUEST_001';
  request.approved_parent_sha=parent;
  assert.equal(validateStagingRequest(request,ctx).requestValid,true);
 }finally{process.chdir(original);rmSync(root,{recursive:true,force:true});}
});
