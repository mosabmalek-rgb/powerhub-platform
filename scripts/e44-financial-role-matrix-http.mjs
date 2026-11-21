/**
 * E44: real HTTPS, device-bound, read-only non-owner financial report role matrix.
 * No login, user creation, role mutation or device-lock bypass is performed.
 * Before/after revocation MUST be run with the same legitimate active identity,
 * with permission changes done independently by an authorized staging admin.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { config as d36Config, ROUTES, checkOwn, checkForeign, checkAnonymous } from './d36-financial-tenant-isolation-http.mjs';

const uuidRe = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const bodyKeys = ['accounts', 'incomeStatement', 'balanceSheet', 'sourceIntegrity', 'subledgerBalances'];

function fail(code) { throw new Error('E44_' + code); }
function strictJson(body) {
  try {
    const v=JSON.parse(body);
    if (v && typeof v==='object' && !Array.isArray(v)) return v;
  } catch {}
  fail('INVALID_TRPC_JSON');
}

export function checkNoFinancialCapability(status,body) {
  if(status!==403) fail('NO_CAPABILITY_NOT_FORBIDDEN_' + status);
  const parsed=strictJson(body);
  if(parsed.result || parsed?.error?.json?.data?.code!=='FORBIDDEN' ||
     bodyKeys.some(key=>body.includes('"'+key+'"'))) fail('NO_CAPABILITY_LEAK_OR_CODE');
}

export function config(input) {
  if (input?.phase!=='before' && input?.phase!=='after') fail('INVALID_PHASE');
  const a=d36Config({preview:input.preview,token:input.accountantToken,device:input.accountantDevice,
     tenant:input.tenant,site:input.site,foreignSite:input.foreignSite,period:input.period});
  const ids=[a.site,Number(input.siblingSite),a.foreignSite];
  if(!ids.every(id=>Number.isSafeInteger(id)&&id>0)||new Set(ids).size!==3)
    fail('INVALID_SAME_TENANT_BRANCH_FIXTURE');
  // Three separate users and device leases: no token/device reuse between roles.
  const tokens=[a.token,input.deniedToken,input.revocableToken];
  const devices=[a.device,input.deniedDevice,input.revocableDevice];
  if(tokens.some(t=>typeof t!=='string'||t.length<20)||new Set(tokens).size!==3)
    fail('MISSING_OR_SHARED_AUTH_IDENTITY');
  if(devices.some(d=>typeof d!=='string'||!uuidRe.test(d))||new Set(devices).size!==3)
    fail('MISSING_OR_SHARED_BOUND_DEVICE');
  return {...a,siblingSite:ids[1],phase:input.phase,
    accountant:{token:a.token,device:a.device},
    denied:{token:input.deniedToken,device:input.deniedDevice},
    revocable:{token:input.revocableToken,device:input.revocableDevice}};
}

/** Guard transport errors so token-bearing provider errors never reach stdout. */
async function read(request,url,opts) {
  let result;
  try {
    result=await request(url,{...opts,method:'GET',redirect:'manual',signal:AbortSignal.timeout(8000)});
    if (!Number.isInteger(result.status)) fail('NO_HTTP_STATUS');
    return {status:result.status,body:await result.text()};
  } catch { fail('TRANSPORT_OR_TIMEOUT'); }
}
function urlFor(c,route,siteId) {
  return c.origin+'/api/trpc/powerhub.reports.'+route+'?input='+
    encodeURIComponent(JSON.stringify({json:{siteId,period:c.period}}));
}
function authHeaders(person) {
  return {authorization:'Bearer '+person.token,'x-powerhub-device-id':person.device,
    accept:'application/json','cache-control':'no-store'};
}

export async function run(input,{request=fetch}={}) {
  const c=config(input);
  const ready=await read(request,c.origin+'/api/ready',{headers:{accept:'application/json'}});
  const health=strictJson(ready.body);
  if(ready.status!==200 || health.status!=='ok' ||
     health.checks?.application!==true || health.checks?.supabaseConfig!==true ||
     health.checks?.supabaseConnectivity!==true) fail('PREVIEW_NOT_READY');
  let checks=0;
  for(const route of ROUTES) {
    // The branch-restricted accountant can see ONLY the assigned branch.
    const own=await read(request,urlFor(c,route,c.site),{headers:authHeaders(c.accountant)});
    checkOwn(own.status,own.body,route,c);checks++;
    const sibling=await read(request,urlFor(c,route,c.siblingSite),{headers:authHeaders(c.accountant)});
    checkForeign(sibling.status,sibling.body);checks++;
    const foreign=await read(request,urlFor(c,route,c.foreignSite),{headers:authHeaders(c.accountant)});
    checkForeign(foreign.status,foreign.body);checks++;
    // A distinct authenticated identity lacking viewFinancialReports must fail.
    const denied=await read(request,urlFor(c,route,c.site),{headers:authHeaders(c.denied)});
    checkNoFinancialCapability(denied.status,denied.body);checks++;
  }
  // Two independent invocations around an admin-authorized permission change.
  // No mutation is made by this test; caller must ensure same identity/device.
  const revoked=await read(request,urlFor(c,ROUTES[0],c.site),{headers:authHeaders(c.revocable)});
  if(c.phase==='before')checkOwn(revoked.status,revoked.body,ROUTES[0],c);
  else checkNoFinancialCapability(revoked.status,revoked.body);
  checks++;
  const anonymous=await read(request,urlFor(c,ROUTES[0],c.site),{headers:{accept:'application/json'}});
  checkAnonymous(anonymous.status,anonymous.body);checks++;
  return {
    status:'PASS',scope:'E44_AUTHENTICATED_NONOWNER_FINANCE_ROLE_MATRIX',
    phase:c.phase,checks,readiness:1,financialWrites:0,
    accountingCertification:'NOT_CERTIFIED',
    // The phase alone cannot prove the exact same browser session across invocations.
    activeSessionPermissionChangeProven:false,
  };
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const result=await run({
      preview:process.env.POWERHUB_E44_PREVIEW_URL,tenant:process.env.POWERHUB_E44_TENANT_ID,
      site:process.env.POWERHUB_E44_SITE_ID,
      siblingSite:process.env.POWERHUB_E44_SIBLING_SITE_ID,
      foreignSite:process.env.POWERHUB_E44_FOREIGN_SITE_ID,
      period:process.env.POWERHUB_E44_PERIOD,phase:process.env.POWERHUB_E44_PHASE,
      accountantToken:process.env.POWERHUB_E44_ACCOUNTANT_TOKEN,
      accountantDevice:process.env.POWERHUB_E44_ACCOUNTANT_DEVICE_ID,
      deniedToken:process.env.POWERHUB_E44_NO_REPORT_TOKEN,
      deniedDevice:process.env.POWERHUB_E44_NO_REPORT_DEVICE_ID,
      revocableToken:process.env.POWERHUB_E44_REVOCABLE_TOKEN,
      revocableDevice:process.env.POWERHUB_E44_REVOCABLE_DEVICE_ID,
    });
    console.log(JSON.stringify(result));
  } catch(e) {
    // Only constant codes are printed; never print raw transport errors or URLs.
    const code= e instanceof Error && /^(?:D36|E44)_[A-Z0-9_]+$/.test(e.message)
      ? e.message : 'E44_NOT_ACCEPTED';
    console.error(JSON.stringify({status:'NOT_ACCEPTED',code}));process.exitCode=1;
  }
}
