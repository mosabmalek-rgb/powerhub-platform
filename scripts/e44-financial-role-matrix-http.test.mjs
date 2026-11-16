import {test} from 'node:test';
import assert from 'node:assert/strict';
import {config,run,checkNoFinancialCapability} from './e44-financial-role-matrix-http.mjs';
import {ROUTES} from './d36-financial-tenant-isolation-http.mjs';
const cfg={
 preview:'https://powerhub-platform-i290elksh-mosabmalek-rgb.vercel.app',
 tenant:1,site:1,siblingSite:9000000000099,foreignSite:13,period:'2026-11',phase:'before',
 accountantToken:'synthetic-accountant-session-never-a-real-bearer',
 deniedToken:'synthetic-denied-session-never-a-real-bearer',
 revocableToken:'synthetic-revocable-session-never-a-real-bearer',
 accountantDevice:'11111111-1111-4111-8111-111111111111',
 deniedDevice:'22222222-2222-4222-8222-222222222222',
 revocableDevice:'33333333-3333-4333-8333-333333333333',
};
const wrap=v=>JSON.stringify({result:{data:{json:v}}});
const deny=code=>JSON.stringify({error:{json:{data:{code}}}});
const response=(status,body)=>({status,text:async()=>body});
const ok=route=>({tenantId:1,siteId:1,accountingCertification:'NOT_CERTIFIED',
 ...(route==='accrualCloseReadiness'?{period:'2026-11',isFinalFinancialStatement:false,
  canAutomaticallyLock:false,needsIndependentReviewer:true,blockers:[]}:route==='financialGLTrialBalance'
  ?{throughPeriod:'2026-11',isFinalBalanceSheet:false,isMathematicallyBalanced:true,accounts:[]}
  :{period:'2026-11',siteScope:'SITE_ONLY',isFinalBalanceSheet:false,isFinalProfit:false,
    isCompleteAccrualStatement:false,accounts:[]})});
function mock(phase='before',mistake=null){
 const requests=[];
 return {requests,request:async(url,opt)=>{
   requests.push({url,method:opt.method,auth:opt.headers?.authorization});
   assert.equal(opt.method,'GET');assert.equal(opt.redirect,'manual');
   if(url.endsWith('/api/ready'))return response(200,JSON.stringify({status:'ok',checks:{
     application:true,supabaseConfig:true,supabaseConnectivity:mistake!=='health'}}));
   const route=url.match(/reports\.([^?]+)\?/)[1];
   assert.ok(ROUTES.includes(route));
   const siteId=JSON.parse(decodeURIComponent(url.split('input=')[1])).json.siteId;
   if(!opt.headers?.authorization) return response(mistake==='anonymous'?200:401,
     mistake==='anonymous'?wrap(ok(route)):deny('UNAUTHORIZED'));
   if(opt.headers.authorization==='Bearer '+cfg.deniedToken)
     return response(mistake==='leaked-denied'?200:403,
       mistake==='leaked-denied'?wrap(ok(route)):deny('FORBIDDEN'));
   if(opt.headers.authorization==='Bearer '+cfg.revocableToken)
     return response(mistake==='revoke-failed'?200:phase==='before'?200:403,
       mistake==='revoke-failed'||phase==='before'?wrap(ok(route)):deny('FORBIDDEN'));
   if(siteId!==cfg.site)
     return response(mistake==='leaked-site'?200:403,
       mistake==='leaked-site'?wrap(ok(route)):deny('FORBIDDEN'));
   return response(200,wrap(mistake==='wrong-certified'
     ?{...ok(route),accountingCertification:'CERTIFIED'}:ok(route)));
 }};
}
test('refuses unsafe URLs, shared identities or devices, invalid scopes and phase',()=>{
 assert.equal(config(cfg).siblingSite,cfg.siblingSite);
 const errors=[{phase:'invalid'},{preview:'http://powerhub-platform-i290elksh-mosabmalek-rgb.vercel.app'},
  {preview:'https://evil.example.com'}, {siblingSite:cfg.site}, {siblingSite:cfg.foreignSite},
  {deniedToken:''},{revocableToken:cfg.accountantToken},
  {deniedDevice:'not-a-device'},{revocableDevice:cfg.accountantDevice}];
 for(const patch of errors)assert.throws(()=>config({...cfg,...patch}),/^(?:Error: )?(?:D36|E44)_/);
});
test('read-only before phase: authorized scoped accountant, denied user and anonymous',async()=>{
 const x=mock('before');const got=await run(cfg,{request:x.request});
 assert.deepEqual({status:got.status,phase:got.phase,checks:got.checks,readiness:got.readiness,
   writes:got.financialWrites,cert:got.accountingCertification},
   {status:'PASS',phase:'before',checks:14,readiness:1,writes:0,cert:'NOT_CERTIFIED'});
 assert.equal(x.requests.length,15);
 assert.equal(x.requests.filter(r=>r.auth===undefined).length,2);
 assert.equal(x.requests.filter(r=>r.url.includes('input=')).length,14);
 assert.equal(JSON.stringify(got).includes('synthetic-'),false);
 assert.equal(got.activeSessionPermissionChangeProven,false);
});
test('after phase requires forbidden response without self-mutating permissions',async()=>{
 const x=mock('after');const got=await run({...cfg,phase:'after'},{request:x.request});
 assert.equal(got.status,'PASS');assert.equal(got.checks,14);assert.equal(x.requests.length,15);
 assert.equal(got.activeSessionPermissionChangeProven,false);
});
test('rejects cross-site leak, false certification, false revocation and anonymous bypass',async()=>{
 for(const mistake of ['health','wrong-certified','leaked-site','leaked-denied','anonymous']){
  const x=mock('before',mistake);
  await assert.rejects(run(cfg,{request:x.request}),/(?:D36|E44)_/);
 }
 const x=mock('after','revoke-failed');
 await assert.rejects(run({...cfg,phase:'after'},{request:x.request}),
   /E44_NO_CAPABILITY_NOT_FORBIDDEN_200/);
});
test('denied payloads fail closed, and transport exceptions do not echo credentials',async()=>{
 assert.doesNotThrow(()=>checkNoFinancialCapability(403,deny('FORBIDDEN')));
 assert.throws(()=>checkNoFinancialCapability(404,deny('NOT_FOUND')),
   /E44_NO_CAPABILITY_NOT_FORBIDDEN_404/);
 assert.throws(()=>checkNoFinancialCapability(403,deny('NOT_FOUND')),
   /E44_NO_CAPABILITY_LEAK_OR_CODE/);
 assert.throws(()=>checkNoFinancialCapability(403,
   JSON.stringify({error:{json:{data:{code:'FORBIDDEN'}}},accounts:[1]})),
   /E44_NO_CAPABILITY_LEAK_OR_CODE/);
 await assert.rejects(run(cfg,{request:async()=>{throw Error('LEAK '+cfg.accountantToken)}}),e=>{
  assert.equal(e.message,'E44_TRANSPORT_OR_TIMEOUT');return true;
 });
});
