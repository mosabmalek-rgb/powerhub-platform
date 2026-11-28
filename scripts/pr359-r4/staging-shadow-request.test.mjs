import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {validateStagingRequest,currentGitRequestContext,REQUEST_PATH,STAGING_BRANCH_REF} from './staging-shadow-request.mjs';
import {classifyStagingRequest} from './staging-shadow-request-preflight.mjs';

const approvedParent='a'.repeat(40);
const reviewedHead='b'.repeat(40);
const context=()=>({
 ref:STAGING_BRANCH_REF,headSha:reviewedHead,
 approvedHeadSha:reviewedHead,parentCount:1,parentSha:approvedParent,
 changedFiles:[REQUEST_PATH]
});
const base=()=>JSON.parse(readFileSync(REQUEST_PATH,'utf8'));
const active=()=>({...base(),requested:true,approved_parent_sha:approvedParent});

test('committed request disabled by default; active requests need no text token',()=>{
 const req=base();
 assert.equal(Object.hasOwn(req,'approval_token'),false);
 assert.equal(typeof req.requested,'boolean');
 assert.throws(()=>validateStagingRequest({...req,requested:false},context()));
 if(!req.requested){
   assert.equal(req.approved_parent_sha,'UNSET');
   assert.deepEqual(classifyStagingRequest(req,context()),
     {requested:false,restoreExecuted:false,stagingInplaceGo:false});
 }else{
   const ctx={...context(),parentSha:req.approved_parent_sha};
   assert.equal(validateStagingRequest(req,ctx).requestValid,true);
 }
});
test('explicit request remains Staging-only, reviewed and never grants in-place cutover',()=>{
 const result=validateStagingRequest(active(),context());
 assert.equal(result.requestValid,true);
 assert.equal(result.stagingInplaceGo,false);
 assert.equal(result.sourceProject,'iyuryuhaylhisjfcrwkz');
 assert.deepEqual(classifyStagingRequest(active(),context()),
   {requested:true,restoreExecuted:false,stagingInplaceGo:false});
});
test('retired token field is rejected rather than treated as authorization',()=>{
 for(const token of ['UNSET','STAGING-SHADOW-TEST_REQUEST_001']){
   const attempt={...active(),approval_token:token};
   assert.throws(()=>validateStagingRequest(attempt,context()),/legacy approval_token/);
   assert.throws(()=>classifyStagingRequest(attempt,context()),/legacy approval_token/);
   assert.throws(()=>classifyStagingRequest({...base(),approval_token:token},context()),/legacy approval_token/);
 }
});
test('reject Production, missing or altered parent and tampered purpose/scope',()=>{
 const req=active();
 for(const [key,value] of Object.entries({
   project_ref:'vvcdiqcyhaloxesvpppc',
   format:'UNTRUSTED_REQUEST',
   approved_parent_sha:'UNSET',
   purpose:'delete Staging',
   requested:'true'
 })){
   assert.throws(()=>validateStagingRequest({...req,[key]:value},context()));
 }
 assert.throws(()=>classifyStagingRequest({...base(),requested:'false'},context()));
 assert.throws(()=>classifyStagingRequest({...base(),project_ref:'vvcdiqcyhaloxesvpppc'},context()));
 assert.throws(()=>classifyStagingRequest({...base(),purpose:'do not validate'},context()));
});
test('only a single-parent, exact-SHA, request-only activation commit is accepted',()=>{
 const req=active();
 for(const broken of [
   {parentSha:'c'.repeat(40)},
   {approvedHeadSha:'c'.repeat(40)},
   {ref:'refs/heads/main'},
   {parentCount:2},
   {changedFiles:[REQUEST_PATH,'scripts/pr359-shadow/run.sh']},
   {changedFiles:[]}
 ]) assert.throws(()=>validateStagingRequest(req,{...context(),...broken}));
 assert.equal(validateStagingRequest(req,context()).stagingInplaceGo,false);
});
test('actual Git commit ancestry and request-only changed-file parser',()=>{
 // Capture the repository request before entering a temporary Git repository.
 const request=active();
 const root=mkdtempSync(join(tmpdir(),'pr359-r4-request-git-'));
 const prior=process.cwd();
 try{
   const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',
     stdio:['ignore','pipe','pipe']}).trim();
   git('init','-q');
   git('config','user.email','r4-test@example.invalid');
   git('config','user.name','R4 Test');
   mkdirSync(join(root,'docs/security'),{recursive:true});
   writeFileSync(join(root,'README.md'),'parent\n');
   git('add','README.md');
   git('commit','-qm','reviewed parent');
   const parent=git('rev-parse','HEAD');
   writeFileSync(join(root,REQUEST_PATH),'requested=true\n');
   git('add',REQUEST_PATH);
   git('commit','-qm','reviewed activation request');
   const head=git('rev-parse','HEAD');
   process.chdir(root);
   const ctx=currentGitRequestContext({GITHUB_REF:STAGING_BRANCH_REF,
     SHADOW_APPROVED_HEAD:head});
   assert.equal(ctx.parentSha,parent);
   assert.equal(ctx.parentCount,1);
   assert.deepEqual(ctx.changedFiles,[REQUEST_PATH]);
   assert.equal(validateStagingRequest({...request,approved_parent_sha:parent},ctx).requestValid,true);
 }finally{
   process.chdir(prior);
   rmSync(root,{recursive:true,force:true});
 }
});
test('disabled request skips protected restore without permitting stale approval state',()=>{
 const req={...base(),requested:false,approved_parent_sha:'UNSET'};
 assert.deepEqual(classifyStagingRequest(req,{...context(),
   changedFiles:[REQUEST_PATH,'scripts/pr359-shadow/run.sh']}),
   {requested:false,restoreExecuted:false,stagingInplaceGo:false});
 assert.throws(()=>classifyStagingRequest({...req,approved_parent_sha:approvedParent},context()));
 assert.throws(()=>classifyStagingRequest({...req,requested:'false'},context()));
});
test('protected Environment, repo opt-in, TLS, Staging source and read-only restore survive',()=>{
 const wf=readFileSync('.github/workflows/pr359-staging-shadow.yml','utf8');
 assert.ok(wf.includes('request_preflight:'));
 assert.ok(wf.includes("requested: "+'$'+"{{ steps.classify.outputs.requested }}"));
 assert.ok(wf.includes('staging-shadow-request-preflight.mjs >> "$GITHUB_OUTPUT"'));
 const restore=wf.slice(wf.indexOf('\n  real-staging-ledger-restore:'));
 for(const fragment of [
   'needs: request_preflight',
   "needs.request_preflight.outputs.requested == 'true'",
   "vars.PR359_ENABLE_STAGING_DOCKER_SHADOW == 'true'",
   'name: pr359-staging-shadow',
   'secrets.PR359_STAGING_SHADOW_SOURCE_DB_URL',
   'staging-shadow-request.mjs',
   'guard.mjs',
   'run.sh staging-restore',
   'SHADOW_SOURCE_KIND: staging'
 ]) assert.ok(restore.includes(fragment),fragment);
 assert.ok(restore.includes('environment:\n      name: pr359-staging-shadow'));
});
